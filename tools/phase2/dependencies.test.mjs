import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),braces=require('braces');
test('local build dependency rejects deep patterns and ASTs without recursive stack exhaustion',()=>{
  assert.equal(require('braces/package.json').version,'3.0.3-pet-p6.1');
  for(const owner of ['micromatch','chokidar','tailwindcss'])assert.equal(createRequire(require.resolve(owner))('braces/package.json').version,'3.0.3-pet-p6.1','Actual transitive consumer must use the guard: '+owner);
  assert.equal(createRequire(require.resolve('tailwindcss'))('postcss-selector-parser/package.json').version,'7.1.6');
  for(const method of [braces,braces.parse,braces.compile,braces.expand,braces.stringify])assert.throws(()=>method('{'.repeat(2000)+'a'+'}'.repeat(2000)),SyntaxError);
  let ast={type:'text',value:'a'};for(let n=0;n<2000;n++)ast={type:'brace',nodes:[ast]};
  for(const method of [braces.compile,braces.expand,braces.stringify])assert.throws(()=>method(ast),SyntaxError);
  const cycle={type:'brace',nodes:[]};cycle.nodes.push(cycle);assert.throws(()=>braces.compile(cycle),SyntaxError);
});
test('bounded build dependency retains normal brace compile, ranges and Tailwind glob expansion',()=>{
  assert.deepEqual(braces.expand('src/{components,routes}/**/*.{ts,tsx}'),['src/components/**/*.ts','src/components/**/*.tsx','src/routes/**/*.ts','src/routes/**/*.tsx']);
  assert.deepEqual(braces.expand('{1..3}'),['1','2','3']);assert.deepEqual(braces('a/{b,c}/d'),['a/(b|c)/d']);
});
