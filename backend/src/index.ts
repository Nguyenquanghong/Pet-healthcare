import "dotenv/config";
import { createCoreApp } from "./phase2/coreApp.js";
import { prisma } from "./lib/prisma.js";
import { drainServer } from "./lib/shutdown.js";
import type { ServiceRuntime } from '@nipopeto/runtime';
import { installShutdown } from '@nipopeto/runtime';

try{
  await prisma.$connect();
  const app=createCoreApp(prisma),runtime=app.locals.runtime as ServiceRuntime|undefined;
  await runtime?.start();
  const server=app.listen(Number(process.env.PORT||5000),process.env.HOST||'127.0.0.1',()=>process.stdout.write(JSON.stringify({service:'core',status:'api-ready'})+'\n'));
  server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
  installShutdown('core',async()=>{
    if(runtime)await runtime.drain(server,()=>prisma.$disconnect());
    else{await drainServer(server);await prisma.$disconnect();}
  });
}catch{process.stderr.write(JSON.stringify({service:'core',code:'STARTUP_FAILED'})+'\n');await prisma.$disconnect();process.exitCode=1;}
