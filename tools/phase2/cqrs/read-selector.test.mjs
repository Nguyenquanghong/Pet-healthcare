import test from 'node:test';
import assert from 'node:assert/strict';
import {selectAppointmentQueries} from '../../../services/clinic/dist/application/queries/appointments.js';
import {createApp} from '../../../services/clinic/dist/app.js';

test('selector defaults to the authoritative reader without running a query',()=>{
  const reader={list:()=>{throw new Error('must not execute');},calendar:()=>{throw new Error('must not execute');}};
  assert.equal(selectAppointmentQueries(reader),reader);
  assert.equal(selectAppointmentQueries(reader,undefined),reader);
  assert.equal(selectAppointmentQueries(reader,'authoritative'),reader);
});

test('shadow requires composition and projection remains unavailable',()=>{
  for(const mode of ['shadow','projection'])assert.throws(()=>selectAppointmentQueries({},mode),/CLINIC_READ_MODE_NOT_AVAILABLE/);
  for(const mode of ['',null,'Authoritative','authoritative ',{},['authoritative']])assert.throws(()=>selectAppointmentQueries({},mode),/INVALID_CLINIC_READ_MODE/);
  const old=process.env.CLINIC_READ_MODE;
  try{
    process.env.CLINIC_READ_MODE='shadow';assert.ok(createApp({}).locals.appointmentShadow);
    process.env.CLINIC_READ_MODE='projection';assert.throws(()=>createApp({}),/CLINIC_READ_TOKEN_SECRET_REQUIRED/);
    process.env.CLINIC_READ_MODE='invalid';assert.throws(()=>createApp({}),/INVALID_CLINIC_READ_MODE/);
  }finally{if(old===undefined)delete process.env.CLINIC_READ_MODE;else process.env.CLINIC_READ_MODE=old;}
});

test('selector permits composed shadow while authoritative remains the default',()=>{
  const source={},shadow={};assert.equal(selectAppointmentQueries(source,'shadow',shadow),shadow);
  assert.equal(selectAppointmentQueries(source,undefined,shadow),source);
});
