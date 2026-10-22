import {createHmac,timingSafeEqual} from 'node:crypto';
import type {Actor} from './domain/auth.js';
import {roles} from './domain/auth.js';
import {BusinessError} from './domain/error.js';
import type {Prisma} from './generated/client/index.js';
import {readProjectionEnabled} from './readProjection.js';
export type ReadVersions=Record<string,number>;
const invalid=()=>Object.assign(new BusinessError(422,'Invalid or expired Clinic read token.'),{code:'CLINIC_READ_TOKEN_INVALID'});
function versions(value:unknown):value is ReadVersions{return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length<=16&&Object.entries(value).every(([id,v])=>id.length>0&&id.length<=200&&Number.isInteger(v)&&Number(v)>0&&Number(v)<=2147483647);}
export async function committedVersions(tx:Prisma.TransactionClient,id?:string|null):Promise<ReadVersions>{
  if(!id||!readProjectionEnabled())return {};
  const r=await tx.clinicReadRevision.findUnique({where:{kind_aggregateId:{kind:'appointment',aggregateId:id}}});
  if(!r)throw new Error('READ_REVISION_MISSING');return {[id]:r.version};
}
export class ReadTokens{
  constructor(private readonly secret:string,private readonly now=()=>Date.now()){
    if(Buffer.byteLength(secret)<32||Buffer.byteLength(secret)>512)throw new Error('CLINIC_READ_TOKEN_SECRET_REQUIRED');
  }
  private mac(s:string){return createHmac('sha256',this.secret).update(s).digest();}
  issue(actor:Actor,values:ReadVersions){
    if(!versions(values))throw invalid();
    const iat=Math.floor(this.now()/1000),payload={v:1,actorId:actor.sub,role:actor.role,scope:'appointments',versions:values,iat,exp:iat+600};
    const body=Buffer.from(JSON.stringify(payload)).toString('base64url'),token=body+'.'+this.mac(body).toString('base64url');
    if(token.length>4096)throw invalid();return token;
  }
  verify(header:unknown,actor:Actor):ReadVersions{
    if(header===undefined)return {};
    if(typeof header!=='string'||!header.length||Buffer.byteLength(header)>4096)throw invalid();
    // A bounded bundle preserves concurrent successful writes without trusting
    // browser-decoded versions or requiring re-signing on another mutation.
    const tokens=header.split(',');if(tokens.length>16)throw invalid();const all:ReadVersions=Object.create(null);
    for(const token of tokens){
      const match=/^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);if(!match)throw invalid();
      const signature=Buffer.from(match[2]!,'base64url');if(signature.toString('base64url')!==match[2]||!timingSafeEqual(signature,this.mac(match[1]!)))throw invalid();
      let p;try{const b=Buffer.from(match[1]!,'base64url');if(b.toString('base64url')!==match[1])throw invalid();p=JSON.parse(b.toString('utf8'));}catch{throw invalid();}
      const now=Math.floor(this.now()/1000);
      if(!p||Object.keys(p).sort().join(',')!=='actorId,exp,iat,role,scope,v,versions'||p.v!==1||typeof p.actorId!=='string'||!roles.includes(p.role)||!Number.isInteger(p.iat)||!Number.isInteger(p.exp)||p.iat>now+5||p.exp!==p.iat+600||p.exp<=now||!versions(p.versions))throw invalid();
      if(p.actorId!==actor.sub||p.role!==actor.role||p.scope!=='appointments')throw new BusinessError(403,'Clinic read token scope does not match the actor.');
      for(const [id,v] of Object.entries(p.versions as ReadVersions))Object.defineProperty(all,id,{value:Math.max(all[id]??0,v),enumerable:true,configurable:true,writable:true});
    }
    if(!versions(all))throw invalid();return all;
  }
}
