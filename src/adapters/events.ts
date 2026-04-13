/**
 * EventAdapter — How the agent receives work.
 *
 * Production implementations connect to message queues (BullMQ, SQS),
 * webhooks (WhatsApp, Telegram), and cron schedulers.
 * The dummy adapter is programmatic (manual trigger) for testing.
 */

import type { AgentEvent } from "../core/types.js";

export interface EventAdapter {
  /** Register a handler for incoming events */
  onEvent(handler: (event: AgentEvent) => Promise<void>): void;

  /** Start listening (open webhooks, connect queues, start cron) */
  start(): Promise<void>;

  /** Stop listening */
  stop(): Promise<void>;
}
