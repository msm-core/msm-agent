/**
 * Flush Gate — Fire-and-forget event buffering for durability.
 *
 * In dalil: Buffers events (tool results, metrics, audit entries) in memory,
 *           then atomically flushes to DB on a periodic timer.
 *           Prevents data loss if worker dies mid-iteration while avoiding
 *           per-event write latency.
 *
 * msm-agent implementation: Generic buffered emitter. Projects wire this
 * to their persistence layer (MongoDB, Postgres, Redis, etc.).
 */

export interface FlushGateOptions<T> {
  /** Function to persist a batch of items */
  flush: (items: T[]) => Promise<void>;
  /** Flush interval in ms (default: 2000) */
  intervalMs?: number;
  /** Maximum buffer size before forced flush (default: 100) */
  maxBufferSize?: number;
  /** Called when flush fails */
  onError?: (error: Error, items: T[]) => void;
}

export class FlushGate<T> {
  private buffer: T[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly flushFn: (items: T[]) => Promise<void>;
  private readonly intervalMs: number;
  private readonly maxBufferSize: number;
  private readonly onError?: (error: Error, items: T[]) => void;

  constructor(options: FlushGateOptions<T>) {
    this.flushFn = options.flush;
    this.intervalMs = options.intervalMs ?? 2000;
    this.maxBufferSize = options.maxBufferSize ?? 100;
    this.onError = options.onError;
  }

  /** Add an item to the buffer. Triggers immediate flush if buffer is full. */
  push(item: T): void {
    this.buffer.push(item);
    if (this.buffer.length >= this.maxBufferSize) {
      void this.flush();
    }
  }

  /** Start the periodic flush timer */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.intervalMs);
  }

  /** Stop the timer and flush remaining items */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  /** Flush all buffered items now */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    // Atomically swap buffer
    const batch = this.buffer;
    this.buffer = [];

    try {
      await this.flushFn(batch);
    } catch (err) {
      if (this.onError) {
        this.onError(
          err instanceof Error ? err : new Error(String(err)),
          batch,
        );
      }
      // Put items back at front of buffer for retry
      this.buffer = [...batch, ...this.buffer];
    }
  }

  /** Number of items currently buffered */
  get pending(): number {
    return this.buffer.length;
  }
}
