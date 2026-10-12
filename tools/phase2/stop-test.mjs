import {execFileSync} from 'node:child_process';
import {writeFileSync,mkdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {assertTestProject} from './test-project.mjs';

assertTestProject();
const compose=['compose','-f','deploy/phase2/compose.test.yml'];
const queues=JSON.parse(execFileSync('docker',[...compose,'exec','-T','rabbitmq','rabbitmqctl','list_queues','--formatter','json','name','messages_ready','messages_unacknowledged'],{encoding:'utf8',timeout:30000}));
const retainedNames=['p2.runtime.34ab904b-8e9e-49df-9231-fdc46808dd90.clinic','p4.billing.9ce7ecfc-5fdf-4f9b-abc8-94b215dabc99.notification'];
const retainedQueues=queues.filter(q=>retainedNames.includes(q.name));
// Stop only the three guarded services; retain DBs, rows, dumps and volumes.
execFileSync('docker',[...compose,'stop','postgres','rabbitmq','redis'],{stdio:'pipe',timeout:60000});
const ids=execFileSync('docker',[...compose,'ps','-a','-q'],{encoding:'utf8'}).trim().split(/\s+/).filter(Boolean);
if(ids.length!==3)throw new Error('P7_CHECKPOINT_CONTAINER_COUNT');
const containers=JSON.parse(execFileSync('docker',['inspect',...ids],{encoding:'utf8'})).map(c=>({service:c.Config.Labels['com.docker.compose.service'],project:c.Config.Labels['com.docker.compose.project'],status:c.State.Status,exitCode:c.State.ExitCode}));
if(containers.some(c=>c.project!=='pet-phase2-p1-test'||c.status!=='exited'||c.exitCode!==0))throw new Error('P7_CHECKPOINT_STOP_FAILED');
const report={containers,retainedQueues,queueObservation:'Read before stop; no consume/ACK/purge/delete',volumesRetained:true};
mkdirSync('test-results/phase2',{recursive:true});writeFileSync('test-results/phase2/checkpoint-stop-'+randomUUID()+'.json',JSON.stringify(report,null,2),{flag:'wx'});
process.stdout.write(JSON.stringify(report)+'\n');
