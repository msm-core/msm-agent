/**
 * RedisControlBus
 *
 * Production ControlBusAdapter backed by Redis.
 * Uses the `ioredis` package — install it first:
 *
 *   pnpm add ioredis
 *
 * Key conventions (all prefixed with `agent:`):
 *
 *   agent:task:killed:{taskId}       → reason string, TTL 7 days
 *   agent:tenant:paused:{tenantId}   → reason string, no TTL (until resumed)
 *   agent:tool:disabled:{toolName}   → reason string, no TTL (until enabled)
 *
 * Usage:
 *   const bus = await RedisControlBus.connect(process.env.REDIS_URL);
 *   // REDIS_URL: redis://localhost:6379
 *
 * Used alongside the ControlBusAdapter interface — checked every loop iteration.
 */

import type { ControlBusAdapter } from "./control-bus.js";
import type { ControlCommand } from "../core/types.js";

// ─── Minimal Redis type stub ──────────────────────────────────

interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  setex(key: string, seconds: number, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  quit(): Promise<unknown>;
}

// ─── TTL constants ────────────────────────────────────────────

const KILLED_TTL_SECS = 7 * 24 * 60 * 60; // 7 days — auto-expires after task window

// ─── Adapter ─────────────────────────────────────────────────

export class RedisControlBus implements ControlBusAdapter {
  private readonly redis: RedisLike;

  private constructor(redis: RedisLike) {
    this.redis = redis;
  }

  /**
   * Connect to Redis.
   *
   * @param url  Redis connection URL — redis://[:password@]host:port[/db]
   * @throws     If the `ioredis` package is not installed.
   */
  static async connect(url: string): Promise<RedisControlBus> {
    let Redis: new (url: string) => RedisLike;
    try {
      // @ts-expect-error — optional peer dep: pnpm add ioredis
      const mod = await import("ioredis");
      Redis = (mod.default ?? mod) as typeof Redis;
    } catch {
      throw new Error(
        "RedisControlBus requires the 'ioredis' package.\n" +
          "Install it: pnpm add ioredis",
      );
    }
    return new RedisControlBus(new Redis(url));
  }

  // ─── Checks (called every loop iteration) ─────────────────

  async isTaskKilled(taskId: string): Promise<string | null> {
    return this.redis.get(`agent:task:killed:${taskId}`);
  }

  async isTenantPaused(tenantId: string): Promise<string | null> {
    return this.redis.get(`agent:tenant:paused:${tenantId}`);
  }

  async isToolDisabled(toolName: string): Promise<string | null> {
    return this.redis.get(`agent:tool:disabled:${toolName}`);
  }

  // ─── Commands ─────────────────────────────────────────────

  async execute(command: ControlCommand): Promise<void> {
    switch (command.type) {
      case "pause_tenant":
        await this.redis.set(
          `agent:tenant:paused:${command.tenantId}`,
          command.reason,
        );
        break;

      case "resume_tenant":
        await this.redis.del(`agent:tenant:paused:${command.tenantId}`);
        break;

      case "kill_task":
        // Auto-expire so killed keys don't accumulate forever
        await this.redis.setex(
          `agent:task:killed:${command.taskId}`,
          KILLED_TTL_SECS,
          command.reason,
        );
        break;

      case "disable_tool":
        await this.redis.set(
          `agent:tool:disabled:${command.toolName}`,
          command.reason,
        );
        break;

      case "enable_tool":
        await this.redis.del(`agent:tool:disabled:${command.toolName}`);
        break;
    }
  }

  /** Close the Redis connection. Call on graceful shutdown. */
  async close(): Promise<void> {
    await this.redis.quit();
  }
}
