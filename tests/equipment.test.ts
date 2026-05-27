import { describe, it, expect, beforeEach } from "vitest";
import {
  ConnectorRegistry,
  EquipmentToolAdapter,
} from "../src/adapters/equipment.js";
import type {
  ConnectorToolDef,
  ResolvedConnectorConfig,
} from "../src/adapters/equipment.js";
import type { AgentEquipment } from "../src/definition/schema.js";

// ─── Helpers ──────────────────────────────────────────────────

function makeConnectorTool(name: string, isWrite = false): ConnectorToolDef {
  return {
    name,
    description: `Tool: ${name}`,
    parameters: {
      q: { type: "string", description: "query", required: false },
    },
    destructive: isWrite,
    execute: async (args) => ({ echoed: name, args }),
  };
}

// ─── ConnectorRegistry ────────────────────────────────────────

describe("ConnectorRegistry", () => {
  beforeEach(() => {
    // Clear state between tests
    ConnectorRegistry._factories.clear();
  });

  it("register() and has() work", () => {
    expect(ConnectorRegistry.has("shopify")).toBe(false);
    ConnectorRegistry.register("shopify", () => []);
    expect(ConnectorRegistry.has("shopify")).toBe(true);
  });

  it("resolve() calls registered factory with config", () => {
    const received: ResolvedConnectorConfig[] = [];
    ConnectorRegistry.register("shopify", (cfg) => {
      received.push(cfg);
      return [makeConnectorTool("orders.list")];
    });

    const cfg: ResolvedConnectorConfig = {
      type: "shopify",
      operations: [],
      access: "readwrite",
      endpoint: "https://shop.example.com",
      credentials: { type: "api_key", value: "sk-test" },
    };
    const tools = ConnectorRegistry.resolve("shopify", cfg);

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("orders.list");
    expect(received[0]).toMatchObject({ endpoint: "https://shop.example.com" });
  });

  it("resolve() returns [] for unknown connector type", () => {
    const tools = ConnectorRegistry.resolve("unknown-connector", {
      type: "unknown-connector",
      operations: [],
      access: "readwrite",
    });
    expect(tools).toEqual([]);
  });

  it("types() returns registered keys", () => {
    ConnectorRegistry.register("typeA", () => []);
    ConnectorRegistry.register("typeB", () => []);
    expect(ConnectorRegistry.types()).toContain("typea");
    expect(ConnectorRegistry.types()).toContain("typeb");
  });
});

// ─── EquipmentToolAdapter ─────────────────────────────────────

describe("EquipmentToolAdapter", () => {
  beforeEach(() => {
    ConnectorRegistry._factories.clear();
  });

  it("list() returns empty for empty equipment", () => {
    const adapter = EquipmentToolAdapter.create(undefined);
    expect(adapter.list()).toEqual([]);
  });

  it("list() returns tools from registered connector", () => {
    ConnectorRegistry.register("fresha", () => [
      makeConnectorTool("bookings.list"),
      makeConnectorTool("bookings.create", true),
    ]);

    const equipment: AgentEquipment = {
      connectors: [{ type: "fresha", operations: [], access: "readwrite" }],
      channels: [],
      dedicatedTools: [],
    };

    const adapter = EquipmentToolAdapter.create(equipment);
    const names = adapter.list().map((t) => t.name);
    expect(names).toContain("bookings.list");
    expect(names).toContain("bookings.create");
  });

  it("list() filters by operations scope", () => {
    ConnectorRegistry.register("fresha", () => [
      makeConnectorTool("bookings.list"),
      makeConnectorTool("bookings.create"),
      makeConnectorTool("customers.get"),
    ]);

    const equipment: AgentEquipment = {
      connectors: [
        {
          type: "fresha",
          operations: ["bookings.list"],
          access: "readwrite",
        },
      ],
      channels: [],
      dedicatedTools: [],
    };

    const adapter = EquipmentToolAdapter.create(equipment);
    const names = adapter.list().map((t) => t.name);
    expect(names).toContain("bookings.list");
    expect(names).not.toContain("bookings.create");
    expect(names).not.toContain("customers.get");
  });

  it("list() enforces read-only access (excludes destructive tools)", () => {
    ConnectorRegistry.register("shopify", () => [
      makeConnectorTool("orders.list", false),
      makeConnectorTool("orders.delete", true), // destructive
    ]);

    const equipment: AgentEquipment = {
      connectors: [{ type: "shopify", operations: [], access: "read" }],
      channels: [],
      dedicatedTools: [],
    };

    const adapter = EquipmentToolAdapter.create(equipment);
    const names = adapter.list().map((t) => t.name);
    expect(names).toContain("orders.list");
    expect(names).not.toContain("orders.delete");
  });

  it("execute() dispatches to connector tool", async () => {
    ConnectorRegistry.register("shopify", () => [
      {
        name: "orders.list",
        description: "List orders",
        execute: async (args) => ({ orders: ["A", "B"], args }),
      },
    ]);

    const equipment: AgentEquipment = {
      connectors: [{ type: "shopify", operations: [], access: "readwrite" }],
      channels: [],
      dedicatedTools: [],
    };

    const adapter = EquipmentToolAdapter.create(equipment);
    const result = await adapter.execute("orders.list", { limit: 10 });

    expect(result.status).toBe("success");
    expect(result.result).toMatchObject({ orders: ["A", "B"] });
  });

  it("execute() returns failed for unknown tool", async () => {
    const adapter = EquipmentToolAdapter.create(undefined);
    const result = await adapter.execute("does.not.exist", {});
    expect(result.status).toBe("failed");
    expect((result.result as { error: string }).error).toContain(
      "does.not.exist",
    );
  });

  it("execute() returns failed when connector tool throws", async () => {
    ConnectorRegistry.register("crashing", () => [
      {
        name: "bad.tool",
        description: "Crashes",
        execute: async () => {
          throw new Error("API down");
        },
      },
    ]);

    const equipment: AgentEquipment = {
      connectors: [{ type: "crashing", operations: [], access: "readwrite" }],
      channels: [],
      dedicatedTools: [],
    };

    const adapter = EquipmentToolAdapter.create(equipment);
    const result = await adapter.execute("bad.tool", {});
    expect(result.status).toBe("failed");
    expect((result.result as { error: string }).error).toBe("API down");
  });

  it("${ENV_VAR} substitution in endpoint and credentials", () => {
    const received: ResolvedConnectorConfig[] = [];
    ConnectorRegistry.register("myconn", (cfg) => {
      received.push(cfg);
      return [];
    });

    process.env["TEST_ENDPOINT"] = "https://api.example.com";
    process.env["TEST_API_KEY"] = "abc123";

    const equipment: AgentEquipment = {
      connectors: [
        {
          type: "myconn",
          operations: [],
          access: "readwrite",
          endpoint: "${TEST_ENDPOINT}",
          credentials: { type: "api_key", value: "${TEST_API_KEY}" },
        },
      ],
      channels: [],
      dedicatedTools: [],
    };

    EquipmentToolAdapter.create(equipment);

    expect(received[0].endpoint).toBe("https://api.example.com");
    expect(received[0].credentials?.value).toBe("abc123");

    delete process.env["TEST_ENDPOINT"];
    delete process.env["TEST_API_KEY"];
  });

  it("unregistered connector type is skipped (no error)", () => {
    const equipment: AgentEquipment = {
      connectors: [
        {
          type: "not-registered-connector",
          operations: [],
          access: "readwrite",
        },
      ],
      channels: [],
      dedicatedTools: [],
    };
    // Should not throw
    const adapter = EquipmentToolAdapter.create(equipment);
    expect(adapter.list()).toEqual([]);
  });
});
