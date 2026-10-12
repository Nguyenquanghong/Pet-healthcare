import { createHmac } from 'node:crypto';
import { createClient } from 'redis';

export type Bucket={identity:string;limit:number;windowMs:number};
export type Decision={allowed:boolean;remaining:number;retryMs:number;limit:number};
// Check all dimensions before incrementing any. Redis TTL determines the fixed
// window on its own clock; auth identity and IP are HMACed before leaving Core.
const SCRIPT=`
local remaining=2147483647
local denied=0
local retry=0
local bound=2147483647
for i,key in ipairs(KEYS) do
  local lim=tonumber(ARGV[2*i-1])
  local count=tonumber(redis.call('GET',key) or '0')
  local ttl=redis.call('PTTL',key)
  if count>=lim then denied=1;retry=math.max(retry,ttl) end
  remaining=math.min(remaining,math.max(0,lim-count-1))
  bound=math.min(bound,lim)
end
if denied==1 then return {0,0,math.max(1,retry),bound} end
for i,key in ipairs(KEYS) do
  local n=redis.call('INCR',key)
  if n==1 then redis.call('PEXPIRE',key,ARGV[2*i]) end
end
return {1,remaining,0,bound}`;

export class SharedLimiter {
  readonly client;
  private connecting:Promise<unknown>|undefined;
  private closed=false;
  private retryAt=0;
  readonly stats={shared:0,degraded:0,rejected:0};
  private fallback=new Map<string,{count:number;expires:number}>();
  constructor(url:string,private readonly keySecret:string,private readonly namespace:string,readonly timeoutMs=350){
    let parsed:URL;try{parsed=new URL(url);}catch{throw new Error('INVALID_REDIS_CONFIGURATION');}
    if(!['redis:','rediss:'].includes(parsed.protocol)||!/^[-a-zA-Z0-9.]{1,100}$/.test(namespace)||keySecret.length<32)throw new Error('INVALID_REDIS_CONFIGURATION');
    this.client=createClient({url,disableOfflineQueue:true,commandsQueueMaxLength:256,socket:{connectTimeout:timeoutMs,reconnectStrategy:false}});
    this.client.on('error',()=>{}); // Fixed codes/metrics only; never log URL/error.
  }
  private async ready(){
    if(this.closed)throw new Error('LIMITER_CLOSED');
    if(this.client.isReady)return;
    if(Date.now()<this.retryAt)throw new Error('REDIS_UNAVAILABLE');
    if(!this.connecting){this.connecting=this.client.connect().catch(()=>{this.retryAt=Date.now()+500;throw new Error('REDIS_UNAVAILABLE');}).finally(()=>{this.connecting=undefined;});}
    await this.connecting;
    if(!this.client.isReady)throw new Error('REDIS_UNAVAILABLE');
  }
  private keys(group:string,buckets:Bucket[]){
    return buckets.map(b=>`${this.namespace}:{${group}}:${createHmac('sha256',this.keySecret).update(b.identity).digest('hex')}`);
  }
  async spend(group:string,buckets:Bucket[]):Promise<Decision>{
    if(!buckets.length||buckets.some(b=>b.limit<1||b.windowMs<1))throw new Error('INVALID_LIMIT_POLICY');
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const work=(async()=>{await this.ready();return await this.client.eval(SCRIPT,{keys:this.keys(group,buckets),arguments:buckets.flatMap(b=>[String(b.limit),String(b.windowMs)])});})();
      const result=await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{if(this.client.isOpen)this.client.destroy();this.retryAt=Date.now()+500;reject(new Error('REDIS_TIMEOUT'));},this.timeoutMs);})]) as number[];
      this.stats.shared++;if(!result[0])this.stats.rejected++;
      return{allowed:result[0]===1,remaining:result[1]!,retryMs:result[2]!,limit:result[3]!};
    }catch{throw new Error('REDIS_UNAVAILABLE');}finally{if(timer)clearTimeout(timer);}
  }
  localRead(group:string,buckets:Bucket[]):Decision{
    this.stats.degraded++;const now=Date.now();
    for(const [key,v]of this.fallback)if(v.expires<=now)this.fallback.delete(key);
    const keys=this.keys(group,buckets);
    if(keys.some(k=>!this.fallback.has(k))&&this.fallback.size+keys.length>4096)return{allowed:false,remaining:0,retryMs:1000,limit:0};
    let remaining=Infinity,limit=Infinity,retryMs=0;
    for(let i=0;i<keys.length;i++){const b=buckets[i]!,v=this.fallback.get(keys[i]!);limit=Math.min(limit,b.limit);remaining=Math.min(remaining,Math.max(0,b.limit-(v?.count??0)-1));if(v&&v.count>=b.limit)retryMs=Math.max(retryMs,v.expires-now);}
    if(retryMs){this.stats.rejected++;return{allowed:false,remaining:0,retryMs,limit};}
    keys.forEach((k,i)=>{const b=buckets[i]!,v=this.fallback.get(k)??{count:0,expires:now+b.windowMs};v.count++;this.fallback.set(k,v);});
    return{allowed:true,remaining,retryMs:0,limit};
  }
  async ping(){try{await this.spend('health',[{identity:'probe',limit:1000000,windowMs:1000}]);return true;}catch{return false;}}
  close(){this.closed=true;this.fallback.clear();if(this.client.isOpen)this.client.destroy();}
}
