/**
 * Skills Adapter — Skill registry and tool resolution
 *
 * "Skills" are named, reusable tool packs that bundle related tools together.
 * Unlike equipment connectors (which require credentials and external API endpoints),
 * skills are in-process tool collections that need no configuration.
 *
 * This matches how frameworks like Semantic Kernel and Microsoft 365 Copilot use
 * the term "skill" — a named group of tools that can be activated for an agent.
 *
 * Usage:
 *   // 1. Register a skill once (at startup or in a plugin)
 *   SkillRegistry.register("booking", () => [{
 *     name: "booking_check_availability",
 *     description: "Check available time slots",
 *     execute: async (args) => { ... },
 *   }]);
 *
 *   // 2. Create the adapter from the agent definition's skill list
 *   const tools = SkillToolAdapter.create(def.skills, {}, base);
 *
 * Naming convention:
 *   Skill tools should be named "{skillName}_{action}" (e.g., "booking_check_availability").
 *   This is a convention, not enforced by the registry, but it prevents name collisions
 *   when multiple skills are active.
 *
 * Skills vs. Equipment Connectors:
 *   Connectors — external APIs that need credentials (Shopify, Fresha, HubSpot)
 *   Skills      — native/in-process tool groups, no credentials needed
 */

import type { ToolAdapter, ToolDefinition, ToolResult } from "./tools.js";

// ─── Skill tool definition ────────────────────────────────────

export interface SkillToolDef {
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

// ─── Skill factory ────────────────────────────────────────────

/**
 * Options passed to a skill factory at activation time.
 * Skills can accept optional configuration but are not required to.
 */
export type SkillOptions = Record<string, unknown>;

/**
 * Factory function that returns the tool definitions for a skill.
 * Called once per agent that activates the skill.
 */
export type SkillFactory = (options?: SkillOptions) => SkillToolDef[];

// ─── Registry ─────────────────────────────────────────────────

/**
 * Global skill registry.
 * Register skills at startup; the SkillToolAdapter resolves them.
 */
export const SkillRegistry = {
  _factories: new Map<string, SkillFactory>(),

  /**
   * Register a skill factory.
   * Called once per skill type, typically at startup.
   *
   * @param name Skill name identifier (e.g. "booking", "payments")
   * @param factory Function that returns tool definitions for this skill
   */
  register(name: string, factory: SkillFactory): void {
    this._factories.set(name.toLowerCase(), factory);
  },

  /**
   * Resolve a skill name to its tool definitions.
   * Returns [] if the name is not registered or the factory throws.
   */
  resolve(name: string, options?: SkillOptions): SkillToolDef[] {
    const factory = this._factories.get(name.toLowerCase());
    if (!factory) return [];
    try {
      return factory(options);
    } catch {
      return [];
    }
  },

  /** Check if a skill name is registered */
  has(name: string): boolean {
    return this._factories.has(name.toLowerCase());
  },

  /** Registered skill names */
  names(): string[] {
    return [...this._factories.keys()];
  },
} as const;

// ─── SkillToolAdapter ─────────────────────────────────────────

/**
 * A ToolAdapter that resolves an agent's skill list into tool definitions.
 *
 * Wraps an optional base adapter — skill tools are appended to (not replace)
 * the base adapter's catalog.
 */
export class SkillToolAdapter implements ToolAdapter {
  private _tools: ToolDefinition[];
  private _handlers: Map<
    string,
    (args: Record<string, unknown>) => Promise<unknown>
  >;

  private constructor(
    private readonly base: ToolAdapter | null,
    skillNames: string[],
    skillOptions: Record<string, SkillOptions>,
  ) {
    this._handlers = new Map();
    const toolDefs: ToolDefinition[] = [];

    for (const skillName of skillNames) {
      const lower = skillName.toLowerCase();
      if (!SkillRegistry.has(lower)) {
        console.warn(
          `[msm-agent] Skills: skill "${skillName}" is not registered — skipping`,
        );
        continue;
      }

      const tools = SkillRegistry.resolve(lower, skillOptions[lower]);
      for (const t of tools) {
        toolDefs.push({
          name: t.name,
          description: t.description,
          parameters: t.parameters ?? {},
          destructive: t.destructive,
          requiresApproval: t.requiresApproval,
          category: lower,
        });
        this._handlers.set(t.name, t.execute.bind(t));
      }
    }

    this._tools = toolDefs;
  }

  /**
   * Create a SkillToolAdapter from an agent's skill list.
   *
   * @param skillNames Skill names from AgentDefinition.skills
   * @param skillOptions Per-skill option bags keyed by skill name (optional)
   * @param base Optional base ToolAdapter — its tools are listed first and its
   *   execute() is tried before skill tools.
   */
  static create(
    skillNames: string[],
    skillOptions: Record<string, SkillOptions> = {},
    base: ToolAdapter | null = null,
  ): SkillToolAdapter {
    return new SkillToolAdapter(base, skillNames, skillOptions);
  }

  list(): ToolDefinition[] {
    const baseTools = this.base?.list() ?? [];
    // Deduplicate by name — base takes precedence
    const baseNames = new Set(baseTools.map((t) => t.name));
    const skillTools = this._tools.filter((t) => !baseNames.has(t.name));
    return [...baseTools, ...skillTools];
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

    // Try skill handler
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
        error: `Tool "${name}" not found in skills or base adapter`,
      },
    };
  }
}
