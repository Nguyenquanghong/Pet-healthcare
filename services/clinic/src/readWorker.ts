import {PrismaClient} from './generated/client/index.js';
import {databaseUrl,integer} from '@nipopeto/runtime';
import {declareTopology,consumeEvents,delay,reconnect,requireBrokerConfig,startWorker} from '@nipopeto/messaging';
import {AppointmentProjector} from './appointmentProjector.js';
import {projectionCapability,assertProjectionTargets,capabilityReport} from './projectionVersions.js';
import {readProjectionEnabled} from './readProjection.js';

// A Clinic-owned worker, not a fourth business service. Budget is explicit and
// separate from the API. It hydrates only Clinic; no Core/JWT signing credentials.
// Transport queue/consumer name stay clinic-read-v1: the event is unchanged.
// Nothing writes read revisions or events while the switch is off, so a worker
// would only idle against an unmaintained registry: refuse to start.
if(!readProjectionEnabled()){process.stderr.write(JSON.stringify({service:'clinic-read-v1',code:'CLINIC_READ_PROJECTION_OFF'})+'\n');process.exit(1);}
const url=new URL(databaseUrl());
url.searchParams.set('connection_limit',String(integer('CLINIC_READ_PROJECTOR_POOL_LIMIT',1,1,2)));
const db=new PrismaClient({datasourceUrl:url.href});
await startWorker('clinic-read-v1',async signal=>{
  try{
    const capability=projectionCapability();
    await db.$connect();
    if(!await db.readProjectionControl.findUnique({where:{projectionName:'appointments'}}))throw new Error('READ_PROJECTION_NOT_INITIALIZED');
    const targets=await db.readProjectionGeneration.findMany({where:{projectionName:'appointments',state:{in:['BUILDING','READY','ACTIVE']}},select:{schemaVersion:true}});
    if(targets.length<1||targets.length>2)throw new Error('READ_PROJECTION_GENERATION_BUDGET');
    assertProjectionTargets(capability,targets);
    const projector=new AppointmentProjector(db,undefined,capability),config=requireBrokerConfig();
    const metrics=setInterval(()=>{process.stdout.write(JSON.stringify({service:'clinic-read-v1',...projector.stats})+'\n');},10000);metrics.unref();
    try{await reconnect('clinic-read-v1',signal,async()=>{
      await declareTopology(config.brokerUrl,config.topology);
      const consumer=await consumeEvents(config.brokerUrl,config.topology.clinicRead,'clinic-read-v1',raw=>projector.apply(raw));
      process.stdout.write(JSON.stringify({service:'clinic-read-v1',status:'worker-ready',poolLimit:Number(url.searchParams.get('connection_limit')),prefetch:1,...capabilityReport(capability)})+'\n');
      const stopped=new AbortController(),abort=()=>stopped.abort();signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
      try{await Promise.race([consumer.done,delay(2147483647,stopped.signal)]);}
      finally{stopped.abort();signal.removeEventListener('abort',abort);await consumer.close();}
    });}finally{clearInterval(metrics);}
  }finally{await db.$disconnect();}
});
