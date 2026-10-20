import test from 'node:test';
import assert from 'node:assert/strict';
import {clinicReadState as state} from '../../../frontend/src/services/clinicReadState.ts';
test('UI retains concurrent write tokens and committed result until matching refresh, isolated by session',()=>{
 state.sync('q4-owner');const signal=state.signal(),before=state.epoch();
 state.mutation('token-one',{appointment:{id:'a',serviceName:'Exam',status:'pending',date:'2040-01-01',time:'09:00'}});
 state.mutation('token-two',{appointment:{id:'b',serviceName:'Spa',status:'confirmed'}});
 assert.equal(state.headers()['X-Clinic-Min-Version'],'token-one,token-two');assert.ok(state.epoch()>before);
 state.confirmed({items:[]});assert.equal(state.saved().length,2);
 state.confirmed({items:[{id:'a',status:'pending',date:'2040-01-01',time:'09:00'}]});assert.equal(state.saved().length,1);
 state.sync('q4-other');assert.ok(signal.aborted);assert.deepEqual(state.saved(),[]);assert.deepEqual(state.headers(),{});
});
test('UI bounds accumulated tokens and uses authoritative GET after expiry or missing historical metadata',()=>{
 state.sync('q4-limit');for(let i=0;i<17;i++)state.mutation('token-'+i,{});
 assert.deepEqual(state.headers(),{'X-Clinic-Read-Consistency':'authoritative'});
 state.sync('q4-expiry');state.mutation('token',{});state.expired();assert.deepEqual(state.headers(),{'X-Clinic-Read-Consistency':'authoritative'});
 state.sync('q4-historical');state.mutation(null,{appointment:{id:'a',serviceName:'Saved',status:'pending'}});assert.equal(state.saved().length,1);assert.deepEqual(state.headers(),{'X-Clinic-Read-Consistency':'authoritative'});state.sync(null);
});
test('late older mutation response cannot overwrite a newer saved result or retain private DTO fields',()=>{
 state.sync('q4-reordered');const token=v=>Buffer.from(JSON.stringify({versions:{a:v}})).toString('base64url')+'.fixture';
 state.mutation(token(3),{appointment:{id:'a',serviceName:'Exam',status:'completed',internalNote:'PRIVATE'}});
 state.mutation(token(1),{appointment:{id:'a',serviceName:'Exam',status:'pending'}});
 assert.equal(state.saved()[0].status,'completed');assert.ok(!('internalNote'in state.saved()[0]));state.sync(null);
});
