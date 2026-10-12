import { createPublicKey } from 'node:crypto';
import jwt from 'jsonwebtoken';
export type Actor={sub:string;role:'owner'|'doctor'|'staff'|'admin'};
export function publicVerifier(config:{publicKey:string;issuer:string;audience:string;keyId?:string}){
  const key=createPublicKey(config.publicKey);
  if(key.asymmetricKeyType!=='rsa'||(key.asymmetricKeyDetails?.modulusLength??0)<2048||!config.issuer||!config.audience||config.keyId!==undefined&&!/^[a-zA-Z0-9_.-]{1,64}$/.test(config.keyId))throw new Error('INVALID_AUTH_CONFIGURATION');
  return(token:string):Actor=>{
    if(token.length>8192)throw new Error('INVALID_ACTOR');
    const decoded=jwt.verify(token,key,{algorithms:['RS256'],issuer:config.issuer,audience:config.audience,complete:true});
    const p=decoded.payload;
    if(config.keyId&&decoded.header.kid!==config.keyId||typeof p==='string'||typeof p.sub!=='string'||!p.sub||p.sub.length>200||!['owner','doctor','staff','admin'].includes(p.role)||typeof p.exp!=='number'||!Number.isFinite(p.exp))throw new Error('INVALID_ACTOR');
    return{sub:p.sub,role:p.role};
  };
}
