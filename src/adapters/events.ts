/**
 * EventAdapter — How the agent receives work.
 *
 * In dalil: BullMQ queues (10 queues), WhatsApp/Telegram webhooks, cron jobs.
 * In msm-agent: you bring your own. The dummy adapter is programmatic (manual trigger).
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
