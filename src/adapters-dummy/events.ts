/**
 * ManualEventAdapter — Programmatic event trigger for testing.
 * No queues, no webhooks — just call handleEvent() directly.
 */

import type { AgentEvent } from "../core/types.js";
import type { EventAdapter } from "../adapters/events.js";

export class ManualEventAdapter implements EventAdapter {
  private handler: ((event: AgentEvent) => Promise<void>) | null = null;

  onEvent(handler: (event: AgentEvent) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    // No-op — manual adapter is always ready
  }

  async stop(): Promise<void> {
    this.handler = null;
  }

  /** Manually trigger an event (for testing) */
  async emit(event: AgentEvent): Promise<void> {
    if (!this.handler) {
      throw new Error("No event handler registered. Call agent.start() first.");
    }
    await this.handler(event);
  }
}
