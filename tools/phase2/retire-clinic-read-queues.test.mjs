import test from 'node:test';
import assert from 'node:assert/strict';
import { retiredQueues, retire, main } from './retire-clinic-read-queues.mjs';

const P = 'nipopeto.local.v1';
const names = [
  `${P}.clinic-read-v1`,
  `${P}.clinic-read-v1.dlq`,
  ...[1000, 5000, 30000, 120000, 600000].map(ms => `${P}.clinic-read-v1.retry.${ms}ms`),
];

// A broker with a fixed set of queues. Like RabbitMQ, a passive check of a missing queue
// answers 404 and closes the channel, and deleteQueue ifEmpty answers 406 when messages remain.
function fakeBroker(queues) {
  const state = new Map(Object.entries(queues).map(([name, q]) => [name, { messageCount: 0, consumerCount: 0, ...q }]));
  const calls = { checks: [], deletes: [], channels: 0, closed: 0 };
  const openChannel = async () => {
    calls.channels++;
    let open = true;
    const use = () => {
      if (!open) throw Object.assign(new Error('channel closed'), { code: 504 });
    };
    return {
      checkQueue: async name => {
        use();
        calls.checks.push(name);
        if (!state.has(name)) {
          open = false;
          throw Object.assign(new Error('NOT_FOUND'), { code: 404 });
        }
        return { queue: name, ...state.get(name) };
      },
      deleteQueue: async (name, options) => {
        use();
        calls.deletes.push({ name, options });
        if (options?.ifEmpty && state.get(name).messageCount > 0) {
          open = false;
          throw Object.assign(new Error('PRECONDITION_FAILED'), { code: 406 });
        }
        state.delete(name);
        return { messageCount: 0 };
      },
      close: async () => {
        calls.closed++;
        if (!open) throw new Error('already closed');
        open = false;
      },
    };
  };
  return { state, calls, openChannel };
}
const byStatus = results => Object.fromEntries(results.map(r => [r.queue, r.status]));

test('generates exactly the main queue, its DLQ and the five retry queues of the default ladder', () => {
  assert.deepEqual(retiredQueues(P), names);
  assert.deepEqual(retiredQueues('nipopeto.v1')[0], 'nipopeto.v1.clinic-read-v1');
  assert.equal(retiredQueues(P).length, 7);
});

test('a prefix outside the runtime rule is rejected before any broker call', async () => {
  for (const bad of ['', ' ', 'a b', 'a/b', 'a*b', 'a#b', 'ä', 'x'.repeat(101), undefined, null, 42])
    assert.throws(() => retiredQueues(bad), /INVALID_BROKER_PREFIX/, String(bad));
  assert.doesNotThrow(() => retiredQueues('x'.repeat(100)));
  const broker = fakeBroker({});
  await assert.rejects(retire({ openChannel: broker.openChannel, prefix: 'bad prefix', apply: true }), /INVALID_BROKER_PREFIX/);
  assert.equal(broker.calls.channels, 0);
});

test('dry-run (the default) reports and deletes nothing', async () => {
  const broker = fakeBroker(Object.fromEntries(names.map(n => [n, {}])));
  const results = await retire({ openChannel: broker.openChannel, prefix: P });
  assert.deepEqual(results.map(r => r.status), Array(7).fill('would-delete'));
  assert.deepEqual(broker.calls.deletes, []);
  assert.equal(broker.state.size, 7);
});

test('apply deletes only empty queues, with ifEmpty, and refuses the rest', async () => {
  const broker = fakeBroker({
    [names[0]]: {},
    [names[1]]: { messageCount: 3 }, // dead letters: keep for a human
    [names[2]]: {},
    [names[3]]: { messageCount: 1 },
    [names[4]]: {},
    [names[5]]: {},
    [names[6]]: { consumerCount: 1 }, // a live consumer: an old worker is still running
  });
  const results = await retire({ openChannel: broker.openChannel, prefix: P, apply: true });
  assert.deepEqual(byStatus(results), {
    [names[0]]: 'deleted',
    [names[1]]: 'refused',
    [names[2]]: 'deleted',
    [names[3]]: 'refused',
    [names[4]]: 'deleted',
    [names[5]]: 'deleted',
    [names[6]]: 'refused',
  });
  assert.deepEqual(broker.calls.deletes.map(d => d.name), [names[0], names[2], names[4], names[5]]);
  assert.ok(broker.calls.deletes.every(d => d.options.ifEmpty === true));
  assert.deepEqual([...broker.state.keys()].sort(), [names[1], names[3], names[6]].sort());
  assert.match(results[1].reason, /3 message/);
});

test('dry-run flags what apply would refuse', async () => {
  const broker = fakeBroker({ [names[1]]: { messageCount: 2 } });
  const results = await retire({ openChannel: broker.openChannel, prefix: P });
  assert.equal(results[1].status, 'refused');
  assert.deepEqual(broker.calls.deletes, []);
});

test('a missing queue is skipped, not an error, and later queues are still handled', async () => {
  const broker = fakeBroker({ [names[1]]: {}, [names[4]]: {} });
  const results = await retire({ openChannel: broker.openChannel, prefix: P, apply: true });
  assert.deepEqual(byStatus(results), {
    [names[0]]: 'skipped',
    [names[1]]: 'deleted',
    [names[2]]: 'skipped',
    [names[3]]: 'skipped',
    [names[4]]: 'deleted',
    [names[5]]: 'skipped',
    [names[6]]: 'skipped',
  });
  assert.equal(broker.calls.channels, 7, 'one channel per queue: the broker closes the channel on a 404');
  assert.equal(broker.calls.closed, 7);
});

test('a message arriving between the check and the delete is refused by the broker, not reported as a failure', async () => {
  const broker = fakeBroker({ [names[0]]: {} });
  const open = broker.openChannel;
  const racing = async () => {
    const channel = await open();
    const check = channel.checkQueue;
    channel.checkQueue = async name => {
      const answer = await check(name);
      broker.state.get(name).messageCount = 1; // the race
      return answer;
    };
    return channel;
  };
  const [first] = await retire({ openChannel: racing, prefix: P, apply: true });
  assert.equal(first.status, 'refused');
  assert.equal(broker.state.has(names[0]), true);
});

test('any other broker error is a failure and does not hide the other queues', async () => {
  const broker = fakeBroker({ [names[0]]: {}, [names[1]]: {} });
  const open = broker.openChannel;
  let n = 0;
  const flaky = async () => {
    const channel = await open();
    if (n++ === 0) channel.checkQueue = async () => { throw Object.assign(new Error('access refused'), { code: 403 }); };
    return channel;
  };
  const results = await retire({ openChannel: flaky, prefix: P, apply: true });
  assert.equal(results[0].status, 'failed');
  assert.equal(results[0].reason, 'CHECK_FAILED:403');
  assert.equal(results[1].status, 'deleted');
});

// main(): argument and environment handling, exit codes, output.
function fakeConnect(queues) {
  const broker = fakeBroker(queues);
  const connect = async (url, options) => {
    broker.url = url;
    broker.options = options;
    return { on() {}, close: async () => { broker.closedConnection = true; }, createChannel: async () => ({ ...(await broker.openChannel()), on() {} }) };
  };
  return { broker, connect };
}
const env = { BROKER_URL: 'amqp://user:secret@broker:5672', BROKER_PREFIX: P };

test('main: no flag is a dry-run, exit 0, nothing deleted, URL never printed', async () => {
  const { broker, connect } = fakeConnect(Object.fromEntries(names.map(n => [n, {}])));
  const lines = [];
  const code = await main({ env, argv: [], connect, out: line => lines.push(line) });
  assert.equal(code, 0);
  assert.deepEqual(broker.calls.deletes, []);
  assert.equal(broker.closedConnection, true);
  assert.match(lines[0], /^dry-run prefix=nipopeto\.local\.v1$/);
  assert.deepEqual(JSON.parse(lines.at(-1)), { mode: 'dry-run', prefix: P, deleted: 0, wouldDelete: 7, skipped: 0, refused: 0, failed: 0 });
  assert.ok(!lines.join('\n').includes('secret'));
});

test('main: --apply deletes the empty queues and exits 0; a non-empty queue makes it exit 1', async () => {
  const ok = fakeConnect(Object.fromEntries(names.map(n => [n, {}])));
  assert.equal(await main({ env, argv: ['--apply'], connect: ok.connect, out() {} }), 0);
  assert.equal(ok.broker.state.size, 0);

  const kept = fakeConnect({ [names[0]]: {}, [names[1]]: { messageCount: 5 } });
  const lines = [];
  assert.equal(await main({ env, argv: ['--apply'], connect: kept.connect, out: line => lines.push(line) }), 1);
  assert.deepEqual([...kept.broker.state.keys()], [names[1]]);
  assert.equal(JSON.parse(lines.at(-1)).refused, 1);
});

test('main: an empty broker (everything already gone) is a clean exit 0', async () => {
  const { connect } = fakeConnect({});
  assert.equal(await main({ env, argv: ['--apply'], connect, out() {} }), 0);
});

test('main: bad prefix, missing settings and bad flags are rejected before connecting', async () => {
  let connected = 0;
  const connect = async () => { connected++; throw new Error('must not connect'); };
  await assert.rejects(main({ env: { ...env, BROKER_PREFIX: 'bad prefix' }, argv: [], connect }), /INVALID_BROKER_PREFIX/);
  await assert.rejects(main({ env: { ...env, BROKER_PREFIX: '' }, argv: [], connect }), /BROKER_PREFIX_REQUIRED/);
  await assert.rejects(main({ env: { BROKER_PREFIX: P }, argv: [], connect }), /BROKER_URL_REQUIRED/);
  await assert.rejects(main({ env, argv: ['--apply', '--dry-run'], connect }), /Usage/);
  await assert.rejects(main({ env, argv: ['--force'], connect }), /Usage/);
  await assert.rejects(main({ env, argv: ['--apply', '--apply'], connect }), /Usage/);
  assert.equal(connected, 0);
});
