import { createHash, timingSafeEqual } from 'node:crypto';

export function integer(name:string, fallback:number, min=1, max=1000000) {
  const raw=process.env[name]; const value=raw===undefined?fallback:Number(raw);
  if(!Number.isSafeInteger(value)||value<min||value>max)throw new Error('INVALID_RUNTIME_SETTING_'+name);
  return value;
}
export function acceptsCredential(value:unknown, expected:string) {
  return typeof value==='string' && value.length<=512 && timingSafeEqual(createHash('sha256').update(value).digest(),createHash('sha256').update(expected).digest());
}
export function credential(name:string) {
  const value=process.env[name]; if(!value||value.length<32||value.length>512)throw new Error('MISSING_OR_INVALID_'+name); return value;
}
export function databaseUrl(value:string|undefined=process.env.DATABASE_URL) {
  if(!value)throw new Error('DATABASE_CONFIGURATION_REQUIRED');
  let url:URL;try{url=new URL(value);}catch{throw new Error('INVALID_DATABASE_CONFIGURATION');}
  if(!['postgresql:','postgres:'].includes(url.protocol))throw new Error('INVALID_DATABASE_CONFIGURATION');
  url.searchParams.set('connection_limit',String(integer('DB_POOL_LIMIT',4,1,32)));
  url.searchParams.set('pool_timeout',String(integer('DB_POOL_TIMEOUT_SECONDS',2,1,15)));
  url.searchParams.set('connect_timeout','2');return url.toString();
}
export function runtimeEnabled(){return process.env.PHASE2_RUNTIME_REQUIRED==='1'||Boolean(process.env.REDIS_URL);}
