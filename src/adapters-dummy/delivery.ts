/**
 * ConsoleDeliveryAdapter — Logs agent output to console for testing.
 */

import type { LoopOutcome } from "../core/types.js";
import type { DeliveryAdapter } from "../adapters/delivery.js";

export class ConsoleDeliveryAdapter implements DeliveryAdapter {
  private log: Array<{ sessionId: string; outcome: LoopOutcome }> = [];

  async send(sessionId: string, outcome: LoopOutcome): Promise<void> {
    this.log.push({ sessionId, outcome });

    switch (outcome.type) {
      case "response":
        console.log(`[${sessionId}] 🤖 ${outcome.text}`);
        break;
      case "clarification":
        console.log(`[${sessionId}] ❓ ${outcome.question}`);
        break;
      case "escalated":
        console.log(`[${sessionId}] 🚨 Escalated: ${outcome.reason}`);
        break;
      case "delegated":
        console.log(`[${sessionId}] ➡️  Delegated to: ${outcome.targetRole}`);
        break;
      case "error":
        console.log(`[${sessionId}] ❌ Error: ${outcome.error}`);
        break;
      case "custom":
        console.log(`[${sessionId}] ⚡ Custom action: ${outcome.action}`);
        break;
    }
  }

  async sendTyping(sessionId: string): Promise<void> {
    // Silent in console mode
  }

  /** Test helper: get all delivered outcomes */
  getLog(): Array<{ sessionId: string; outcome: LoopOutcome }> {
    return this.log;
  }

  /** Test helper: clear log */
  clear(): void {
    this.log = [];
  }
}
