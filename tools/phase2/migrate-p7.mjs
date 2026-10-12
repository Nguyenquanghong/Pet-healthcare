import {readFileSync,writeFileSync} from 'node:fs';
import {assertTestProject} from './test-project.mjs';
import {artifact,createEnvironment,loadContext,backupAndRestore,withCutoverLock} from './p7-environment.mjs';
import {exportMigration,inspectMigration,importMigration,validateMigration} from './p7-migration.mjs';
import {freezeLegacy,rollbackBeforeOpen,openTarget,pauseTarget,forwardFix,cutoverState,targetPermissions} from './p7-cutover.mjs';

const [command,contextFile,snapshotFile,evidenceFile,...extra]=process.argv.slice(2);
const actions=['init','freeze','backup-restore','export','dry-run','import','validate','rollback-before-open','open-target','pause-target','forward-fix','state','read-only-target'];
try{
  if(process.env.PHASE2_TEST_CONFIRM!=='pet-phase2-p1-test')throw new Error('P7_CONFIRMATION_REQUIRED');
  if(!actions.includes(command)||!contextFile||extra.length||(evidenceFile&&command!=='export')||(['export','dry-run','import','validate','open-target'].includes(command)!==Boolean(snapshotFile)))throw new Error('P7_USAGE');
  assertTestProject();const ctx=command==='init'?createEnvironment(contextFile):loadContext(contextFile);
  let report={command,run:ctx.run};
  if(command==='freeze')await freezeLegacy(ctx);
  if(command==='backup-restore')report={...report,...await backupAndRestore(ctx)};
  if(command==='export'){const evidence=evidenceFile?JSON.parse(readFileSync(artifact(evidenceFile),'utf8')):{};const snapshot=await exportMigration(ctx,{evidence});writeFileSync(artifact(snapshotFile),JSON.stringify(snapshot),{flag:'wx'});report={...report,snapshotHash:snapshot.sha256};}
  if(['dry-run','import','validate','open-target'].includes(command)){
    const snapshot=JSON.parse(readFileSync(artifact(snapshotFile),'utf8'));
    if(command==='open-target')await openTarget(ctx,snapshot);
    else report={...report,...await ({'dry-run':inspectMigration,import:importMigration,validate:validateMigration}[command])(ctx,snapshot)};
  }
  if(command==='rollback-before-open')await rollbackBeforeOpen(ctx);
  if(command==='pause-target')await pauseTarget(ctx);
  if(command==='forward-fix')await forwardFix(ctx);
  if(command==='read-only-target')await withCutoverLock(ctx,async()=>{const gate=await cutoverState(ctx);if(gate.opened_at!==null)throw new Error('P7_READ_ONLY_AFTER_OPEN_USE_PAUSE');await targetPermissions(ctx,false);});
  if(command==='state')report={...report,...await cutoverState(ctx)};
  process.stdout.write(JSON.stringify(report)+'\n');
}catch(error){process.stderr.write(JSON.stringify({status:'failed',code:/^P7_[A-Z_]+$/.test(error?.message??'')?error.message:'P7_REHEARSAL_FAILED',hint:'Inspect ignored local artifacts; no automatic overwrite/reset or live database access.'})+'\n');process.exitCode=1;}
