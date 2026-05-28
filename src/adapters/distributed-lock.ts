/**
 * DistributedLockAdapter
 *
 * Interface and implementations for distributed session locking.
 *
 * Problem: The in-process `SessionMutex` only prevents concurrent event
 * processing within a single process. When running multiple agent server
 * instances (horizontal scaling), two instances can process the same session
 * simultaneously, causing race conditions on task state.
 *
 * This module provides:
 *  - `DistributedLockAdapter` — interface for any lock backend
 *  - `InProcessLockAdapter`   — in-process implementation (default, same as SessionMutex)
 *  - `RedisDistributedLock`   — atomic Redis SET NX PX implementation
 *
 * Usage with Redis:
 *   const lock = await RedisDistributedLock.connect(process.env.REDIS_URL);
 *   const agent = createAgent({ ..., distributedLock: lock });
 *
 * Usage in tests / single-instance deployments:
 *   const agent = createAgent({ ... }); // InProcessLockAdapter used by default
 */

// ─── Interface ────────────────────────────────────────────────

/**
 * A handle returned by a successful lock acquisition.
 * Must be released when the critical section completes.
 */
export interface LockHandle {
  /**
   * Release the lock.
   * After calling this, other waiters can acquire the same key.
   */
  release(): Promise<void>;

  /**
   * Extend the lock TTL. Useful for long-running operations that might
   * exceed the initial TTL.
   *
   * @param ttlMs New TTL in milliseconds from now.
   */
  extend(ttlMs: number): Promise<void>;
}

/**
 * Adapter for acquiring distributed (or in-process) locks.
 *
 * `acquire()` returns null if the lock is held — callers must decide whether
 * to retry, queue, or reject. For the agent's session mutex behaviour (queue),
 * use `InProcessLockAdapter` or implement retry logic in the caller.
 */
export interface DistributedLockAdapter {
  /**
   * Attempt to acquire an exclusive lock on `key`.
   *
   * @param key   Lock identifier (e.g. session ID)
   * @param ttlMs Maximum time to hold the lock before auto-release
   * @returns     A `LockHandle` if acquired, or `null` if already held
   */
  acquire(key: string, ttlMs: number): Promise<LockHandle | null>;

  /**
   * Close the underlying connection (if any).
   */
  close?(): Promise<void>;
}

// ─── InProcessLockAdapter ─────────────────────────────────────

/**
 * In-process distributed lock — correct behaviour within a single process.
 *
 * Queues concurrent acquisitions for the same key rather than returning null,
 * matching the original `SessionMutex` behaviour.
 *
 * For single-instance deployments this is the default and requires no
 * additional dependencies.
 */
export class InProcessLockAdapter implements DistributedLockAdapter {
  private readonly _locks = new Map<string, Promise<void>>();

  async acquire(key: string, _ttlMs: number): Promise<LockHandle> {
    const prev = this._locks.get(key) ?? Promise.resolve();
    let releaseFn!: () => void;
    const next = new Promise<void>((resolve) => {
      releaseFn = resolve;
    });
    this._locks.set(key, next);

    await prev;

    return {
      release: async () => {
        releaseFn();
        if (this._locks.get(key) === next) {
          this._locks.delete(key);
        }
      },
      extend: async (_ttlMs: number) => {
        // In-process: TTL is not enforced — nothing to extend
      },
    };
  }
}

// ─── RedisDistributedLock ─────────────────────────────────────

interface RedisLike {
  set(
    key: string,
    value: string,
    mode: "NX",
    expiry: "PX",
    ms: number,
  ): Promise<"OK" | null>;
  eval(script: string, numkeys: number, ...args: string[]): Promise<unknown>;
  quit(): Promise<unknown>;
}

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

const EXTEND_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end
`;

/**
 * Redis-backed distributed lock using atomic SET NX PX.
 *
 * Requires the `ioredis` package:
 *   pnpm add ioredis
 *
 * Lock tokens are random UUIDs — safe for concurrent acquisitions across
 * multiple processes. The Lua scripts ensure atomic check-and-release /
 * check-and-extend, preventing lock theft.
 *
 * Note: `acquire()` returns `null` immediately if the lock is held.
 * For queued session behaviour (matching the in-process SessionMutex),
 * use `InProcessLockAdapter`. RedisDistributedLock is appropriate when
 * you want hard rejection of concurrent events rather than queuing.
 */
export class RedisDistributedLock implements DistributedLockAdapter {
  private readonly redis: RedisLike;
  private readonly prefix: string;

  private constructor(redis: RedisLike, prefix = "agent:lock:") {
    this.redis = redis;
    this.prefix = prefix;
  }

  /**
   * Connect to Redis and return a `RedisDistributedLock` instance.
   *
   * @param url    Redis URL — redis://[:password@]host:port[/db]
   * @param prefix Key prefix (default: `agent:lock:`)
   * @throws       If the `ioredis` package is not installed.
   */
  static async connect(
    url: string,
    prefix?: string,
  ): Promise<RedisDistributedLock> {
    let Redis: new (url: string) => RedisLike;
    try {
      // @ts-expect-error — optional peer dep: pnpm add ioredis
      const mod = await import("ioredis");
      Redis = (mod.default ?? mod) as typeof Redis;
    } catch {
      throw new Error(
        "RedisDistributedLock requires the 'ioredis' package.\n" +
          "Install it: pnpm add ioredis",
      );
    }
    return new RedisDistributedLock(new Redis(url), prefix);
  }

  async acquire(key: string, ttlMs: number): Promise<LockHandle | null> {
    const redisKey = `${this.prefix}${key}`;
    // Random token — only the holder can release
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const result = await this.redis.set(redisKey, token, "NX", "PX", ttlMs);
    if (result !== "OK") return null;

    return {
      release: async () => {
        await this.redis.eval(RELEASE_SCRIPT, 1, redisKey, token);
      },
      extend: async (newTtlMs: number) => {
        await this.redis.eval(
          EXTEND_SCRIPT,
          1,
          redisKey,
          token,
          String(newTtlMs),
        );
      },
    };
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
