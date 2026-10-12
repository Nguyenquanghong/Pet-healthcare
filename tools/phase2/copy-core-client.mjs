import { cpSync } from 'node:fs';
cpSync('src/generated/phase2-core', 'dist/src/generated/phase2-core', { recursive: true });
