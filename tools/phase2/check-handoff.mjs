import {resolve} from 'node:path';
import {verifyBundle} from './source-provenance.mjs';
const [root='.',expectedHash,...extra]=process.argv.slice(2);if(extra.length)throw new Error('SOURCE_CHECK_USAGE');
const m=verifyBundle(resolve(root),expectedHash);process.stdout.write(JSON.stringify({status:'passed',files:m.files.length,sourceHash:m.sourceHash,manifestHash:m.manifestHash,gitHead:m.provenance.gitHead,kind:m.kind})+'\n');
