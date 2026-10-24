import { execFileSync } from 'node:child_process';

// Read-only infrastructure identity check, before any database client/write.
export function assertTestProject() {
  const ids = execFileSync('docker', ['compose', '-f', 'deploy/phase2/compose.test.yml', 'ps', '-q'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
  if (ids.length !== 4) throw new Error('Start exactly the dedicated four-container pet-phase2-p1-test project with npm run phase2:up');
  const expected = new Set(['postgres', 'rabbitmq', 'redis', 'blob']);
  for (const id of ids) {
    const info = JSON.parse(execFileSync('docker', ['inspect', id], { encoding: 'utf8' }))[0];
    const labels = info.Config.Labels;
    if (labels['com.docker.compose.project'] !== 'pet-phase2-p1-test' || !expected.delete(labels['com.docker.compose.service'])) throw new Error('Wrong Compose project/service');
    if (labels['com.docker.compose.service'] === 'postgres') {
      const bindings = info.HostConfig.PortBindings['5432/tcp'];
      if (bindings?.length !== 1 || bindings[0].HostIp !== '127.0.0.1' || bindings[0].HostPort !== '55432') throw new Error('Wrong rehearsal PostgreSQL endpoint');
    }
  }
  if (expected.size) throw new Error('Missing test infrastructure service');
}

// P03: each consumer declares one retry queue per delay, so teardown asks the broker
// for the queues of a run instead of listing names. brokerQueues: every queue under a
// prefix. topologyQueues: the given consumer queues with their DLQ and retry queues.
export function brokerQueues(prefix) {
  if (typeof prefix !== 'string' || !/^p[1-7]\.[A-Za-z0-9.-]{8,200}$/.test(prefix)) throw new Error('Invalid test queue scope');
  assertTestProject();
  const rows = JSON.parse(execFileSync('docker', ['compose','-f','deploy/phase2/compose.test.yml','exec','-T','rabbitmq','rabbitmqctl','list_queues','--formatter','json','name'], { encoding: 'utf8', timeout: 30000 }));
  return rows.map(q => q.name).filter(name => name.startsWith(prefix + '.')).sort();
}
export function topologyQueues(routes, consumerQueues) {
  const of = name => consumerQueues.some(q => name === q || name === q + '.dlq' || new RegExp('^' + q.replace(/[.-]/g, '\\$&') + '\\.retry\\.\\d+ms$').test(name));
  return brokerQueues(routes.exchange.replace(/\.events$/, '')).filter(of);
}

// AMQP checkQueue only reports ready messages. A worker can have zero ready
// messages while its SQL work/ACK is still in flight; killing it then requeues.
// Read broker counters before test teardown, without consuming/deleting data.
export async function waitForQueueIdle(names, timeoutMs = 15000) {
  if (!Array.isArray(names) || !names.length || names.some(n => typeof n !== 'string' || n.length > 200 || !/^p[1-7]\.[A-Za-z0-9.-]+$/.test(n))) throw new Error('Invalid test queue scope');
  assertTestProject();
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const rows = JSON.parse(execFileSync('docker', ['compose','-f','deploy/phase2/compose.test.yml','exec','-T','rabbitmq','rabbitmqctl','list_queues','--formatter','json','name','messages_ready','messages_unacknowledged'], { encoding:'utf8', timeout:30000 }));
    if (names.every(name => rows.some(q => q.name === name && q.messages_ready === 0 && q.messages_unacknowledged === 0))) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Test queues still have ready or unacknowledged messages');
}
