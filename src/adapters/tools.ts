/**
 * ToolAdapter — How the agent executes tools.
 *
 * Production implementations include tool catalogs, schema validation,
 * approval gates, dedup guards, and rate limiting.
 * The dummy adapter returns mock responses for testing.
 */

import type { ToolResult } from "../core/types.js";
export type { ToolResult };

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  /** Destructive tools get dedup protection (SHA-256 based idempotency) */
  destructive?: boolean;
  /** Tools requiring human approval before execution */
  requiresApproval?: boolean;
  /** Category for grouping (e.g. "crm", "booking", "knowledge") */
  category?: string;
  /** Rate limit for this tool (requests per minute/hour/day) */
  rateLimit?: ToolRateLimit;
}

export interface ToolRateLimit {
  requestsPerMinute?: number;
  requestsPerHour?: number;
  requestsPerDay?: number;
}

export interface ToolParameter {
  type: "string" | "number" | "boolean" | "object" | "array";
  description: string;
  required?: boolean;
  enum?: string[];
  default?: unknown;
}

export interface ToolAdapter {
  /** List available tools (brain uses these to decide what to call) */
  list(): ToolDefinition[];

  /**
   * Execute a tool by name with parameters.
   * @param signal Optional AbortSignal — if aborted mid-call, implementation
   *   should throw or return a failed result. Enables kill-task during execution.
   */
  execute(
    name: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult>;

  /** Optional: validate params before execution (multi-step validation) */
  validate?(
    name: string,
    params: Record<string, unknown>,
  ): ToolValidationResult;

  /** Optional: check rate limit before execution. Returns ms to wait, or 0 if ok. */
  checkRateLimit?(name: string): number;

  /**
   * Optional: distributed idempotency check.
   * Returns cached result if this exact call was already made (Redis NX pattern).
   * Use for cross-worker dedup of destructive operations.
   */
  checkIdempotency?(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<ToolResult | null>;

  /**
   * Optional: record a tool result for distributed idempotency.
   * Called after successful destructive tool execution.
   */
  recordIdempotency?(
    toolName: string,
    params: Record<string, unknown>,
    result: ToolResult,
  ): Promise<void>;
}

export interface ToolValidationResult {
  valid: boolean;
  errors: string[];
}
