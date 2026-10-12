import { randomUUID,createHash } from 'node:crypto';
import type { Prisma,PrismaClient } from './generated/client/index.js';
import { BusinessError } from './domain/error.js';
const canonical=(value:unknown):unknown=>value instanceof Date?value.toISOString():Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):value;
export async function deduplicated(db:PrismaClient,actorId:string,operationType:string,key:unknown,input:unknown,write:(tx:Prisma.TransactionClient)=>Promise<{resourceId:string;response:unknown}>){
  if(typeof key!=='string'||! /^[A-Za-z0-9._:-]{1,128}$/.test(key))throw new BusinessError(422,'A valid Idempotency-Key is required.');
  const hash=createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');
  return db.$transaction(async tx=>{
    const id=randomUUID();
    const inserted=await tx.$executeRaw`INSERT INTO "RequestDedup" (id,"actorId","operationType",key,"requestHash","resourceId","responsePayload") VALUES(${id},${actorId},${operationType},${key},${hash},'','{}'::jsonb) ON CONFLICT("actorId","operationType",key) DO NOTHING`;
    if(!inserted){const old=await tx.requestDedup.findUniqueOrThrow({where:{actorId_operationType_key:{actorId,operationType,key}}});if(old.requestHash!==hash)throw new BusinessError(409,'Idempotency-Key was reused with different content.');return old.responsePayload;}
    const result=await write(tx),response=JSON.parse(JSON.stringify(result.response)) as Prisma.InputJsonValue;
    await tx.requestDedup.update({where:{id},data:{resourceId:result.resourceId,responsePayload:response}});return response;
  });
}
