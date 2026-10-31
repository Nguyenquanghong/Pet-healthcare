import amqp from 'amqplib';
type ProbeRun = { id: number; connection?: amqp.ChannelModel };
export type BrokerProbeConfig = {
  service: string;
  // queues: the consumer queues under BROKER_PREFIX and their retry queue suffixes (P03).
  queues?: { consumers: readonly string[]; retrySuffixes: readonly string[] };
  // How the readiness probe reaches the broker; tests inject a fake.
  connect?: (url: string, options: { timeout: number }) => Promise<amqp.ChannelModel>;
  timeoutMs: number;
  isStopping: () => boolean;
};
// Readiness of the broker, and the depth of the service's queues. -1 means unknown.
export class BrokerProbe {
  private probing: amqp.ChannelModel | undefined;
  private connecting: Promise<amqp.ChannelModel> | undefined;
  private probeRun = 0;
  queueReady = -1;
  dlqReady = -1;
  retryReady = -1;
  constructor(private readonly config: BrokerProbeConfig) {}
  // One connection serves every probe: a new one every 3 s per process is needless churn for the broker.
  // Probes that overlap (one past its deadline, the next already started) share one connect.
  private probeConnection(url: string) {
    if (this.probing) return Promise.resolve(this.probing);
    return (this.connecting ??= this.openProbeConnection(url).finally(() => {
      this.connecting = undefined;
    }));
  }
  private async openProbeConnection(url: string) {
    const connection = await (this.config.connect ?? amqp.connect)(url, { timeout: 500 });
    connection.on('error', () => {});
    if (this.config.isStopping()) {
      await connection.close().catch(() => {});
      throw new Error('RUNTIME_STOPPING');
    }
    connection.once('close', () => {
      if (this.probing === connection) this.probing = undefined;
    });
    return (this.probing = connection);
  }
  // Only the kept connection is closed: a late failure of an old probe must not take down the one a newer probe opened.
  private async dropProbeConnection(connection: amqp.ChannelModel | undefined) {
    if (!connection || this.probing !== connection) return;
    this.probing = undefined;
    await connection.close().catch(() => {});
  }
  close() {
    void this.dropProbeConnection(this.probing);
  }
  // A kept connection no longer fails fast through the connect timeout, so the whole probe has a deadline.
  // A probe past its deadline is superseded: whatever it learns afterwards is ignored.
  async run() {
    const url = process.env.BROKER_URL;
    if (!url || this.config.isStopping()) return false;
    const run: ProbeRun = { id: ++this.probeRun };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<boolean>(resolve => {
      timer = setTimeout(() => {
        if (this.probeRun === run.id) this.probeRun++;
        void this.dropProbeConnection(run.connection);
        resolve(false);
      }, this.config.timeoutMs);
    });
    try {
      return await Promise.race([this.probeBroker(url, run), expired]);
    } finally {
      clearTimeout(timer);
    }
  }
  private async probeBroker(url: string, run: ProbeRun) {
    const current = () => this.probeRun === run.id && !this.config.isStopping();
    try {
      const connection = (run.connection = await this.probeConnection(url));
      // Every probe makes a real round trip, so a connection that is held but no longer answered is not "up".
      // A missing queue closes its channel, so each check has its own.
      const channel = async () => {
        const opened = await connection.createChannel();
        opened.on('error', () => {});
        return opened;
      };
      await (await channel()).close();
      const prefix = process.env.BROKER_PREFIX;
      if (prefix && this.config.service !== 'core') {
        // -1 means unknown.
        const ready = async (name: string) => {
          const opened = await channel();
          try {
            return (await opened.checkQueue(prefix + '.' + name)).messageCount;
          } catch {
            return -1;
          } finally {
            await opened.close().catch(() => {});
          }
        };
        const total = async (names: readonly string[]) => {
          let sum = 0;
          for (const name of names) {
            if (!current()) return -1;
            const n = await ready(name);
            if (n < 0) return -1;
            sum += n;
          }
          return sum;
        };
        const consumers = this.config.queues?.consumers ?? [this.config.service],
          retry = this.config.queues?.retrySuffixes ?? [];
        const queue = await total(consumers),
          dlq = await total(consumers.map(c => c + '.dlq')),
          retrying = retry.length ? await total(consumers.flatMap(c => retry.map(s => c + s))) : -1;
        if (!current()) return false;
        this.queueReady = queue;
        this.dlqReady = dlq;
        this.retryReady = retrying;
      }
      return current();
    } catch {
      // The connection may be the broken part; the next probe opens a new one.
      if (current()) await this.dropProbeConnection(run.connection);
      return false;
    }
  }
}
