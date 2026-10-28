import { createApp } from './app.js';
import { actorVerifier } from './auth.js';
import { createDependencies } from './composition.js';
import { credential, installShutdown } from '@nipopeto/runtime';
import { CoreDirectory } from './directory.js';
import { clinicRuntime } from './runtime.js';
import {S3BlobStore,blobStoreFromEnv} from './blobStore.js';
const {db}=createDependencies();
try{
    await db.$connect();
    const verify=process.env.JWT_PUBLIC_KEY?actorVerifier({publicKey:process.env.JWT_PUBLIC_KEY,issuer:process.env.JWT_ISSUER??'',audience:process.env.JWT_AUDIENCE??''}):undefined;
    const strict=process.env.PHASE2_RUNTIME_REQUIRED==='1';
    if(strict&&(!verify||!process.env.JWT_KEY_ID||process.env.JWT_PRIVATE_KEY||process.env.JWT_SECRET))throw new Error('VERIFIER_ONLY_CONFIGURATION_REQUIRED');
    if(strict&&!process.env.CORE_SERVICE_URL)throw new Error('CORE_DIRECTORY_URL_REQUIRED');
    const scopes=strict?{billing:credential('CLINIC_BILLING_TOKEN'),evidence:credential('CORE_BILLING_EVIDENCE_TOKEN')}:undefined;
    if(scopes&&new Set([...Object.values(scopes),credential('CORE_DIRECTORY_TOKEN')]).size!==3)throw new Error('DISTINCT_SERVICE_CREDENTIALS_REQUIRED');
    const source=process.env.CORE_SERVICE_URL?new CoreDirectory(process.env.CORE_SERVICE_URL,strict?credential('CORE_DIRECTORY_TOKEN'):process.env.CORE_DIRECTORY_TOKEN??process.env.CLINIC_SERVICE_TOKEN??'',scopes):undefined;
    const runtime=verify?clinicRuntime(db,verify):undefined;
    // Medical image bucket (AQ-09). Misconfiguration fails startup; an unreachable
    // bucket only fails image requests and readiness, not the whole service.
    const blobs=blobStoreFromEnv();
    if(blobs instanceof S3BlobStore)await blobs.ensureBucket().catch(()=>{process.stderr.write(JSON.stringify({service:'clinic',code:'BLOB_BUCKET_UNAVAILABLE'})+'\n');});
    const app=createApp(db,verify,source,runtime,blobs);
    await runtime?.start();
    const server=app.listen(Number(process.env.PORT||5101),process.env.HOST||'127.0.0.1',()=>process.stdout.write(JSON.stringify({service:'clinic',status:'api-ready',activityMode:process.env.CLINIC_ACTIVITY_MODE??'source'})+'\n'));
    server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
    const disconnect=async()=>{await db.$disconnect();};
    installShutdown('clinic',async()=>{if(runtime)await runtime.drain(server,disconnect);else{await new Promise<void>(resolve=>server.close(()=>resolve()));await disconnect();}});
    // A failed startup echoes only constant error codes, never messages that may carry URLs or secrets.
}catch(error){const reason=error instanceof Error&&/^[A-Z][A-Z0-9_]{2,80}$/.test(error.message)?error.message:undefined;process.stderr.write(JSON.stringify({service:'clinic',code:'STARTUP_FAILED',...(reason?{reason}:{})})+'\n');await db.$disconnect();process.exitCode=1;}
