import { spawn,execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { assertTestProject } from './test-project.mjs';
assertTestProject();
// Build with a test-only API override, independent of the developer's .env.
// Compile using the same tsc/vite entrypoints as frontend/package.json.
if(process.env.P5_E2E_BASELINE!=='1'){
  execFileSync(process.execPath,['../node_modules/typescript/bin/tsc','-b'],{cwd:'frontend',stdio:'inherit'});
  execFileSync(process.execPath,['../node_modules/vite/bin/vite.js','build'],{cwd:'frontend',env:{...process.env,NODE_ENV:'production',VITE_API_BASE_URL:'/api'},stdio:'pipe'});
}
process.env.PHASE2_TEST_CONFIRM='pet-phase2-p1-test';
process.stdout.write('P6 E2E frontend build complete; guarded runtime startup begins\n');
const {shutdown}=await import('./e2e-server.mjs');
try{
  const child=spawn(process.execPath,['node_modules/@playwright/test/cli.js','test','--config','tools/phase2/e2e.config.ts',...process.argv.slice(2)],{env:{...process.env,P5_E2E_MANAGED:'1'},stdio:'inherit'});
  const [code]=await once(child,'exit');process.exitCode=code??1;
}finally{await shutdown();}
