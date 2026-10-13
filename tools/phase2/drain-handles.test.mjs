import test from 'node:test';
import assert from 'node:assert/strict';
import {drainHandles} from './drain-handles.mjs';
test('a failed child does not strand surviving children or hide the original failure',async()=>{
  const stopped=[],failure=new Error('native child failed');
  const handles=[{stop:async()=>{stopped.push('core');}},{stop:async()=>{stopped.push('clinic');throw failure;}},{stop:async()=>{stopped.push('worker');}}];
  await assert.rejects(drainHandles(handles),error=>error===failure);
  assert.deepEqual(stopped,['worker','clinic','core']);
  assert.equal(handles.length,3);
});
