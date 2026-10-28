import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect } from 'node:net';
import express from 'express';
import { requestFault } from '../dist/index.js';

const text = { invalid: 'not json', large: 'too large', other: 'unreadable' };

// The error handler of every service, reduced to the part under test: body-parser errors from a real parser.
async function server(t) {
  const seen = [];
  const app = express();
  app.post('/json', express.json({ limit: '1kb' }), (req, res) => res.json(req.body));
  app.post('/form', express.urlencoded({ extended: true, parameterLimit: 2 }), (req, res) => res.json(req.body));
  app.use((error, _req, res, _next) => {
    seen.push(error);
    const fault = requestFault(error, text);
    if (fault) res.status(fault.status).json(fault.body);
    else res.status(500).json({ error: 'bug' });
  });
  const listener = app.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  t.after(() => {
    listener.closeAllConnections();
    listener.close();
  });
  return { base: `http://127.0.0.1:${listener.address().port}`, port: listener.address().port, seen };
}
const post = async (base, path, headers, body) => {
  const res = await fetch(base + path, { method: 'POST', headers, body });
  return { status: res.status, body: await res.json() };
};

test('an unsupported charset or encoding is a 415 with fixed text, not a 500', async t => {
  const { base, seen } = await server(t);
  const charset = await post(base, '/json', { 'Content-Type': 'application/json; charset=latin1' }, '{"a":1}');
  assert.deepEqual(charset, { status: 415, body: { error: 'unreadable' } });
  assert.equal(seen.at(-1).type, 'charset.unsupported');
  assert.doesNotMatch(JSON.stringify(charset.body), /latin1/i, 'the parser message, which quotes the request, is not echoed');
  const encoding = await post(base, '/json', { 'Content-Type': 'application/json', 'Content-Encoding': 'compress' }, '{"a":1}');
  assert.deepEqual(encoding, { status: 415, body: { error: 'unreadable' } });
  assert.equal(seen.at(-1).type, 'encoding.unsupported');
});

test('invalid JSON and an oversized body keep their own text; too many parameters is a 413', async t => {
  const { base, seen } = await server(t);
  assert.deepEqual(await post(base, '/json', { 'Content-Type': 'application/json' }, '{"a":'), { status: 400, body: { error: 'not json' } });
  assert.equal(seen.at(-1).type, 'entity.parse.failed');
  assert.deepEqual(await post(base, '/json', { 'Content-Type': 'application/json' }, JSON.stringify({ a: 'x'.repeat(2000) })), { status: 413, body: { error: 'too large' } });
  assert.equal(seen.at(-1).type, 'entity.too.large');
  assert.deepEqual(await post(base, '/form', { 'Content-Type': 'application/x-www-form-urlencoded' }, 'a=1&b=2&c=3'), { status: 413, body: { error: 'unreadable' } });
  assert.equal(seen.at(-1).type, 'parameters.too.many');
  assert.equal((await post(base, '/json', { 'Content-Type': 'application/json' }, '{"a":1}')).status, 200, 'a good body still passes');
});

test('an upload cut off before its Content-Length is a 400 fault', async t => {
  const { port, seen } = await server(t);
  const cut = connect(port, '127.0.0.1');
  await once(cut, 'connect');
  cut.write('POST /json HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 50\r\n\r\n{"a"');
  await new Promise(resolve => setTimeout(resolve, 50));
  cut.destroy();
  for (let i = 0; i < 40 && seen.at(-1)?.type !== 'request.aborted'; i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(seen.at(-1)?.type, 'request.aborted');
  assert.deepEqual(requestFault(seen.at(-1), text), { status: 400, body: { error: 'unreadable' } });
});

test('only an exposed 4xx is a request fault: bugs, outages and business errors fall through', () => {
  const parser = { status: 415, expose: true, type: 'charset.unsupported', message: 'unsupported charset "LATIN1"' };
  assert.deepEqual(requestFault(parser, text), { status: 415, body: { error: 'unreadable' } });
  assert.deepEqual(requestFault({ ...parser, status: 400, type: 'entity.parse.failed' }, text), { status: 400, body: { error: 'not json' } });
  assert.deepEqual(requestFault({ ...parser, status: 413, type: 'entity.too.large' }, text), { status: 413, body: { error: 'too large' } });
  for (const value of [
    new Error('boom'),
    Object.assign(new Error('x'), { status: 404 }),
    { ...parser, expose: false },
    { ...parser, expose: 'true' },
    { ...parser, status: 500 },
    { ...parser, status: 503 },
    { ...parser, status: 399 },
    { ...parser, status: '415' },
    { ...parser, status: 415.5 },
    { status: 415 },
    {},
    null,
    undefined,
    'charset.unsupported',
    415,
  ])
    assert.equal(requestFault(value, text), undefined, JSON.stringify(value) ?? String(value));
});
