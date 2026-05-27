/**
 * MCP Server — Model Context Protocol Adapter
 *
 * Exposes the agent as an MCP server so that any MCP-compatible client
 * (Claude Desktop, Cursor, intenttext-mcp, etc.) can interact with it.
 *
 * Tools exposed:
 *   agent_chat            — send a message, receive agent response
 *   agent_approve_task    — approve or reject a pending task
 *   agent_search_memory   — search agent semantic memory (if available)
 *
 * Resources exposed:
 *   session://{sessionId} — conversation transcript for a session
 *   agent://definition    — agent identity / definition metadata
 *
 * Transports:
 *   stdio  — for CLI/IDE integrations (default)
 *   http   — StreamableHTTP on a dedicated port for server deployments
 *
 * Usage (programmatic):
 *   const { stop } = await createMcpServer(agent, def, { transport: "stdio" });
 *
 * Usage (via CLI):
 *   ENABLE_MCP=true MCP_TRANSPORT=stdio node dist/server/cli.js
 *   ENABLE_MCP=true MCP_TRANSPORT=http MCP_PORT=3001 node dist/server/cli.js
 *
 * Peer dependency: @modelcontextprotocol/sdk ^1.29.0
 */

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AgentHandle, LoopOutcome } from "../core/types.js";
import type { AgentDefinition } from "../definition/index.js";
import type { MemoryAdapter } from "../adapters/memory.js";

// ─── Public API ───────────────────────────────────────────────

export interface McpServerOptions {
  /**
   * Transport to use.
   * - "stdio"  — communicate via stdin/stdout (default; for CLI/IDE)
   * - "http"   — StreamableHTTP on `port` (for server deployments)
   */
  transport?: "stdio" | "http";

  /** HTTP port when transport === "http". Default: 3001 */
  port?: number;

  /** HTTP host when transport === "http". Default: "0.0.0.0" */
  host?: string;

  /** Memory adapter — required for agent_search_memory and session:// resource */
  memory?: MemoryAdapter;
}

export interface McpServerHandle {
  /** Shut down the MCP server and release all resources */
  stop(): Promise<void>;
}

/**
 * Start an MCP server that wraps the given agent.
 *
 * Dynamically imports @modelcontextprotocol/sdk — install it as a
 * peer dependency to enable this feature.
 */
export async function createMcpServer(
  agent: AgentHandle,
  def: AgentDefinition,
  opts: McpServerOptions = {},
): Promise<McpServerHandle> {
  const transport = opts.transport ?? "stdio";
  const port = opts.port ?? 3001;
  const host = opts.host ?? "0.0.0.0";

  // ── Dynamic import (optional peer dep) ──────────────────────
  // @ts-ignore — optional peer dependency
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  // @ts-ignore
  const {
    ListToolsRequestSchema,
    CallToolRequestSchema,
    ListResourcesRequestSchema,
    ReadResourceRequestSchema,
    // @ts-ignore
  } = await import("@modelcontextprotocol/sdk/types.js");

  // ── Create the MCP Server ────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  const server = new Server(
    { name: def.name, version: "0.1.0" },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
      instructions: [
        `You are connected to agent: "${def.name}".`,
        def.domain ? `Domain: ${def.domain}.` : "",
        def.capabilities.length > 0
          ? `Capabilities: ${def.capabilities.join(", ")}.`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    },
  ) as McpServerInstance;

  // ── Tool: list ───────────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "agent_chat",
        description:
          "Send a message to the agent and receive its response. Creates a new session if no sessionId is provided.",
        inputSchema: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "The message to send to the agent",
            },
            sessionId: {
              type: "string",
              description:
                "Optional session ID for conversation continuity. If omitted a new session is created.",
            },
          },
          required: ["message"],
        },
      },
      {
        name: "agent_approve_task",
        description:
          "Approve or reject a pending task that is awaiting human approval.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: {
              type: "string",
              description: "Session ID that owns the pending task",
            },
            taskId: {
              type: "string",
              description: "ID of the task to approve or reject",
            },
            approved: {
              type: "boolean",
              description: "true to approve, false to reject",
            },
            decidedBy: {
              type: "string",
              description:
                "Optional label for who made the decision (e.g. user name or role)",
            },
          },
          required: ["sessionId", "taskId", "approved"],
        },
      },
      {
        name: "agent_search_memory",
        description:
          "Search the agent's semantic memory for relevant information. Returns matching memory entries.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Natural language search query",
            },
            limit: {
              type: "number",
              description: "Maximum number of results to return (default: 5)",
            },
          },
          required: ["query"],
        },
      },
    ],
  }));

  // ── Tool: call ───────────────────────────────────────────────
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const typedReq = req as CallToolRequest;
    const { name, arguments: args } = typedReq.params;

    if (name === "agent_chat") {
      const { message, sessionId: rawSessionId } = args as {
        message: string;
        sessionId?: string;
      };
      const sessionId = rawSessionId ?? randomUUID();

      let outcome: LoopOutcome;
      try {
        outcome = await agent.handleEvent({
          type: "user_message",
          sessionId,
          text: message,
          modality: "text",
        });
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Agent error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ sessionId, outcome }, null, 2),
          },
        ],
      };
    }

    if (name === "agent_approve_task") {
      const { sessionId, taskId, approved, decidedBy } = args as {
        sessionId: string;
        taskId: string;
        approved: boolean;
        decidedBy?: string;
      };

      let outcome: LoopOutcome;
      try {
        outcome = await agent.handleEvent({
          type: "approval_callback",
          sessionId,
          taskId,
          approved,
          decidedBy,
        });
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Agent error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { sessionId, taskId, approved, outcome },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (name === "agent_search_memory") {
      const { query, limit = 5 } = args as { query: string; limit?: number };

      if (!opts.memory?.search) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Memory search is not available. No memory adapter with search support was provided.",
            },
          ],
        };
      }

      const entries = await opts.memory.search(query, limit);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(entries, null, 2),
          },
        ],
      };
    }

    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Unknown tool: ${name}`,
        },
      ],
    };
  });

  // ── Resources: list ──────────────────────────────────────────
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: "agent://definition",
        name: "Agent Definition",
        description:
          "The agent's identity, capabilities, rules, and configuration",
        mimeType: "application/json",
      },
      ...(opts.memory
        ? [
            {
              uri: "session://",
              name: "Session Transcript",
              description:
                "Conversation history for a session. Use URI session://{sessionId} to read a specific session.",
              mimeType: "application/json",
            },
          ]
        : []),
    ],
  }));

  // ── Resources: read ──────────────────────────────────────────
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const typedReq = req as ReadResourceRequest;
    const uri: string = typedReq.params.uri;

    if (uri === "agent://definition") {
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(def, null, 2),
          },
        ],
      };
    }

    if (uri.startsWith("session://")) {
      const sessionId = uri.slice("session://".length);
      if (!sessionId) {
        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify({
                error: "sessionId is required in URI: session://{sessionId}",
              }),
            },
          ],
        };
      }

      if (!opts.memory) {
        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify({ error: "No memory adapter available." }),
            },
          ],
        };
      }

      const messages = await opts.memory.getConversation(sessionId);
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify({ sessionId, messages }, null, 2),
          },
        ],
      };
    }

    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify({ error: `Unknown resource URI: ${uri}` }),
        },
      ],
    };
  });

  // ── Connect transport ────────────────────────────────────────
  if (transport === "stdio") {
    // @ts-ignore
    const { StdioServerTransport } =
      await import("@modelcontextprotocol/sdk/server/stdio.js");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);

    return {
      stop: async () => {
        await server.close();
      },
    };
  }

  // transport === "http" — StreamableHTTP
  // @ts-ignore
  const { StreamableHTTPServerTransport } =
    await import("@modelcontextprotocol/sdk/server/streamableHttp.js");

  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  const httpTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  await server.connect(httpTransport);

  const httpServer = createServer((req, res) => {
    // @ts-ignore — handleRequest accepts IncomingMessage / ServerResponse
    void httpTransport.handleRequest(req, res);
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(port, host, resolve);
  });

  return {
    stop: async () => {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
      await server.close();
    },
  };
}

// ─── Internal types (narrow what we need from the SDK) ───────

interface McpServerInstance {
  setRequestHandler(schema: unknown, handler: (req: unknown) => unknown): void;
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
}

interface CallToolRequest {
  params: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface ReadResourceRequest {
  params: {
    uri: string;
  };
}
