import { createApp } from './app.js';
import { actorVerifier } from './auth.js';
import { createDependencies } from './composition.js';
import { credential, installShutdown,databaseUrl } from '@nipopeto/runtime';
import {PrismaClient} from './generated/client/index.js';
import {ReadFreshness} from './readFreshness.js';
import { CoreDirectory } from './directory.js';
import { clinicRuntime } from './runtime.js';
import {ActivitySummaryEvidence,AuditLane} from './activitySummaryEvidence.js';
import {projectionCapability,capabilityReport} from './projectionVersions.js';
import {assertReadProjectionConfig} from './readProjection.js';
const {db}=createDependencies();
let freshnessDb:PrismaClient|undefined,freshness:ReadFreshness|undefined,activityRows:ReadFreshness|undefined,summaryEvidence:ActivitySummaryEvidence|undefined;
try{
    assertReadProjectionConfig();
    await db.$connect();
    const verify=process.env.JWT_PUBLIC_KEY?actorVerifier({publicKey:process.env.JWT_PUBLIC_KEY,issuer:process.env.JWT_ISSUER??'',audience:process.env.JWT_AUDIENCE??''}):undefined;
    const strict=process.env.PHASE2_RUNTIME_REQUIRED==='1';
    if(strict&&(!verify||!process.env.JWT_KEY_ID||process.env.JWT_PRIVATE_KEY||process.env.JWT_SECRET))throw new Error('VERIFIER_ONLY_CONFIGURATION_REQUIRED');
    if(strict&&!process.env.CORE_SERVICE_URL)throw new Error('CORE_DIRECTORY_URL_REQUIRED');
    const scopes=strict?{billing:credential('CLINIC_BILLING_TOKEN'),bootstrap:credential('CLINIC_BOOTSTRAP_TOKEN'),evidence:credential('CORE_BILLING_EVIDENCE_TOKEN')}:undefined;
    if(scopes&&new Set([...Object.values(scopes),credential('CORE_DIRECTORY_TOKEN')]).size!==4)throw new Error('DISTINCT_SERVICE_CREDENTIALS_REQUIRED');
    const source=process.env.CORE_SERVICE_URL?new CoreDirectory(process.env.CORE_SERVICE_URL,strict?credential('CORE_DIRECTORY_TOKEN'):process.env.CORE_DIRECTORY_TOKEN??process.env.CLINIC_SERVICE_TOKEN??'',scopes):undefined;
    const runtime=verify?clinicRuntime(db,verify):undefined;
    // One explicit audit connection for list freshness and/or activity summary
    // evidence. Activity evidence never switches the list away from authoritative.
    const activityEvidence=process.env.CLINIC_ACTIVITY_SUMMARY_EVIDENCE==='1';
    // Summary serving (fixed or via operator control) is only possible with the
    // background evidence sampler; refuse a configuration that could never be healthy.
    if(['summary','control'].includes(process.env.CLINIC_ACTIVITY_MODE??'')&&!activityEvidence)throw new Error('CLINIC_ACTIVITY_SUMMARY_EVIDENCE_REQUIRED');
    const capability=activityEvidence?projectionCapability():undefined;
    if(process.env.CLINIC_READ_MODE==='projection'||activityEvidence){
      const url=new URL(databaseUrl());url.searchParams.set('connection_limit','1');url.searchParams.set('pool_timeout','1');
      const lane=new AuditLane();
      freshnessDb=new PrismaClient({datasourceUrl:url.href});
      // List serving keeps its guard and, since list study v2 K3v2-F1, the same
      // per-aggregate lag estimator as activity: the carried estimator made lag
      // grow without bound under steady writes. Activity keeps its own
      // list-independent row evidence.
      if(process.env.CLINIC_READ_MODE==='projection')freshness=new ReadFreshness(freshnessDb,undefined,undefined,undefined,{lane,perAggregateLag:true});
      if(capability){activityRows=new ReadFreshness(freshnessDb,undefined,undefined,undefined,{requireListProjection:false,perAggregateLag:true,lane});summaryEvidence=new ActivitySummaryEvidence(freshnessDb,activityRows,capability,lane);}
    }
    const app=createApp(db,verify,source,runtime,freshness,summaryEvidence);
    app.locals.activitySummaryEvidence=summaryEvidence;app.locals.activity.start();
    await runtime?.start();
    freshness?.start();activityRows?.start();summaryEvidence?.start();
    const server=app.listen(Number(process.env.PORT||5101),process.env.HOST||'127.0.0.1',()=>process.stdout.write(JSON.stringify({service:'clinic',status:'api-ready',activityMode:process.env.CLINIC_ACTIVITY_MODE??'source',...(capability?{activitySummaryEvidence:true,...capabilityReport(capability)}:{})})+'\n'));
    server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
    const disconnect=async()=>{await app.locals.appointmentShadow?.drain();await app.locals.activity.close();await summaryEvidence?.close();await activityRows?.close();await freshness?.close();await freshnessDb?.$disconnect();await db.$disconnect();};
    installShutdown('clinic',async()=>{if(runtime)await runtime.drain(server,disconnect);else{await new Promise<void>(resolve=>server.close(()=>resolve()));await disconnect();}});
}catch{process.stderr.write(JSON.stringify({service:'clinic',code:'STARTUP_FAILED'})+'\n');await summaryEvidence?.close();await activityRows?.close();await freshness?.close();await freshnessDb?.$disconnect();await db.$disconnect();process.exitCode=1;}
