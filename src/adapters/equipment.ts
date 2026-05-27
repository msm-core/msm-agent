/**
 * Equipment Adapter — Connector registry and tool resolution
 *
 * Implements the "equipment" concept from Kader's EmployeeEquipment, adapted
 * for portable use without multi-tenancy coupling.
 *
 * Usage:
 *   // 1. Register a connector once (at startup or in a plugin)
 *   ConnectorRegistry.register("shopify", (config) => [{
 *     name: "orders.list",
 *     description: "List recent orders",
 *     parameters: { limit: { type: "number", description: "Max results" } },
 *     execute: async (args) => fetchShopifyOrders(config, args),
 *   }]);
 *
 *   // 2. Create the adapter from the agent definition
 *   const tools = EquipmentToolAdapter.create(def.equipment);
 *
 * The adapter wraps an optional base ToolAdapter so existing tools are not lost.
 * Equipment connectors are appended to the tool catalog.
 *
 * Credentials:
 *   Values like "${SHOPIFY_API_KEY}" are substituted from process.env at
 *   adapter creation time. Missing env vars produce a warning but do not crash.
 */

import type { ToolAdapter, ToolDefinition, ToolResult } from "./tools.js";
import type {
  AgentEquipment,
  EquipmentConnector,
} from "../definition/schema.js";

// ─── Connector contract ───────────────────────────────────────

export interface ConnectorToolDef {
  name: string;
  description: string;
  parameters?: Record<
    string,
    {
      type: "string" | "number" | "boolean" | "object" | "array";
      description: string;
      required?: boolean;
    }
  >;
  destructive?: boolean;
  requiresApproval?: boolean;
  /** Execute the tool. Returns any JSON-serializable value. */
  execute(args: Record<string, unknown>): Promise<unknown>;
}

export interface ResolvedConnectorConfig {
  type: string;
  operations: string[];
  access: "read" | "write" | "readwrite";
  endpoint?: string;
  credentials?: {
    type: "api_key" | "bearer" | "basic";
    value: string;
    headerName?: string;
  };
}

/** Factory function that receives the resolved connector config and returns tool definitions */
export type ConnectorFactory = (
  config: ResolvedConnectorConfig,
) => ConnectorToolDef[];

// ─── Registry ─────────────────────────────────────────────────

/**
 * Global connector registry.
 * Register connectors at startup; the EquipmentToolAdapter resolves them.
 */
export const ConnectorRegistry = {
  _factories: new Map<string, ConnectorFactory>(),

  /**
   * Register a connector factory.
   * Called once per connector type, typically at startup.
   *
   * @param type Connector type identifier (e.g. "shopify", "fresha")
   * @param factory Function that takes resolved config and returns tool definitions
   */
  register(type: string, factory: ConnectorFactory): void {
    this._factories.set(type.toLowerCase(), factory);
  },

  /**
   * Resolve a connector type to its tool definitions.
   * Returns [] if the type is not registered.
   */
  resolve(type: string, config: ResolvedConnectorConfig): ConnectorToolDef[] {
    const factory = this._factories.get(type.toLowerCase());
    if (!factory) return [];
    try {
      return factory(config);
    } catch {
      return [];
    }
  },

  /** Check if a connector type is registered */
  has(type: string): boolean {
    return this._factories.has(type.toLowerCase());
  },

  /** Registered connector types */
  types(): string[] {
    return [...this._factories.keys()];
  },
} as const;

// ─── Env-var substitution ─────────────────────────────────────

function resolveEnvValue(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
    const resolved = process.env[name];
    if (!resolved) {
      console.warn(
        `[msm-agent] Equipment: env var \${${name}} is not set — connector may fail`,
      );
    }
    return resolved ?? "";
  });
}

function resolveConnector(raw: EquipmentConnector): ResolvedConnectorConfig {
  return {
    type: raw.type,
    operations: raw.operations,
    access: raw.access,
    endpoint: raw.endpoint ? resolveEnvValue(raw.endpoint) : undefined,
    credentials: raw.credentials
      ? {
          type: raw.credentials.type,
          value: resolveEnvValue(raw.credentials.value),
          headerName: raw.credentials.headerName,
        }
      : undefined,
  };
}

// ─── EquipmentToolAdapter ─────────────────────────────────────

/**
 * A ToolAdapter that resolves an agent's equipment block into tool definitions.
 *
 * Wraps an optional base adapter — equipment tools are appended to (not replace)
 * the base adapter's catalog.
 */
export class EquipmentToolAdapter implements ToolAdapter {
  private _tools: ToolDefinition[];
  private _handlers: Map<
    string,
    (args: Record<string, unknown>) => Promise<unknown>
  >;

  private constructor(
    private readonly base: ToolAdapter | null,
    equipment: AgentEquipment,
  ) {
    this._handlers = new Map();
    const toolDefs: ToolDefinition[] = [];

    for (const connDef of equipment.connectors) {
      if (!ConnectorRegistry.has(connDef.type)) {
        console.warn(
          `[msm-agent] Equipment: connector "${connDef.type}" is not registered — skipping`,
        );
        continue;
      }

      const resolved = resolveConnector(connDef);
      const connTools = ConnectorRegistry.resolve(connDef.type, resolved);

      for (const t of connTools) {
        // Only include operations that are listed in the connector's operations scope
        // (empty operations = allow all)
        const isAllowed =
          connDef.operations.length === 0 ||
          connDef.operations.includes(t.name);
        if (!isAllowed) continue;

        // Enforce access level
        const isWrite = t.destructive || t.requiresApproval;
        if (connDef.access === "read" && isWrite) continue;

        toolDefs.push({
          name: t.name,
          description: t.description,
          parameters: t.parameters ?? {},
          destructive: t.destructive,
          requiresApproval: t.requiresApproval,
          category: connDef.type,
        });

        this._handlers.set(t.name, t.execute.bind(t));
      }
    }

    this._tools = toolDefs;
  }

  /**
   * Create an EquipmentToolAdapter from an agent's equipment definition.
   *
   * @param equipment Equipment block from AgentDefinition (optional)
   * @param base Optional base ToolAdapter — its tools are listed first and its
   *   execute() is tried before equipment tools.
   */
  static create(
    equipment: AgentEquipment | undefined,
    base: ToolAdapter | null = null,
  ): EquipmentToolAdapter {
    return new EquipmentToolAdapter(
      base,
      equipment ?? { connectors: [], channels: [], dedicatedTools: [] },
    );
  }

  list(): ToolDefinition[] {
    const baseTools = this.base?.list() ?? [];
    // Deduplicate by name — base takes precedence
    const baseNames = new Set(baseTools.map((t) => t.name));
    const equipmentTools = this._tools.filter((t) => !baseNames.has(t.name));
    return [...baseTools, ...equipmentTools];
  }

  async execute(
    name: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    // Try base adapter first
    if (this.base) {
      const baseTools = this.base.list();
      const inBase = baseTools.some((t) => t.name === name);
      if (inBase) {
        return this.base.execute(name, params, signal);
      }
    }

    // Try equipment connector
    const handler = this._handlers.get(name);
    if (handler) {
      try {
        const result = await handler(params);
        return {
          tool: name,
          status: "success",
          result: result as Record<string, unknown>,
        };
      } catch (err) {
        return {
          tool: name,
          status: "failed",
          result: { error: err instanceof Error ? err.message : String(err) },
        };
      }
    }

    return {
      tool: name,
      status: "failed",
      result: {
        error: `Tool "${name}" not found in equipment or base adapter`,
      },
    };
  }
}
