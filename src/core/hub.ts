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
 * ## Session namespacing
 *
 * The hub ENFORCES session namespacing automatically. When an event
 * arrives for agent "feasibility" with sessionId "sess_abc", the hub
 * rewrites it to "feasibility::sess_abc" before passing to the agent.
 * This prevents cross-agent memory bleed when agents share a MemoryAdapter.
 *
 * Callers always use their own short sessionId; the hub handles scoping.
 *
 * ## Tenant ID (v0.5)
 *
 * Pass `tenantId` in `handleEvent()` options to scope control-bus checks
 * (pause/resume) per tenant. The hub stores no tenant state itself —
 * tenant management lives in the caller (e.g. Kader server).
 *
 * ## Dynamic provisioning
 *
 * Use `hub.provisionAgent()` and `hub.deprovisionAgent()` to add/remove
 * agents at runtime without a process restart. This is the lifecycle hook
 * Kader uses for tenant onboarding/offboarding.
 *
 * Usage:
 *
 *   const hub = createAgentHub({
 *     feasibility: createAgent({ brain: brain1, memory, tools: tools1, ... }),
 *     legal:       createAgent({ brain: brain2, memory, tools: tools2, ... }),
 *   });
 *
 *   // Provision a new agent at runtime
 *   hub.provisionAgent("hr", createAgent({ ... }));
 *
 *   // Shut down one agent cleanly
 *   await hub.deprovisionAgent("hr");
 *
 *   // Shut down the entire hub
 *   await hub.close();
 */

import type { AgentHandle, AgentEvent, LoopOutcome } from "./types.js";

/**
 * Optional metadata attached to an agent at provision time.
 * Used by the hub for tenant-scoped lifecycle management.
 */
export interface AgentHubMeta {
  /**
   * The tenant this agent belongs to.
   * When set, `hub.agentsByTenant(tenantId)` and
   * `hub.deprovisionTenant(tenantId)` use this to identify the agent.
   */
  tenantId?: string;
  /** Human-readable label for dashboards / logs. */
  description?: string;
}

export interface AgentHubHandle {
  /** All registered agents, keyed by name (snapshot — may be stale after provision/deprovision). */
  readonly agents: Readonly<Record<string, AgentHandle>>;

  /**
   * Route an event to a named agent.
   * Automatically namespaces the sessionId as `agentName::sessionId`.
   * Rejects if the agent name is not registered.
   *
   * @param agentName  Registered agent name.
   * @param event      The event to dispatch.
   */
  handleEvent(agentName: string, event: AgentEvent): Promise<LoopOutcome>;

  /**
   * List all currently registered agent names.
   */
  agentNames(): string[];

  /**
   * Register a new agent at runtime.
   * Throws if an agent with the same name is already registered.
   * Use deprovisionAgent first if you need to replace an agent.
   *
   * @param meta  Optional metadata (e.g. `tenantId`) for tenant-scoped lifecycle management.
   */
  provisionAgent(name: string, agent: AgentHandle, meta?: AgentHubMeta): void;

  /**
   * Stop and remove a registered agent.
   * Calls agent.stop() and agent.close() before removal.
   * No-op if the agent name is not registered.
   */
  deprovisionAgent(name: string): Promise<void>;

  /**
   * Return the names of all agents whose `meta.tenantId` matches.
   * Returns [] if no agents are registered for that tenant.
   */
  agentsByTenant(tenantId: string): string[];

  /**
   * Stop and remove all agents belonging to a given tenant.
   * Equivalent to calling `deprovisionAgent()` for each agent returned
   * by `agentsByTenant(tenantId)`. Safe to call if no agents match.
   */
  deprovisionTenant(tenantId: string): Promise<void>;

  /**
   * Gracefully shut down all registered agents and release resources.
   * Calls deprovisionAgent() for every registered agent in parallel.
   */
  close(): Promise<void>;
}

/** Validate an agent name — only safe URL-path characters allowed. */
function validateAgentName(name: string): void {
  if (/[^a-zA-Z0-9_-]/.test(name)) {
    throw new Error(
      `AgentHub: agent name "${name}" contains invalid characters. ` +
        `Use only letters, digits, hyphens, and underscores.`,
    );
  }
}

/**
 * Rewrite the sessionId in an event to namespace it under the agent name.
 * "sess_abc" for agent "support" becomes "support::sess_abc".
 * Events without a sessionId (e.g. cron) pass through unchanged.
 */
function namespaceEvent(agentName: string, event: AgentEvent): AgentEvent {
  const e = event as Record<string, unknown>;
  if (typeof e["sessionId"] === "string") {
    return {
      ...event,
      sessionId: `${agentName}::${e["sessionId"]}`,
    } as AgentEvent;
  }
  return event;
}

/**
 * Create a multi-agent hub from an initial map of named AgentHandles.
 */
export function createAgentHub(
  initialAgents: Record<string, AgentHandle>,
): AgentHubHandle {
  if (Object.keys(initialAgents).length === 0) {
    throw new Error("createAgentHub: agents map must not be empty");
  }

  for (const name of Object.keys(initialAgents)) {
    validateAgentName(name);
  }

  // Internal mutable registry — exposed as a frozen snapshot via .agents getter.
  const registry = new Map<string, { agent: AgentHandle; meta: AgentHubMeta }>(
    Object.entries(initialAgents).map(([name, agent]) => [
      name,
      { agent, meta: {} },
    ]),
  );

  const hub: AgentHubHandle = {
    get agents(): Readonly<Record<string, AgentHandle>> {
      return Object.freeze(
        Object.fromEntries(
          Array.from(registry.entries()).map(([k, v]) => [k, v.agent]),
        ),
      );
    },

    agentNames(): string[] {
      return Array.from(registry.keys());
    },

    async handleEvent(
      agentName: string,
      event: AgentEvent,
    ): Promise<LoopOutcome> {
      const entry = registry.get(agentName);
      if (!entry) {
        throw new Error(
          `AgentHub: no agent registered as "${agentName}". ` +
            `Registered agents: ${Array.from(registry.keys()).join(", ")}`,
        );
      }
      // Enforce session namespacing to prevent cross-agent memory bleed.
      return entry.agent.handleEvent(namespaceEvent(agentName, event));
    },

    provisionAgent(
      name: string,
      agent: AgentHandle,
      meta: AgentHubMeta = {},
    ): void {
      validateAgentName(name);
      if (registry.has(name)) {
        throw new Error(
          `AgentHub.provisionAgent: agent "${name}" is already registered. ` +
            `Call deprovisionAgent("${name}") first.`,
        );
      }
      registry.set(name, { agent, meta });
    },

    async deprovisionAgent(name: string): Promise<void> {
      const entry = registry.get(name);
      if (!entry) return;
      registry.delete(name);
      await entry.agent.stop().catch(() => {});
      await entry.agent.close().catch(() => {});
    },

    agentsByTenant(tenantId: string): string[] {
      return Array.from(registry.entries())
        .filter(([, v]) => v.meta.tenantId === tenantId)
        .map(([name]) => name);
    },

    async deprovisionTenant(tenantId: string): Promise<void> {
      await Promise.all(
        hub.agentsByTenant(tenantId).map((name) => hub.deprovisionAgent(name)),
      );
    },

    async close(): Promise<void> {
      await Promise.all(
        Array.from(registry.keys()).map((name) => hub.deprovisionAgent(name)),
      );
    },
  };

  return hub;
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
