/**
 * BullMQEventAdapter
 *
 * Queue-based EventAdapter backed by BullMQ (Redis).
 * Use this when events arrive asynchronously through a job queue rather
 * than via HTTP (e.g. background workers, scheduled cron jobs, retryable tasks).
 *
 * Requires:
 *   pnpm add bullmq ioredis
 *
 * Usage:
 *   const adapter = await BullMQEventAdapter.connect({
 *     redisUrl: process.env.REDIS_URL,
 *     queueName: "agent-events",   // default
 *     concurrency: 5,              // parallel jobs (default: 1)
 *   });
 *
 *   // Push a job from anywhere in your application:
 *   await adapter.enqueue({
 *     type: "user_message",
 *     sessionId: "session-1",
 *     text: "Book me a table",
 *     modality: "text",
 *   });
 *
 *   // Wire into the agent and start:
 *   agent.events.onEvent(handler);
 *   await agent.events.start();
 *
 * Retry strategy:
 *   Failed jobs are retried up to 3 times with exponential back-off.
 *   After that, they land in the BullMQ failed queue for inspection.
 *
 * Cron scheduling:
 *   await adapter.schedule("daily-digest", { type: "cron_tick", ... }, "0 9 * * *");
 */

import type { EventAdapter } from "./events.js";
import type { AgentEvent } from "../core/types.js";

// ─── Minimal BullMQ type stubs ────────────────────────────────

interface BullJob {
  data: unknown;
}

interface BullWorker {
  close(): Promise<void>;
}

interface BullQueue {
  add(name: string, data: unknown, opts?: unknown): Promise<unknown>;
  upsertJobScheduler(
    id: string,
    repeat: { pattern: string },
    template: { name: string; data: unknown },
  ): Promise<unknown>;
  close(): Promise<void>;
}

type WorkerConstructor = new (
  name: string,
  processor: (job: BullJob) => Promise<void>,
  opts: unknown,
) => BullWorker;

type QueueConstructor = new (name: string, opts: unknown) => BullQueue;

// ─── Options ─────────────────────────────────────────────────

export interface BullMQEventAdapterOptions {
  /** Redis connection URL */
  redisUrl: string;
  /** Queue name (default: "agent-events") */
  queueName?: string;
  /** Max parallel jobs processed simultaneously (default: 1) */
  concurrency?: number;
}

// ─── Adapter ─────────────────────────────────────────────────

export class BullMQEventAdapter implements EventAdapter {
  private handler: ((event: AgentEvent) => Promise<void>) | null = null;
  private worker: BullWorker | null = null;

  private constructor(
    private readonly Queue: QueueConstructor,
    private readonly Worker: WorkerConstructor,
    private readonly queue: BullQueue,
    private readonly opts: Required<BullMQEventAdapterOptions>,
  ) {}

  /**
   * Connect to Redis and initialise the BullMQ queue.
   *
   * @throws  If `bullmq` or `ioredis` are not installed.
   */
  static async connect(
    opts: BullMQEventAdapterOptions,
  ): Promise<BullMQEventAdapter> {
    let BullMQModule: { Queue: QueueConstructor; Worker: WorkerConstructor };
    try {
      // @ts-expect-error — optional peer dep: pnpm add bullmq ioredis
      BullMQModule = (await import("bullmq")) as typeof BullMQModule;
    } catch {
      throw new Error(
        "BullMQEventAdapter requires the 'bullmq' package.\n" +
          "Install it: pnpm add bullmq ioredis",
      );
    }

    const { Queue, Worker } = BullMQModule;
    const connection = { url: opts.redisUrl };
    const queueName = opts.queueName ?? "agent-events";

    const queue = new Queue(queueName, { connection }) as BullQueue;

    const resolved: Required<BullMQEventAdapterOptions> = {
      redisUrl: opts.redisUrl,
      queueName,
      concurrency: opts.concurrency ?? 1,
    };

    return new BullMQEventAdapter(Queue, Worker, queue, resolved);
  }

  // ─── EventAdapter interface ────────────────────────────────

  onEvent(handler: (event: AgentEvent) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (!this.handler) {
      throw new Error(
        "BullMQEventAdapter: call onEvent(handler) before start()",
      );
    }
    const handler = this.handler;

    this.worker = new this.Worker(
      this.opts.queueName,
      async (job: BullJob) => {
        await handler(job.data as AgentEvent);
      },
      {
        connection: { url: this.opts.redisUrl },
        concurrency: this.opts.concurrency,
        // Retry config: 3 attempts with exponential back-off
        settings: { backoffStrategy: (attempt: number) => attempt * 2000 },
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: "exponential", delay: 2000 },
        },
      },
    ) as BullWorker;
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }

  // ─── Extra: push jobs from outside the agent ──────────────

  /**
   * Enqueue an agent event for async processing.
   * Call this from your webhook handlers, API routes, or scheduled tasks
   * instead of hitting POST /v1/event directly when you want queue semantics
   * (persistence, retries, back-pressure).
   */
  async enqueue(event: AgentEvent): Promise<void> {
    await this.queue.add(event.type, event, {
      removeOnComplete: 100,
      removeOnFail: 500,
    });
  }

  /**
   * Schedule a recurring event via cron expression.
   *
   * @param schedulerId  Unique ID for this schedule (idempotent — calling again updates it)
   * @param event        The AgentEvent to enqueue on each tick
   * @param cron         Cron expression e.g. "0 9 * * *" (every day at 9am)
   *
   * @example
   *   await adapter.schedule("daily-brief", { type: "cron_tick", sessionId: "system", ... }, "0 9 * * *");
   */
  async schedule(
    schedulerId: string,
    event: AgentEvent,
    cron: string,
  ): Promise<void> {
    await this.queue.upsertJobScheduler(
      schedulerId,
      { pattern: cron },
      { name: event.type, data: event },
    );
  }
}
