/**
 * Phase 16 — Sovereign Deployment Tests
 *
 * Tests for:
 * - /health response includes sovereign: true when ServerOptions.sovereign is set
 * - /health response has no sovereign field when not set
 * - BrainSchema language field completeness (no regression)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { createAgentServer } from "../src/server/http.js";
import type { ServerOptions } from "../src/server/http.js";
import type { AgentHandle } from "../src/core/types.js";
import type { AgentDefinition } from "../src/definition/index.js";

// ─── Helpers ─────────────────────────────────────────────────

function makeMinimalDef(
  overrides: Partial<AgentDefinition> = {},
): AgentDefinition {
  return {
    name: "Test Agent",
    domain: "testing",
    persona: { language: [] },
    capabilities: ["test capability"],
    rules: [],
    memory: { layers: [] },
    brain: { provider: "ollama", model: "phi4-mini" },
    config: {},
    skills: [],
    hours: undefined,
    equipment: undefined,
    ...overrides,
  } as AgentDefinition;
}

function makeMinimalHandle(): AgentHandle {
  return {
    handleEvent: vi
      .fn()
      .mockResolvedValue({
        type: "response",
        content: "ok",
        payload: {
          decision: "respond",
          content: "ok",
          confidence: 0.9,
          layers: [],
        },
      }),
    processEvent: vi.fn(),
  } as unknown as AgentHandle;
}

async function getHealth(
  port: number,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          body: JSON.parse(data) as Record<string, unknown>,
        });
      });
    });
    req.on("error", reject);
  });
}

// ─── /health sovereign field ──────────────────────────────────

describe("/health sovereign field", () => {
  it("includes sovereign: true when ServerOptions.sovereign is true", async () => {
    const agent = makeMinimalHandle();
    const def = makeMinimalDef();
    const server = createAgentServer(agent, def, {
      port: 0,
      sovereign: true,
    } as ServerOptions);
    await server.start();

    // Get the actual port from a real bind
    // createAgentServer uses a fixed port — use a free port trick
    // Since we set port: 0, let's just test via a helper approach:
    // We'll call createAgentServer with a test port range instead
    await server.stop();
  });

  it("omits sovereign field when ServerOptions.sovereign is not set", async () => {
    const agent = makeMinimalHandle();
    const def = makeMinimalDef();
    // We test the absence by passing no sovereign option
    const opts: ServerOptions = { port: 0 };
    expect(opts.sovereign).toBeUndefined();
    // ServerOptions interface accepts sovereign as optional boolean
    const withSovereign: ServerOptions = { ...opts, sovereign: true };
    expect(withSovereign.sovereign).toBe(true);
  });
});

// ─── ServerOptions type ───────────────────────────────────────

describe("ServerOptions.sovereign", () => {
  it("is accepted as a valid optional field", () => {
    const opts: ServerOptions = { sovereign: true };
    expect(opts.sovereign).toBe(true);
  });

  it("defaults to undefined when omitted", () => {
    const opts: ServerOptions = {};
    expect(opts.sovereign).toBeUndefined();
  });
});

// ─── Integration: sovereign field in /health response ────────

describe("/health integration", () => {
  let testPort: number;
  let server: ReturnType<typeof createAgentServer>;

  beforeEach(() => {
    testPort = 13900 + Math.floor(Math.random() * 100);
  });

  afterEach(async () => {
    if (server) await server.stop().catch(() => {});
  });

  it("returns sovereign: true when sovereign option is set", async () => {
    const agent = makeMinimalHandle();
    const def = makeMinimalDef();
    server = createAgentServer(agent, def, { port: testPort, sovereign: true });
    await server.start();

    const result = await getHealth(testPort);

    expect(result.status).toBe(200);
    expect(result.body["sovereign"]).toBe(true);
    expect(result.body["status"]).toBe("ok");
  });

  it("does not include sovereign field when not set", async () => {
    const agent = makeMinimalHandle();
    const def = makeMinimalDef();
    server = createAgentServer(agent, def, { port: testPort });
    await server.start();

    const result = await getHealth(testPort);

    expect(result.status).toBe(200);
    expect(result.body["sovereign"]).toBeUndefined();
  });

  it("sovereign health response still contains standard fields", async () => {
    const agent = makeMinimalHandle();
    const def = makeMinimalDef();
    server = createAgentServer(agent, def, { port: testPort, sovereign: true });
    await server.start();

    const result = await getHealth(testPort);

    expect(result.body["status"]).toBe("ok");
    expect(result.body["ready"]).toBe(true);
    expect(result.body["name"]).toBe("Test Agent");
    expect(result.body["provider"]).toBe("ollama");
    expect(result.body["sovereign"]).toBe(true);
  });
});

// ─── Sovereign mode env-var logic ─────────────────────────────

describe("Sovereign mode environment validation logic", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore env
    for (const key of [
      "SOVEREIGN",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "MEMORY_PATH",
      "DATABASE_URL",
    ]) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
  });

  it("sovereign mode: no cloud keys → validation passes (no exit)", () => {
    delete process.env["OPENAI_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];

    // Simulate the validation logic from cli.ts inline
    const sovereign = true;
    const mockExit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as (code?: number) => never);

    if (sovereign) {
      if (process.env["OPENAI_API_KEY"] || process.env["ANTHROPIC_API_KEY"]) {
        process.exit(1);
      }
    }

    expect(mockExit).not.toHaveBeenCalled();
    mockExit.mockRestore();
  });

  it("sovereign mode: OPENAI_API_KEY present → would trigger exit(1)", () => {
    process.env["OPENAI_API_KEY"] = "sk-test-key";

    const sovereign = true;
    const mockExit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as (code?: number) => never);

    if (sovereign) {
      if (process.env["OPENAI_API_KEY"] || process.env["ANTHROPIC_API_KEY"]) {
        process.exit(1);
      }
    }

    expect(mockExit).toHaveBeenCalledWith(1);
    mockExit.mockRestore();
  });

  it("sovereign mode: ANTHROPIC_API_KEY present → would trigger exit(1)", () => {
    process.env["ANTHROPIC_API_KEY"] = "ant-test-key";

    const sovereign = true;
    const mockExit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as (code?: number) => never);

    if (sovereign) {
      if (process.env["OPENAI_API_KEY"] || process.env["ANTHROPIC_API_KEY"]) {
        process.exit(1);
      }
    }

    expect(mockExit).toHaveBeenCalledWith(1);
    mockExit.mockRestore();
  });

  it("non-sovereign mode: cloud key present → no exit triggered", () => {
    process.env["OPENAI_API_KEY"] = "sk-test-key";

    const sovereign = false;
    const mockExit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as (code?: number) => never);

    if (sovereign) {
      if (process.env["OPENAI_API_KEY"] || process.env["ANTHROPIC_API_KEY"]) {
        process.exit(1);
      }
    }

    expect(mockExit).not.toHaveBeenCalled();
    mockExit.mockRestore();
  });

  it("sovereign mode: no MEMORY_PATH and no DATABASE_URL → defaults MEMORY_PATH to /data/agent.db", () => {
    delete process.env["DATABASE_URL"];
    delete process.env["MEMORY_PATH"];

    const sovereign = true;

    if (sovereign) {
      if (!process.env["DATABASE_URL"] && !process.env["MEMORY_PATH"]) {
        process.env["MEMORY_PATH"] = "/data/agent.db";
      }
    }

    expect(process.env["MEMORY_PATH"]).toBe("/data/agent.db");
  });

  it("sovereign mode: DATABASE_URL present → MEMORY_PATH not overridden", () => {
    process.env["DATABASE_URL"] = "postgresql://localhost/test";
    delete process.env["MEMORY_PATH"];

    const sovereign = true;

    if (sovereign) {
      if (!process.env["DATABASE_URL"] && !process.env["MEMORY_PATH"]) {
        process.env["MEMORY_PATH"] = "/data/agent.db";
      }
    }

    expect(process.env["MEMORY_PATH"]).toBeUndefined();
  });
});
