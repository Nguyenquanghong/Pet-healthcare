import test from 'node:test';
import assert from 'node:assert/strict';
import {MedicalRecordsService} from '../../../services/clinic/dist/application/services/medicalRecords.js';

// AQ-09 / E-a: server-side image allowlist; direct API clients bypass the browser picker.
const staff={sub:'staff-a',role:'staff'};
const b64=bytes=>Buffer.from(bytes).toString('base64');
const png=b64([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,13]);
const jpeg=b64([0xff,0xd8,0xff,0xe0,0,16]);
const gif=b64([...Buffer.from('GIF89a'),1,0,1,0]);
const webp=b64([...Buffer.from('RIFF'),36,0,0,0,...Buffer.from('WEBPVP8 ')]);

function service(){
  const created=[];
  const records={findPet:async id=>id==='pet-a'?{id,ownerId:'owner-a',name:'Fixture'}:null,createImage:async data=>{created.push(data);return {id:'image',...data,createdAt:new Date()};}};
  return {created,service:new MedicalRecordsService({records})};
}
const input=(mimeType,imageUrl)=>({petId:'pet-a',title:'Scan',mimeType,imageUrl});
async function rejected(promise,pattern){await assert.rejects(promise,error=>error.status===422&&pattern.test(error.message));}

test('allowed image types with matching data URL and signature are stored',async()=>{
  const {service:s,created}=service();
  for(const [mime,data] of [['image/png',png],['image/jpeg',jpeg],['image/gif',gif],['image/webp',webp]])
    assert.equal((await s.createImage(staff,input(mime,`data:${mime};base64,${data}`))).mimeType,mime);
  assert.equal(created.length,4);
});

test('MIME outside the allowlist is rejected before persistence',async()=>{
  const {service:s,created}=service();
  for(const mime of ['image/svg+xml','text/html','application/pdf','IMAGE/PNG','image/png ;'])
    await rejected(s.createImage(staff,input(mime,`data:${mime};base64,${png}`)),/MIME type must be one of/);
  assert.equal(created.length,0);
});

test('data URL prefix, base64 and content signature must match the declared MIME',async()=>{
  const {service:s,created}=service();
  await rejected(s.createImage(staff,input('image/png','https://example.test/a.png')),/base64 data URL/);
  await rejected(s.createImage(staff,input('image/png',`data:image/jpeg;base64,${png}`)),/base64 data URL/);
  await rejected(s.createImage(staff,input('image/png','data:image/png,'+png)),/base64 data URL/);
  await rejected(s.createImage(staff,input('image/png','data:image/png;base64,')),/must be a non-empty|base64 data URL/);
  await rejected(s.createImage(staff,input('image/png','data:image/png;base64,iVBO*w0KGgo=')),/base64 data URL/);
  await rejected(s.createImage(staff,input('image/png','data:image/png;base64,iVBORw0KGgo')),/base64 data URL/);
  await rejected(s.createImage(staff,input('image/png','data:image/png;base64,AA==')),/does not match/);
  await rejected(s.createImage(staff,input('image/png',`data:image/png;base64,${jpeg}`)),/does not match/);
  await rejected(s.createImage(staff,input('image/webp',`data:image/webp;base64,${b64([...Buffer.from('RIFF'),0,0,0,0,...Buffer.from('AVI ')])}`)),/does not match/);
  await rejected(s.createImage(staff,input('image/gif',`data:image/gif;base64,${b64(Buffer.from('<svg onload=1>'))}`)),/does not match/);
  assert.equal(created.length,0);
});

test('owner role and unknown pet keep their existing responses',async()=>{
  const {service:s}=service();
  await assert.rejects(s.createImage({sub:'owner-a',role:'owner'},input('image/png',`data:image/png;base64,${png}`)),error=>error.status===403);
  await assert.rejects(s.createImage(staff,{...input('image/png',`data:image/png;base64,${png}`),petId:'pet-x'}),error=>error.status===404);
});
