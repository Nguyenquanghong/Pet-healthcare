import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import SwaggerParser from '@apidevtools/swagger-parser';
test('Clinic and Core publish the same valid admin activity contract under their respective API base paths',async()=>{
  const clinic=JSON.parse(readFileSync('services/clinic/openapi.json','utf8'));
  const core=JSON.parse(readFileSync('backend/openapi.json','utf8'));
  assert.deepEqual(clinic.components.schemas.ClinicActivity,core.components.schemas.ClinicActivity);
  for(const [doc,path] of [[clinic,'/api/dashboard/clinic/activity'],[core,'/dashboard/clinic/activity']]){
    const route=doc.paths[path].get;
    assert.deepEqual(route.security,[{BearerAuth:[]}]);assert.deepEqual(Object.keys(route.responses).sort(),['200','401','403','422','503','default']);
    assert.deepEqual(route.parameters.map(p=>p.name),['from','to','groupBy','category']);
    await SwaggerParser.validate(doc);
  }
});
