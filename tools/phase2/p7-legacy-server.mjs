// Test-only original monolith composition on a fresh marked P7 legacy DB.
import {loadContext,client,assertDatabase} from './p7-environment.mjs';
import {createApp} from '../../backend/dist/src/app.js';
import {installShutdown} from '@nipopeto/runtime';
const ctx=loadContext(process.env.P7_CONTEXT_FILE),db=client(ctx,'legacy');
try{await assertDatabase(db,ctx,'legacy');const server=createApp(db).listen(Number(process.env.PORT),'127.0.0.1');installShutdown('p7-legacy',async()=>{const closing=new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));server.closeIdleConnections();await closing;await db.$disconnect();});}
catch{process.stderr.write('P7_LEGACY_STARTUP_FAILED\n');await db.$disconnect();process.exitCode=1;}
