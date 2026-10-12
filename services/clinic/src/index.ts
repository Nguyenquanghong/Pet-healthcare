import { createApp } from './app.js';
import { actorVerifier } from './auth.js';
import { createDependencies } from './composition.js';
import { credential, installShutdown } from '@nipopeto/runtime';
import { CoreDirectory } from './directory.js';
import { clinicRuntime } from './runtime.js';
const {db}=createDependencies();
try{
    await db.$connect();
    const verify=process.env.JWT_PUBLIC_KEY?actorVerifier({publicKey:process.env.JWT_PUBLIC_KEY,issuer:process.env.JWT_ISSUER??'',audience:process.env.JWT_AUDIENCE??''}):undefined;
    const strict=process.env.PHASE2_RUNTIME_REQUIRED==='1';
    if(strict&&(!verify||!process.env.JWT_KEY_ID||process.env.JWT_PRIVATE_KEY||process.env.JWT_SECRET))throw new Error('VERIFIER_ONLY_CONFIGURATION_REQUIRED');
    if(strict&&!process.env.CORE_SERVICE_URL)throw new Error('CORE_DIRECTORY_URL_REQUIRED');
    const scopes=strict?{billing:credential('CLINIC_BILLING_TOKEN'),bootstrap:credential('CLINIC_BOOTSTRAP_TOKEN'),evidence:credential('CORE_BILLING_EVIDENCE_TOKEN')}:undefined;
    if(scopes&&new Set([...Object.values(scopes),credential('CORE_DIRECTORY_TOKEN')]).size!==4)throw new Error('DISTINCT_SERVICE_CREDENTIALS_REQUIRED');
    const source=process.env.CORE_SERVICE_URL?new CoreDirectory(process.env.CORE_SERVICE_URL,strict?credential('CORE_DIRECTORY_TOKEN'):process.env.CORE_DIRECTORY_TOKEN??process.env.CLINIC_SERVICE_TOKEN??'',scopes):undefined;
    const runtime=verify?clinicRuntime(db,verify):undefined;
    const app=createApp(db,verify,source,runtime);
    await runtime?.start();
    const server=app.listen(Number(process.env.PORT||5101),process.env.HOST||'127.0.0.1',()=>process.stdout.write(JSON.stringify({service:'clinic',status:'api-ready'})+'\n'));
    server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
    installShutdown('clinic',async()=>{if(runtime)await runtime.drain(server,()=>db.$disconnect());else{await new Promise<void>(resolve=>server.close(()=>resolve()));await db.$disconnect();}});
}catch{process.stderr.write(JSON.stringify({service:'clinic',code:'STARTUP_FAILED'})+'\n');await db.$disconnect();process.exitCode=1;}
