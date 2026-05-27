/**
 * AgentHub — Multi-agent host for a single company deployment.
 *
 * Creates a registry of named agents that share infrastructure (memory,
 * control bus, queue) but run independently. Events are routed by agent
 * name, making the URL the routing key:
 *
 *   POST /agents/feasibility/event   → agents["feasibility"].handleEvent()
 *   POST /agents/legal/event         → agents["legal"].handleEvent()
 *   GET  /health                     → status of all registered agents
 *
 * Usage:
 *
 *   const hub = createAgentHub({
 *     feasibility: createAgent({ brain: brain1, memory, tools: tools1, ... }),
 *     legal:       createAgent({ brain: brain2, memory, tools: tools2, ... }),
 *   });
 *
 *   // Shared infrastructure — instantiate once, pass to each createAgent call.
 *   // Sessions are namespaced by agentName prefix to prevent memory bleed:
 *   //   "feasibility::sess_abc" and "legal::sess_abc" are separate sessions.
 *
 * The hub itself has no opinion about which agent handles what — that's the
 * caller's responsibility (URL routing, event metadata, or a classifier agent).
 */

import type { AgentHandle, AgentEvent, LoopOutcome } from "./types.js";

export interface AgentHubHandle {
  /** All registered agents, keyed by name. */
  readonly agents: Readonly<Record<string, AgentHandle>>;

  /**
   * Route an event to a named agent.
   * Rejects if the agent name is not registered.
   */
  handleEvent(agentName: string, event: AgentEvent): Promise<LoopOutcome>;

  /**
   * List all registered agent names.
   */
  agentNames(): string[];
}

/**
 * Create a multi-agent hub from a map of named AgentHandles.
 *
 * Session namespace convention (recommended):
 *   Prefix sessionIds with the agent name before passing to handleEvent,
 *   e.g. `feasibility::${sessionId}`. This prevents memory bleed when
 *   multiple agents share the same MemoryAdapter instance.
 */
export function createAgentHub(
  agents: Record<string, AgentHandle>,
): AgentHubHandle {
  if (Object.keys(agents).length === 0) {
    throw new Error("createAgentHub: agents map must not be empty");
  }

  // Validate agent names — only safe URL path segment characters allowed.
  // This is enforced here so callers get a clear error at startup rather
  // than a confusing 404 at runtime.
  const invalidName = Object.keys(agents).find((name) =>
    /[^a-zA-Z0-9_-]/.test(name),
  );
  if (invalidName) {
    throw new Error(
      `createAgentHub: agent name "${invalidName}" contains invalid characters. ` +
        `Use only letters, digits, hyphens, and underscores.`,
    );
  }

  return {
    agents: Object.freeze({ ...agents }),

    agentNames(): string[] {
      return Object.keys(agents);
    },

    async handleEvent(
      agentName: string,
      event: AgentEvent,
    ): Promise<LoopOutcome> {
      const agent = agents[agentName];
      if (!agent) {
        throw new Error(
          `AgentHub: no agent registered as "${agentName}". ` +
            `Registered agents: ${Object.keys(agents).join(", ")}`,
        );
      }
      return agent.handleEvent(event);
    },
  };
}

/** Type guard — true when the value is an AgentHubHandle. */
export function isAgentHub(value: unknown): value is AgentHubHandle {
  return (
    typeof value === "object" &&
    value !== null &&
    "agents" in value &&
    "agentNames" in value &&
    typeof (value as AgentHubHandle).handleEvent === "function"
  );
}
