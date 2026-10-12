import { cpSync } from 'node:fs';
cpSync('src/generated', 'dist/generated', { recursive: true });
