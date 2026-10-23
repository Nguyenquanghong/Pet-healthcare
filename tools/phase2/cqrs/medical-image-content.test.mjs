import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {MedicalRecordsService} from '../../../services/clinic/dist/application/services/medicalRecords.js';

// AQ-09 / E-a: server-side image allowlist; direct API clients bypass the browser picker.
// AQ-05: a doctor (or admin) writes medical images; staff only reads them.
const doctor={sub:'doctor-a',role:'doctor'};
const b64=bytes=>Buffer.from(bytes).toString('base64');
const png=b64([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,13]);
const jpeg=b64([0xff,0xd8,0xff,0xe0,0,16]);
const gif=b64([...Buffer.from('GIF89a'),1,0,1,0]);
const webp=b64([...Buffer.from('RIFF'),36,0,0,0,...Buffer.from('WEBPVP8 ')]);

// In-memory bucket: records every put/remove so tests can assert the Claim Check order.
export function memoryBlobs({failPut=false,failRemove=false}={}){
  const objects=new Map(),calls=[];
  return {objects,calls,
    put:async(key,body,type)=>{calls.push(['put',key]);if(failPut)throw new Error('BLOB_PUT_FAILED_500');objects.set(key,{body,type});},
    remove:async key=>{calls.push(['remove',key]);if(failRemove)throw new Error('BLOB_DELETE_FAILED_500');objects.delete(key);},
    signedGetUrl:key=>({url:'https://blob.test/'+key+'?sig=1',expiresAt:new Date('2030-01-01T00:05:00Z')}),
    ensureBucket:async()=>{},check:async()=>{}};
}
function service({blobs=memoryBlobs(),failCreate=false}={}){
  const created=[],cleanup=[];
  const records={findPet:async id=>id==='pet-a'?{id,ownerId:'owner-a',name:'Fixture'}:null,
    createImage:async data=>{if(failCreate)throw new Error('DB_DOWN');created.push(data);const {sha256,...row}=data;return {...row,createdAt:new Date()};},
    deleteImage:async id=>{if(id==='missing')throw Object.assign(new Error('P2025'),{code:'P2025'});cleanup.push(id);return {storageKey:id==='legacy'?null:'images/'+id};},
    completeBlobCleanup:async key=>{cleanup.push('done:'+key);}};
  return {created,cleanup,blobs,service:new MedicalRecordsService({records,blobs})};
}
const input=(mimeType,imageUrl)=>({petId:'pet-a',title:'Scan',mimeType,imageUrl});
async function rejected(promise,pattern){await assert.rejects(promise,error=>error.status===422&&pattern.test(error.message));}

test('allowed image types with matching data URL and signature are stored',async()=>{
  const {service:s,created}=service();
  for(const [mime,data] of [['image/png',png],['image/jpeg',jpeg],['image/gif',gif],['image/webp',webp]])
    assert.equal((await s.createImage(doctor,input(mime,`data:${mime};base64,${data}`))).mimeType,mime);
  assert.equal(created.length,4);
});

test('Claim Check: bytes go to the bucket first, the row keeps key, size and sha256, the response carries a valet key and no content',async()=>{
  const {service:s,created,blobs}=service();
  const image=await s.createImage(doctor,input('image/png',`data:image/png;base64,${png}`));
  const bytes=Buffer.from(png,'base64');
  assert.equal(blobs.calls[0][0],'put');assert.equal(created.length,1);
  assert.deepEqual(created[0],{id:created[0].id,petId:'pet-a',title:'Scan',mimeType:'image/png',storageKey:'images/'+created[0].id,sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  assert.ok(blobs.objects.get(created[0].storageKey).body.equals(bytes));assert.equal(blobs.objects.get(created[0].storageKey).type,'image/png');
  assert.deepEqual(Object.keys(image).sort(),['createdAt','id','mimeType','petId','sizeBytes','title','url','urlExpiresAt']);
  assert.equal(image.url,'https://blob.test/images/'+image.id+'?sig=1');assert.equal(image.urlExpiresAt,'2030-01-01T00:05:00.000Z');assert.equal(image.sizeBytes,bytes.length);
});

test('a failed bucket write stores no row; a failed row insert removes the object again',async()=>{
  const down=service({blobs:memoryBlobs({failPut:true})});
  await assert.rejects(down.service.createImage(doctor,input('image/png',`data:image/png;base64,${png}`)),/BLOB_PUT_FAILED/);assert.equal(down.created.length,0);
  const failing=service({failCreate:true});
  await assert.rejects(failing.service.createImage(doctor,input('image/png',`data:image/png;base64,${png}`)),/DB_DOWN/);
  assert.deepEqual(failing.blobs.calls.map(c=>c[0]),['put','remove']);assert.equal(failing.blobs.objects.size,0);
});

test('delete removes the row first, then the object; a bucket outage leaves the cleanup claim for the worker',async()=>{
  const ok=service();await ok.service.deleteImage(doctor,'img-1');
  assert.deepEqual(ok.cleanup,['img-1','done:images/img-1']);assert.deepEqual(ok.blobs.calls,[['remove','images/img-1']]);
  const outage=service({blobs:memoryBlobs({failRemove:true})});await outage.service.deleteImage(doctor,'img-2');
  assert.deepEqual(outage.cleanup,['img-2']);// no completion: the claim stays queued
  const legacy=service();await legacy.service.deleteImage(doctor,'legacy');assert.deepEqual(legacy.blobs.calls,[]);
  await assert.rejects(service().service.deleteImage({sub:'owner-a',role:'owner'},'img-1'),error=>error.status===403);
});

test('MIME outside the allowlist is rejected before persistence',async()=>{
  const {service:s,created}=service();
  for(const mime of ['image/svg+xml','text/html','application/pdf','IMAGE/PNG','image/png ;'])
    await rejected(s.createImage(doctor,input(mime,`data:${mime};base64,${png}`)),/MIME type must be one of/);
  assert.equal(created.length,0);
});

test('data URL prefix, base64 and content signature must match the declared MIME',async()=>{
  const {service:s,created}=service();
  await rejected(s.createImage(doctor,input('image/png','https://example.test/a.png')),/base64 data URL/);
  await rejected(s.createImage(doctor,input('image/png',`data:image/jpeg;base64,${png}`)),/base64 data URL/);
  await rejected(s.createImage(doctor,input('image/png','data:image/png,'+png)),/base64 data URL/);
  await rejected(s.createImage(doctor,input('image/png','data:image/png;base64,')),/must be a non-empty|base64 data URL/);
  await rejected(s.createImage(doctor,input('image/png','data:image/png;base64,iVBO*w0KGgo=')),/base64 data URL/);
  await rejected(s.createImage(doctor,input('image/png','data:image/png;base64,iVBORw0KGgo')),/base64 data URL/);
  await rejected(s.createImage(doctor,input('image/png','data:image/png;base64,AA==')),/does not match/);
  await rejected(s.createImage(doctor,input('image/png',`data:image/png;base64,${jpeg}`)),/does not match/);
  await rejected(s.createImage(doctor,input('image/webp',`data:image/webp;base64,${b64([...Buffer.from('RIFF'),0,0,0,0,...Buffer.from('AVI ')])}`)),/does not match/);
  await rejected(s.createImage(doctor,input('image/gif',`data:image/gif;base64,${b64(Buffer.from('<svg onload=1>'))}`)),/does not match/);
  assert.equal(created.length,0);
});

test('owner role and unknown pet keep their existing responses',async()=>{
  const {service:s}=service();
  await assert.rejects(s.createImage({sub:'owner-a',role:'owner'},input('image/png',`data:image/png;base64,${png}`)),error=>error.status===403);
  await assert.rejects(s.createImage({sub:'staff-a',role:'staff'},input('image/png',`data:image/png;base64,${png}`)),error=>error.status===403);
  await assert.rejects(s.createImage(doctor,{...input('image/png',`data:image/png;base64,${png}`),petId:'pet-x'}),error=>error.status===404);
});
