/**
 * MockToolAdapter — Returns simulated tool responses for testing.
 */

import type { ToolResult } from "../core/types.js";
import type {
  ToolAdapter,
  ToolDefinition,
  ToolValidationResult,
} from "../adapters/tools.js";

export interface MockToolResponse {
  status: "ok" | "failed";
  result: Record<string, unknown>;
  /** Simulate latency in ms */
  latencyMs?: number;
}

export class MockToolAdapter implements ToolAdapter {
  private definitions: ToolDefinition[];
  private responses: Map<string, MockToolResponse>;

  constructor(
    definitions: ToolDefinition[] = [],
    responses: Map<string, MockToolResponse> = new Map(),
  ) {
    this.definitions = definitions;
    this.responses = responses;
  }

  list(): ToolDefinition[] {
    return this.definitions;
  }

  async execute(
    name: string,
    _params: Record<string, unknown>,
    _signal?: AbortSignal,
  ): Promise<ToolResult> {
    const mock = this.responses.get(name);
    if (mock?.latencyMs) {
      await new Promise((r) => setTimeout(r, mock.latencyMs));
    }
    if (mock) {
      return { tool: name, status: mock.status, result: mock.result };
    }
    // Default: return a generic success
    return {
      tool: name,
      status: "ok",
      result: { message: `Mock ${name} executed` },
    };
  }

  validate(
    name: string,
    _params: Record<string, unknown>,
  ): ToolValidationResult {
    const def = this.definitions.find((t) => t.name === name);
    if (!def) {
      return { valid: false, errors: [`Unknown tool: ${name}`] };
    }
    return { valid: true, errors: [] };
  }

  /** Register a tool definition */
  addTool(def: ToolDefinition, response?: MockToolResponse): void {
    this.definitions.push(def);
    if (response) {
      this.responses.set(def.name, response);
    }
  }

  /** Set the mock response for a tool */
  setResponse(toolName: string, response: MockToolResponse): void {
    this.responses.set(toolName, response);
  }
}
