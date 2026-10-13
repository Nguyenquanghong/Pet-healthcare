// Diagnostic only: loopback server owned by this process, no DB or application
// endpoints. Compare Node runtimes without changing application behavior.
import http from 'node:http';
import {once} from 'node:events';
const seconds=Number(process.argv[2]??20);
if(!Number.isInteger(seconds)||seconds<1||seconds>60)throw new Error('PROBE_DURATION_OUT_OF_BOUNDS');
const server=http.createServer((_req,res)=>res.end('probe'));
server.listen(0,'127.0.0.1');await once(server,'listening');
const agent=new http.Agent({keepAlive:false,maxSockets:96});
const end=Date.now()+seconds*1000;let success=0,failed=0;
console.log(JSON.stringify({status:'started',node:process.version,uv:process.versions.uv,seconds,concurrency:96}));
await Promise.all(Array.from({length:96},async()=>{
  while(Date.now()<end)await new Promise(resolve=>{
    const req=http.get({hostname:'127.0.0.1',port:server.address().port,agent,path:'/'},res=>{
      res.resume();res.once('end',()=>{if(res.statusCode===200)success++;else failed++;resolve();});
    });
    req.setTimeout(2000,()=>req.destroy(new Error('PROBE_TIMEOUT')));
    req.once('error',()=>{failed++;resolve();});
  });
}));
agent.destroy();await new Promise(resolve=>server.close(resolve));
console.log(JSON.stringify({status:'completed',node:process.version,success,failed}));
if(failed)process.exitCode=1;
