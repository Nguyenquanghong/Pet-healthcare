import assert from 'node:assert/strict';
import test from 'node:test';
import { freeNetworkPrefix, usedRanges } from './network-prefix.mjs';

const fake = subnets => args => args[1] === 'ls' ? 'a b\n' : JSON.stringify(subnets.map(Subnet => ({ IPAM: { Config: Subnet ? [{ Subnet }] : [] } })));
const sequence = values => { let i = 0; return () => values[Math.min(i++, values.length - 1)]; };

test('used ranges cover every subnet Docker reports, wide or narrow, and ignore networks without one', () => {
  assert.equal(usedRanges(fake(['172.17.0.0/16', '10.231.5.0/24', null])).length, 2);
  assert.deepEqual(usedRanges(() => ''), []);
});

test('the chosen /24 never lies inside a wide used range', () => {
  const used = usedRanges(fake(['10.231.0.0/16', '10.232.0.0/17']));
  for (let i = 0; i < 300; i++) {
    const [, second, third] = freeNetworkPrefix(used).split('.').map(Number);
    assert.ok(second > 232 || (second === 232 && third >= 128), `10.${second}.${third} is inside a used range`);
  }
});

test('a second run avoids the network a stopped first run left behind', () => {
  // 0.5 -> 10.241.126 both times; the second call is told it is taken and draws again.
  const first = freeNetworkPrefix([], sequence([0.5, 0.5]));
  assert.equal(first, '10.241.126');
  assert.notEqual(freeNetworkPrefix(usedRanges(fake([first + '.0/24'])), sequence([0.5, 0.5, 0.9, 0.9])), first);
});

test('no free range is an error, not an overlapping choice', () => {
  assert.throws(() => freeNetworkPrefix(usedRanges(fake(['10.0.0.0/8']))), /No free/);
});
