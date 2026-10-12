import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import {sha256,verifyBundle} from './source-provenance.mjs';

const [receiptFile,verificationFile,...extra]=process.argv.slice(2),root=resolve('.'),artifacts=resolve('test-results/phase2');
function artifact(path){const file=resolve(path),rel=relative(artifacts,file);if(!rel||rel.startsWith('..')||isAbsolute(rel))throw new Error('SOURCE_EVIDENCE_ARTIFACT_SCOPE');return file;}
if(!receiptFile||!verificationFile||extra.length)throw new Error('SOURCE_EVIDENCE_USAGE');
const receipt=JSON.parse(readFileSync(artifact(receiptFile),'utf8')),verification=JSON.parse(readFileSync(artifact(verificationFile),'utf8'));
if(verification.status!=='passed'||!verification.sourceUnchangedAfterVerification||!verification.testStackStopped||verification.sourceHash!==receipt.sourceHash||verification.manifestHash!==receipt.manifestHash||verification.archiveHash!==receipt.archiveHash||verification.commands.some(c=>c.exit!==0))throw new Error('SOURCE_EVIDENCE_PASS_REQUIRED');
const required=['npm ci','npm test','npm run phase2:build','npm run phase2:verify','npm run phase2:test:notification-ui'];if(required.some(command=>!verification.commands.some(c=>c.command===command&&c.exit===0)))throw new Error('SOURCE_EVIDENCE_COMMANDS_REQUIRED');
if(sha256(readFileSync(artifact(receipt.archive)))!==receipt.archiveHash)throw new Error('SOURCE_EVIDENCE_ARCHIVE_HASH');verifyBundle(artifact(receipt.source),receipt.sourceHash);
const detached=resolve(verification.detachedRoot);verifyBundle(detached,receipt.sourceHash);
const results=resolve(detached,'test-results/phase2'),snapshots=readdirSync(results,{withFileTypes:true}).filter(d=>d.isDirectory()&&/^p7-[a-f0-9-]{36}$/.test(d.name)).map(d=>JSON.parse(readFileSync(resolve(results,d.name,'snapshot.json'),'utf8')));
if(!snapshots.length||snapshots.some(s=>s.source.provenanceKind!=='verified-handoff-manifest'||s.source.sourceBundleHash!==receipt.sourceHash||s.source.sourceManifestHash!==receipt.manifestHash))throw new Error('SOURCE_EVIDENCE_GITLESS_PROVENANCE');
const publicReport={version:1,verifiedPackage:receipt,verification:{...verification,receipt:relative(root,artifact(receiptFile)).replaceAll('\\','/'),report:relative(root,artifact(verificationFile)).replaceAll('\\','/')},p7Provenance:{kind:'verified-handoff-manifest',sourceBundleHash:receipt.sourceHash,sourceManifestHash:receipt.manifestHash,snapshots:snapshots.length},scope:'Archive extracted and verified outside checkout on same Windows host and same guarded Docker test volumes. No independent receiver/machine or remote CI claim. No live DB, commit/push or external sharing.'};
writeFileSync(resolve('phase2-plan/evidence/h-source-package.json'),JSON.stringify(publicReport,null,2)+'\n');process.stdout.write(JSON.stringify({files:receipt.files,sourceHash:receipt.sourceHash,archiveHash:receipt.archiveHash,status:'passed',independentReceiver:false})+'\n');
