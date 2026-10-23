import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {generate,typeOf,SPEC,OUTPUT} from './generate-api-types.mjs';
import {validate,responseSchema} from './openapi-validate.mjs';

// AQ-07 fitness function: the frontend's API types are generated from the public
// OpenAPI contract, the committed copy is fresh, and the frontend type modules
// alias the generated shapes instead of re-declaring them by hand.
const root=resolve(import.meta.dirname,'../..');
const spec=JSON.parse(readFileSync(SPEC,'utf8'));

test('the committed frontend API types are exactly what backend/openapi.json generates',()=>{
  assert.equal(readFileSync(OUTPUT,'utf8').replaceAll('\r\n','\n'),generate(spec),'run node tools/phase2/generate-api-types.mjs');
  const changed=structuredClone(spec);changed.components.schemas.Pet.properties.name={type:'integer'};
  assert.notEqual(generate(changed),generate(spec),'a contract change must change the generated types');
});

test('generator maps the OpenAPI subset the contract uses',()=>{
  assert.equal(typeOf({type:'string',enum:['a','b']}),'"a" | "b"');
  assert.equal(typeOf({type:'string',nullable:true}),'string | null');
  assert.equal(typeOf({$ref:'#/components/schemas/Pet'}),'ApiSchemas["Pet"]');
  assert.equal(typeOf({allOf:[{$ref:'#/components/schemas/Pet'}],nullable:true}),'ApiSchemas["Pet"] | null');
  assert.equal(typeOf({type:'array',items:{type:'string',enum:['x','y']}}),'("x" | "y")[]');
  assert.equal(typeOf({oneOf:[{type:'number'},{type:'string'}]}),'number | string');
  assert.equal(typeOf({type:'object',additionalProperties:{type:'integer'}}),'Record<string, number>');
  assert.equal(typeOf({type:'object',required:['a'],properties:{a:{type:'string'},b:{type:'boolean'}}}),'{\n  a: string;\n  b?: boolean;\n}');
  assert.throws(()=>typeOf({$ref:'https://example.test/x.json'}),/UNSUPPORTED_REF/);
});

// Response DTOs the UI renders; each must be an alias of the generated contract type.
const DERIVED={pet:['Pet','PublicPet','PetPublicProfile'],owner:['Owner'],appointment:['Appointment'],booking:['HotelBooking','DailyCareNote'],
  medicalRecord:['MedicalRecord'],medicalImage:['MedicalImage'],invoice:['Invoice','InvoiceItem','BankTransferDetails'],notification:['Notification'],list:['PaginationInfo']};
export function handWritten(source,names){return names.filter(name=>!new RegExp(`export type ${name}\\s*=\\s*ApiSchemas\\[`).test(source));}
test('frontend API DTO types alias the generated contract, not hand-written copies',()=>{
  const bad=Object.entries(DERIVED).flatMap(([file,names])=>handWritten(readFileSync(resolve(root,`frontend/src/types/${file}.ts`),'utf8'),names).map(n=>file+'.'+n));
  assert.deepEqual(bad,[],'re-declared instead of derived: '+bad.join(', '));
  assert.deepEqual(handWritten('export type Pet = { id: string };',['Pet']),['Pet']);
  assert.deepEqual(handWritten('export type Pet = ApiSchemas["Pet"];',['Pet']),[]);
});

test('strict response validator catches what the lenient one let through',()=>{
  const at=(name,value)=>validate(spec,{$ref:'#/components/schemas/'+name},value);
  const appointment={id:'a',petId:'p',ownerId:'o',doctorId:null,type:'vaccination',serviceName:'S',clinicName:'C',date:'2026-10-23',time:'09:30',status:'pending',statusRevision:0,ownerNote:null,createdBy:'owner',createdAt:'2026-10-23T01:02:03.000Z',updatedAt:'2026-10-23T01:02:03.000Z'};
  assert.deepEqual(at('Appointment',appointment),[]);
  assert.match(at('Appointment',{...appointment,serviceName:null}).join(),/null but not nullable/);
  assert.match(at('Appointment',{...appointment,status:'archived'}).join(),/not in enum/);
  assert.match(at('Appointment',{...appointment,createdAt:'yesterday'}).join(),/expected date-time/);
  const {createdBy,...missing}=appointment;assert.match(at('Appointment',missing).join(),/createdBy: required/);
  assert.match(at('InvoiceItem',{id:'i',invoiceId:'v',description:'d',unitPrice:'1000',quantity:1,amount:1000}).join(),/unitPrice: expected number/);
  assert.equal(responseSchema(spec,'GET','/api/pets',200).type,'object');
  assert.throws(()=>responseSchema(spec,'GET','/api/not-a-route',200),/UNDOCUMENTED_PATH/);
});
