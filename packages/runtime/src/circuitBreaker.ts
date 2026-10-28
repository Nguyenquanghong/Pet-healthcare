// Circuit Breaker for calls to another service. After `failureThreshold`
// consecutive failures the circuit opens: calls fail at once (CircuitOpenError)
// instead of each waiting for its own timeout. After `openMs` one probe call is let
// through (half-open); its success closes the circuit, its failure reopens it.
// Only failures of the dependency count (transport, timeout, 5xx, malformed reply):
// the caller's `isFailure` keeps business answers (401/403/404/422) as successes.
export type CircuitState = 'closed' | 'open' | 'half-open';

export class CircuitOpenError extends Error {
  constructor(readonly target: string) {
    super('CIRCUIT_OPEN');
  }
}

// Every breaker registers itself so the /metrics exporter can read its state (pet_circuit_*).
// Weak references: a breaker nobody uses any more drops out of the report.
const registry = new Set<WeakRef<CircuitBreaker>>();
export function circuitBreakers(): CircuitBreaker[] {
  const live: CircuitBreaker[] = [];
  for (const ref of registry) {
    const breaker = ref.deref();
    if (breaker) live.push(breaker);
    else registry.delete(ref);
  }
  return live;
}

export class CircuitBreaker {
  private current: CircuitState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private probing = false;
  readonly counters = { opened: 0, rejected: 0 };

  constructor(
    readonly target: string,
    private readonly failureThreshold = 5,
    private readonly openMs = 5000,
    private readonly now = () => Date.now(),
    private readonly report = (entry: Record<string, unknown>) => {
      process.stderr.write(JSON.stringify(entry) + '\n');
    },
  ) {
    if (
      !/^[a-z0-9-]{1,64}$/.test(target) ||
      !Number.isSafeInteger(failureThreshold) ||
      failureThreshold < 1 ||
      !Number.isSafeInteger(openMs) ||
      openMs < 1
    )
      throw new Error('INVALID_CIRCUIT_BREAKER');
    registry.add(new WeakRef(this));
  }

  get state(): CircuitState {
    return this.current === 'open' && this.now() - this.openedAt >= this.openMs ? 'half-open' : this.current;
  }

  async run<T>(work: () => Promise<T>, isFailure: (error: unknown) => boolean = () => true): Promise<T> {
    if (this.current === 'open') {
      if (this.now() - this.openedAt < this.openMs) {
        this.counters.rejected++;
        throw new CircuitOpenError(this.target);
      }
      this.move('half-open');
    }
    const probe = this.current === 'half-open';
    if (probe) {
      // One probe at a time; everyone else keeps failing fast until it answers.
      if (this.probing) {
        this.counters.rejected++;
        throw new CircuitOpenError(this.target);
      }
      this.probing = true;
    }
    try {
      const value = await work();
      this.succeeded();
      return value;
    } catch (error) {
      if (isFailure(error)) this.failed(probe);
      else this.succeeded();
      throw error;
    } finally {
      if (probe) this.probing = false;
    }
  }

  private succeeded() {
    this.failures = 0;
    if (this.current !== 'closed') this.move('closed');
  }

  private failed(probe: boolean) {
    this.failures++;
    if (probe || this.current !== 'closed' || this.failures >= this.failureThreshold) {
      this.openedAt = this.now();
      if (this.current !== 'open') {
        this.counters.opened++;
        this.move('open');
      }
    }
  }

  private move(next: CircuitState) {
    this.current = next;
    this.report({
      code: 'CIRCUIT_' + next.toUpperCase().replace('-', '_'),
      target: this.target,
      failures: this.failures,
    });
  }
}
