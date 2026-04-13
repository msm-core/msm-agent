/**
 * DeliveryAdapter — How the agent delivers responses to users.
 *
 * Production implementations connect to channels like WhatsApp (interactive
 * buttons/lists), Telegram, web widgets, or SSE dashboards.
 * The dummy adapter logs to console for testing.
 */

import type { LoopOutcome } from "../core/types.js";

export interface DeliveryAdapter {
  /** Deliver the agent's response to the user */
  send(sessionId: string, outcome: LoopOutcome): Promise<void>;

  /**
   * Request human approval before executing a destructive action.
   *
   * Two modes:
   *
   * 1. **Synchronous** (simple): Returns true/false immediately.
   *    Use for in-process approval UIs (web modals, CLI prompts).
   *
   * 2. **Async/Durable** (production): Returns "pending" and the loop
   *    pauses the task (waiting_approval). The external system (WhatsApp
   *    button callback, dashboard click) should send an approval_callback
   *    event to resume the task.
   *
   * If not implemented, tools with requiresApproval are executed without gate.
   */
  requestApproval?(
    sessionId: string,
    taskId: string,
    toolName: string,
    toolParams: Record<string, unknown>,
    reasoning: string,
  ): Promise<boolean | "pending">;

  /** Optional: send typing/processing indicator */
  sendTyping?(sessionId: string): Promise<void>;
}
