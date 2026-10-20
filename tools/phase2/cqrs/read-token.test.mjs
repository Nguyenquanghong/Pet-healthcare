import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {ReadTokens} from '../../../services/clinic/dist/readToken.js';
const actor={sub:'owner-a',role:'owner'},secret='q4-unit-only-'.repeat(4);
test('read tokens verify signed bounded bundles and retain maxima without granting actor scope',()=>{
 const t=new ReadTokens(secret),a=t.issue(actor,{a:1}),b=t.issue(actor,{a:3,b:2});
 assert.deepEqual({...t.verify(a+','+b,actor)},{a:3,b:2});
 assert.throws(()=>t.verify(a,{...actor,sub:'other'}),e=>e.status===403);
 assert.throws(()=>t.verify(a,{...actor,role:'admin'}),e=>e.status===403);
 assert.throws(()=>t.verify(a.slice(0,-2)+'xx',actor),e=>e.status===422);
 assert.throws(()=>t.verify('x'.repeat(4097),actor),e=>e.status===422);
 assert.throws(()=>t.verify(Array(17).fill(a).join(','),actor),e=>e.status===422);
});
test('token expiry, strict shape, scope, versions, canonical signature and secret isolation fail closed',()=>{
 let now=1000000;const t=new ReadTokens(secret,()=>now),token=t.issue(actor,{a:1});now+=600000;
 assert.throws(()=>t.verify(token,actor),e=>e.status===422);
 const sign=p=>{const body=Buffer.from(JSON.stringify(p)).toString('base64url');return body+'.'+createHmac('sha256',secret).update(body).digest('base64url');};
 const valid={v:1,actorId:actor.sub,role:actor.role,scope:'appointments',versions:{a:1},iat:1600,exp:2200};
 for(const patch of [{v:2},{versions:{a:0}},{extra:true},{iat:1700,exp:2300},{versions:Array(2).fill(1)}])assert.throws(()=>t.verify(sign({...valid,...patch}),actor),e=>e.status===422);
 assert.throws(()=>t.verify(sign({...valid,scope:'billing'}),actor),e=>e.status===403);
 assert.throws(()=>new ReadTokens('short'));
 assert.throws(()=>new ReadTokens(secret+'x').verify(token,actor),e=>e.status===422);
});
