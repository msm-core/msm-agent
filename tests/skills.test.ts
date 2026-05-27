import { describe, it, expect, beforeEach } from "vitest";
import { SkillRegistry, SkillToolAdapter } from "../src/adapters/skills.js";
import type { SkillToolDef, SkillOptions } from "../src/adapters/skills.js";
import type { ToolAdapter } from "../src/adapters/tools.js";
import { MockToolAdapter } from "../src/adapters-dummy/tools.js";

// ─── Helpers ──────────────────────────────────────────────────

function makeSkillTool(name: string, isWrite = false): SkillToolDef {
  return {
    name,
    description: `Skill tool: ${name}`,
    parameters: {
      input: { type: "string", description: "input", required: false },
    },
    destructive: isWrite,
    execute: async (args) => ({ tool: name, args }),
  };
}

// ─── SkillRegistry ────────────────────────────────────────────

describe("SkillRegistry", () => {
  beforeEach(() => {
    SkillRegistry._factories.clear();
  });

  it("register() and has() work", () => {
    expect(SkillRegistry.has("booking")).toBe(false);
    SkillRegistry.register("booking", () => []);
    expect(SkillRegistry.has("booking")).toBe(true);
  });

  it("has() is case-insensitive", () => {
    SkillRegistry.register("Booking", () => []);
    expect(SkillRegistry.has("BOOKING")).toBe(true);
    expect(SkillRegistry.has("booking")).toBe(true);
  });

  it("resolve() calls registered factory with options", () => {
    const received: Array<SkillOptions | undefined> = [];
    SkillRegistry.register("payments", (opts) => {
      received.push(opts);
      return [makeSkillTool("payments_create_invoice")];
    });

    const opts: SkillOptions = { currency: "USD" };
    const tools = SkillRegistry.resolve("payments", opts);

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("payments_create_invoice");
    expect(received[0]).toMatchObject({ currency: "USD" });
  });

  it("resolve() returns [] for unknown skill name", () => {
    const tools = SkillRegistry.resolve("nonexistent-skill");
    expect(tools).toEqual([]);
  });

  it("resolve() returns [] when factory throws", () => {
    SkillRegistry.register("broken", () => {
      throw new Error("factory explosion");
    });
    expect(() => SkillRegistry.resolve("broken")).not.toThrow();
    expect(SkillRegistry.resolve("broken")).toEqual([]);
  });

  it("names() returns registered skill names", () => {
    SkillRegistry.register("booking", () => []);
    SkillRegistry.register("payments", () => []);
    const names = SkillRegistry.names();
    expect(names).toContain("booking");
    expect(names).toContain("payments");
  });
});

// ─── SkillToolAdapter ─────────────────────────────────────────

describe("SkillToolAdapter", () => {
  beforeEach(() => {
    SkillRegistry._factories.clear();
  });

  it("list() returns empty when no skills registered or listed", () => {
    const adapter = SkillToolAdapter.create([]);
    expect(adapter.list()).toEqual([]);
  });

  it("list() returns tools from registered skills", () => {
    SkillRegistry.register("booking", () => [
      makeSkillTool("booking_check_availability"),
      makeSkillTool("booking_create"),
    ]);

    const adapter = SkillToolAdapter.create(["booking"]);
    const tools = adapter.list();
    expect(tools.map((t) => t.name)).toContain("booking_check_availability");
    expect(tools.map((t) => t.name)).toContain("booking_create");
  });

  it("list() merges tools from multiple skills", () => {
    SkillRegistry.register("booking", () => [
      makeSkillTool("booking_check_availability"),
    ]);
    SkillRegistry.register("payments", () => [
      makeSkillTool("payments_create_invoice"),
    ]);

    const adapter = SkillToolAdapter.create(["booking", "payments"]);
    const names = adapter.list().map((t) => t.name);
    expect(names).toContain("booking_check_availability");
    expect(names).toContain("payments_create_invoice");
  });

  it("list() skips unregistered skills with a warning", () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (msg: string) => warns.push(msg);

    const adapter = SkillToolAdapter.create(["unregistered-skill"]);
    expect(adapter.list()).toEqual([]);
    expect(warns.some((w) => w.includes("unregistered-skill"))).toBe(true);

    console.warn = orig;
  });

  it("execute() dispatches to skill handler", async () => {
    SkillRegistry.register("booking", () => [
      {
        name: "booking_check_availability",
        description: "Check slots",
        execute: async (args) => ({ available: true, args }),
      },
    ]);

    const adapter = SkillToolAdapter.create(["booking"]);
    const result = await adapter.execute("booking_check_availability", {
      date: "2026-06-01",
    });

    expect(result.status).toBe("success");
    expect(result.result).toMatchObject({ available: true });
  });

  it("execute() returns failed for unknown tool", async () => {
    const adapter = SkillToolAdapter.create([]);
    const result = await adapter.execute("nonexistent_tool", {});
    expect(result.status).toBe("failed");
    expect((result.result as { error: string }).error).toContain(
      "nonexistent_tool",
    );
  });

  it("execute() returns failed (not throws) when skill handler throws", async () => {
    SkillRegistry.register("fragile", () => [
      {
        name: "fragile_tool",
        description: "Throws on execute",
        execute: async () => {
          throw new Error("handler boom");
        },
      },
    ]);

    const adapter = SkillToolAdapter.create(["fragile"]);
    const result = await adapter.execute("fragile_tool", {});
    expect(result.status).toBe("failed");
    expect((result.result as { error: string }).error).toContain(
      "handler boom",
    );
  });

  it("list() deduplicates by name — base adapter takes precedence", () => {
    SkillRegistry.register("booking", () => [
      makeSkillTool("booking_check_availability"),
    ]);

    const base = new MockToolAdapter([
      {
        name: "booking_check_availability",
        description: "Base version wins",
        parameters: {},
      },
    ]);

    const adapter = SkillToolAdapter.create(["booking"], {}, base);
    const listed = adapter
      .list()
      .filter((t) => t.name === "booking_check_availability");
    expect(listed).toHaveLength(1);
    expect(listed[0].description).toBe("Base version wins");
  });

  it("execute() tries base adapter first for its own tools", async () => {
    SkillRegistry.register("booking", () => [makeSkillTool("shared_tool")]);

    // Inline minimal adapter — ToolAdapter only requires list() and execute()
    const base: ToolAdapter = {
      list: () => [
        { name: "shared_tool", description: "Base tool", parameters: {} },
      ],
      execute: async (name: string) => ({
        status: "success" as const,
        result: { from: "base", name },
      }),
    };

    const adapter = SkillToolAdapter.create(["booking"], {}, base);
    const result = await adapter.execute("shared_tool", {});
    expect(result.status).toBe("success");
    expect(result.result).toMatchObject({ from: "base" });
  });

  it("skill name lookup is case-insensitive", () => {
    SkillRegistry.register("Booking", () => [
      makeSkillTool("booking_check_availability"),
    ]);

    const adapter = SkillToolAdapter.create(["BOOKING"]);
    expect(adapter.list().map((t) => t.name)).toContain(
      "booking_check_availability",
    );
  });

  it("passes skill options to factory", () => {
    const received: Array<SkillOptions | undefined> = [];
    SkillRegistry.register("configurable", (opts) => {
      received.push(opts);
      return [makeSkillTool("configurable_action")];
    });

    SkillToolAdapter.create(["configurable"], {
      configurable: { region: "gulf" },
    });

    expect(received[0]).toMatchObject({ region: "gulf" });
  });
});

// ─── md-parser integration ────────────────────────────────────

describe("md-parser: ## Skills section", () => {
  it("parses skill names from bullet list", async () => {
    const { parseMdSource } = await import("../src/definition/md-parser.js");
    const source = `
# Test Agent

## Brain
Provider: custom

## Skills
- booking
- payments
- knowledge
`.trim();

    const def = parseMdSource(source);
    expect(def.skills).toEqual(["booking", "payments", "knowledge"]);
  });

  it("strips inline comments from skill names", async () => {
    const { parseMdSource } = await import("../src/definition/md-parser.js");
    const source = `
# Test Agent

## Brain
Provider: custom

## Skills
- booking          # check_availability, create_booking
- payments         # create_invoice, check_payment_status
`.trim();

    const def = parseMdSource(source);
    expect(def.skills).toEqual(["booking", "payments"]);
  });

  it("defaults to empty array when ## Skills section absent", async () => {
    const { parseMdSource } = await import("../src/definition/md-parser.js");
    const source = `
# Test Agent

## Brain
Provider: custom
`.trim();

    const def = parseMdSource(source);
    expect(def.skills).toEqual([]);
  });
});
