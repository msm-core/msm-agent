/**
 * ConsoleDeliveryAdapter — Logs agent output to console for testing.
 */

import type { LoopOutcome } from "../core/types.js";
import type { DeliveryAdapter } from "../adapters/delivery.js";

export class ConsoleDeliveryAdapter implements DeliveryAdapter {
  private log: Array<{ sessionId: string; outcome: LoopOutcome }> = [];
  /** Pre-configured approval decisions for testing (taskId → approved) */
  private approvalDecisions = new Map<string, boolean | "pending">();

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
      case "waiting_approval":
        console.log(
          `[${sessionId}] ⏳ Waiting approval for: ${outcome.toolName}`,
        );
        break;
      case "error":
        console.log(`[${sessionId}] ❌ Error: ${outcome.error}`);
        break;
      case "custom":
        console.log(`[${sessionId}] ⚡ Custom action: ${outcome.action}`);
        break;
    }
  }

  async requestApproval(
    _sessionId: string,
    taskId: string,
    toolName: string,
    _toolParams: Record<string, unknown>,
    _reasoning: string,
  ): Promise<boolean | "pending"> {
    const decision = this.approvalDecisions.get(taskId);
    if (decision !== undefined) return decision;
    // Default: auto-approve for testing
    console.log(`[approval] Auto-approved ${toolName} for task ${taskId}`);
    return true;
  }

  async sendTyping(_sessionId: string): Promise<void> {
    // Silent in console mode
  }

  /** Test helper: pre-configure an approval decision */
  setApprovalDecision(taskId: string, decision: boolean | "pending"): void {
    this.approvalDecisions.set(taskId, decision);
  }

  /** Test helper: get all delivered outcomes */
  getLog(): Array<{ sessionId: string; outcome: LoopOutcome }> {
    return this.log;
  }

  /** Test helper: clear log */
  clear(): void {
    this.log = [];
    this.approvalDecisions.clear();
  }
}
