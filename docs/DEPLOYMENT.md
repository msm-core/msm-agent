# Deployment Reference

Complete deployment, HTTP API, ops dashboard, and configuration reference for `msm-agent`.

→ For adapter setup and brain integration, see [INTEGRATION-GUIDE.md](INTEGRATION-GUIDE.md).
→ For ownership boundaries and production checklist, see [production-readiness-and-boundary.md](production-readiness-and-boundary.md).

---

## Table of Contents

1. [Running as a Microservice](#1-running-as-a-microservice)
2. [HTTP API Reference](#2-http-api-reference)
3. [Ops Dashboard](#3-ops-dashboard)
4. [Configuration Reference](#4-configuration-reference)
5. [Guard System](#5-guard-system)

---

## 1. Running as a Microservice

### CLI

The CLI boots an HTTP server from any `.md` or `.it` agent definition file. All adapter wiring is automatic based on environment variables.

```bash
pnpm build

# Minimal — in-memory, for local testing only
AGENT_FILE=./examples/support-agent.md \
OPENAI_API_KEY=sk-... \
node dist/server/cli.js

# SQLite — single container, state survives restarts
AGENT_FILE=./agent.md \
MEMORY_PATH=/data/agent.db \
OPENAI_API_KEY=sk-... \
node dist/server/cli.js

# Full production stack
AGENT_FILE=./agent.md \
DATABASE_URL=postgresql://user:pass@db:5432/mydb \
REDIS_URL=redis://redis:6379 \
EVOLVING_MODE=assist \
DASHBOARD_PASSWORD=secret \
OPENAI_API_KEY=sk-... \
node dist/server/cli.js
```

### Docker Compose

```yaml
services:
  agent:
    build: .
    environment:
      AGENT_FILE: /agent/agent.md
      DATABASE_URL: postgresql://agent:secret@db:5432/agent
      REDIS_URL: redis://redis:6379
      EVOLVING_MODE: shadow
      DASHBOARD_PASSWORD: ${DASHBOARD_PASSWORD}
      OPENAI_API_KEY: ${OPENAI_API_KEY}
    volumes:
      - ./agent.md:/agent/agent.md:ro
    ports:
      - "3000:3000"
    depends_on: [db, redis]

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: agent
      POSTGRES_PASSWORD: secret
      POSTGRES_DB: agent
    volumes:
      - pgdata:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine

volumes:
  pgdata:
```

### Environment Variables

| Variable                  | Description                                             | Default                  |
| ------------------------- | ------------------------------------------------------- | ------------------------ |
| `AGENT_FILE`              | Path to agent definition (`.md` or `.it`)               | **required**             |
| `PORT`                    | HTTP server port                                        | `3000`                   |
| `HOST`                    | HTTP server host                                        | `0.0.0.0`                |
| `DATABASE_URL`            | PostgreSQL or MongoDB URL                               | in-memory                |
| `MEMORY_PATH`             | SQLite file path (overrides in-memory, dev default)     | in-memory                |
| `NEO4J_URL`               | Neo4j bolt URL (wraps primary with graph layer)         | disabled                 |
| `NEO4J_USER`              | Neo4j username                                          | `neo4j`                  |
| `NEO4J_PASSWORD`          | Neo4j password                                          | —                        |
| `REDIS_URL`               | Redis URL — activates RedisControlBus                   | InMemoryControlBus       |
| `EVOLVING_MODE`           | `off` / `shadow` / `assist` — self-improvement mode     | `off`                    |
| `ENABLE_JOBS`             | `true` — activates Jobs adapter and HTTP routes         | disabled                 |
| `ENABLE_MCP`              | `true` — activates MCP server                           | disabled                 |
| `MCP_TRANSPORT`           | `stdio` or `http`                                       | `stdio`                  |
| `MCP_PORT`                | MCP HTTP transport port                                 | `3001`                   |
| `DASHBOARD_PASSWORD`      | Enables ops dashboard at `/dashboard`                   | disabled                 |
| `OPENAI_API_KEY`          | OpenAI credentials                                      | —                        |
| `OPENAI_BASE_URL`         | OpenAI base URL override (Azure, proxy)                 | —                        |
| `ANTHROPIC_API_KEY`       | Anthropic credentials                                   | —                        |
| `OLLAMA_ENDPOINT`         | Ollama local server URL                                 | `http://localhost:11434` |
| `SOVEREIGN`               | `true` — blocks all external network calls at startup   | disabled                 |
| `WHATSAPP_GATEWAY_URL`    | Kader WhatsApp Gateway URL — activates WhatsApp channel | disabled                 |
| `WHATSAPP_TENANT_ID`      | Tenant ID in the WhatsApp Gateway                       | —                        |
| `WHATSAPP_ACCOUNT_ID`     | Account ID in the WhatsApp Gateway                      | —                        |
| `WHATSAPP_GATEWAY_KEY`    | Bearer key for the gateway API                          | —                        |
| `WHATSAPP_WEBHOOK_SECRET` | HMAC-SHA256 secret for inbound webhook verification     | —                        |

### Progression Path

**Prototype (< 1 hour):** `InMemoryAdapter` + `MockToolAdapter` + `ManualEventAdapter` + `ConsoleDeliveryAdapter` — everything in-memory, no external services.

**Working agent (1 day):** Replace `MemoryAdapter` with `PostgresMemoryAdapter` or `MongoMemoryAdapter`. Replace `ToolAdapter` with your real tools. Add `DeliveryAdapter` for your channel (WhatsApp, Telegram, API response).

**Production:** Add `REDIS_URL` for `RedisControlBus`. Switch to `BullMQEventAdapter` for durable queue ingress. Add `NEO4J_URL` for graph-enriched memory search. Set `EVOLVING_MODE=shadow` to start collecting quality data.

---

## 2. HTTP API Reference

All responses are JSON. All write endpoints require `Content-Type: application/json`.

### `GET /health`

Agent identity and readiness check.

```bash
curl http://localhost:3000/health
# { "status": "ok", "agent": "Support Agent", "domain": "...", "brain": {...} }
```

### `POST /v1/event`

Process any `AgentEvent` through the full agent loop. Stateful — `sessionId` connects to conversation history.

```bash
# User message
curl -X POST http://localhost:3000/v1/event \
  -H "Content-Type: application/json" \
  -d '{"type":"user_message","sessionId":"s1","text":"What is my order status?","modality":"text"}'

# Webhook from external system
curl -X POST http://localhost:3000/v1/event \
  -H "Content-Type: application/json" \
  -d '{"type":"webhook","sessionId":"s1","source":"stripe","payload":{"event":"payment.succeeded"}}'
```

### `POST /chat`

Stateless single-turn. Generates a fresh `sessionId` automatically. No conversation history between calls. Use for demos, testing, and one-shot queries.

```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "What are your business hours?"}'
# { "sessionId": "4a7b...", "outcome": { "type": "response", "text": "..." } }
```

### `GET /session/:id`

Conversation history and active task state for a session. Requires a persistent memory adapter.

```bash
curl http://localhost:3000/session/s1
# { "sessionId": "s1", "messages": [...], "activeTask": null }
```

### `POST /task/approve`

Human approval callback for gated tool calls. When a tool has `requiresApproval: true`, the loop pauses and waits. Call this to resume.

```bash
curl -X POST http://localhost:3000/task/approve \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"s1","taskId":"task-123","approved":true,"decidedBy":"ops@acme.com"}'
```

### `POST /webhook/whatsapp`

Inbound WhatsApp messages from the Kader WhatsApp Gateway. HMAC-SHA256 signature verified if `WHATSAPP_WEBHOOK_SECRET` is set. Enabled only when `WHATSAPP_GATEWAY_URL` is configured.

### Jobs Routes (requires `ENABLE_JOBS=true`)

```
POST   /jobs              → create a job
GET    /jobs              → list jobs (filter: ?status=running&sessionId=s1)
GET    /jobs/:id          → get job state
POST   /jobs/:id/cancel   → cancel a job
```

### Admin Routes (requires `DASHBOARD_PASSWORD`)

All admin routes require HTTP Basic Auth (username: empty, password: `DASHBOARD_PASSWORD`).

```
GET  /admin/state        → health + control bus state
POST /admin/control      → execute ControlCommand (kill_task, pause_tenant, …)
GET  /admin/memory?q=    → semantic memory search
```

---

## 3. Ops Dashboard

When `DASHBOARD_PASSWORD` is set, a self-contained ops panel is available at `GET /dashboard` on the same port as the API. No separate process, no build step, no external CDN.

```bash
DASHBOARD_PASSWORD=secret AGENT_FILE=./agent.md node dist/server/cli.js
# → open http://localhost:3000/dashboard
```

| Panel                 | Description                                                       |
| --------------------- | ----------------------------------------------------------------- |
| **Agent**             | Name, brain provider, model, capabilities list                    |
| **Pending Approvals** | Tasks awaiting human decision — Approve / Deny buttons            |
| **Control Bus**       | Kill task · Pause / resume tenant · Disable / enable tool         |
| **Memory Search**     | Full-text search of semantic memory (requires `search()` adapter) |
| **Session Inspector** | Look up any session — messages + active task state                |

The dashboard uses constant-time password comparison (`timingSafeEqual`) to prevent timing attacks.

---

## 4. Configuration Reference

Full `createAgent()` options:

```typescript
const agent = createAgent({
  // Required
  brain,    // Brain — any object with brain.run(input)
  memory,   // MemoryAdapter
  tools,    // ToolAdapter
  events,   // EventAdapter
  delivery, // DeliveryAdapter

  // Loop configuration
  config: {
    maxIterations: 6,        // Max loop iterations per event (default: 6)
    maxReplans: 2,           // Max plan retries before freestyle (default: 2)
    confidenceThreshold: 0.6, // Tool calls below this → clarification (default: 0.6)
    costCapPerTask: 0.5,     // USD limit per task, 0 = unlimited (default: 0)
    timeoutMs: 30_000,       // Wall-clock timeout, 0 = unlimited (default: 0)
    toolDedup: true,         // Deduplicate identical tool calls (default: true)
    maxToolCallsPerTask: 10, // Max tool calls per task, 0 = unlimited (default: 0)
  },

  // Optional
  controlBus,    // ControlBusAdapter — for kill/pause/disable at runtime
  evolving,      // EvolvingAdapter — NoneEvolvingAdapter (default) or MemoryEvolvingAdapter
  gates,         // GatesConfig — pre-processing gates (acknowledgement, business hours)
  tenantId,      // string — used in control bus checks
  equipmentBlock, // string — rendered equipment context block (from renderEquipmentBlock())

  // Fast-intent gate — return an outcome directly, skip the brain loop
  preHook: async (event) => {
    if (/^(hi|hello|hey)$/i.test(event.text)) {
      return { type: "response", text: "Hello! How can I help?", language: "en", payload: {} };
    }
    return null; // null → proceed to brain loop
  },

  // Custom history compaction (replace naive truncation with LLM summary)
  compactHistory: async (messages) => {
    const summary = await llm.summarize(messages.slice(0, -6));
    return [
      { role: "assistant", content: `[Summary] ${summary}` },
      ...messages.slice(-6),
    ];
  },

  // Observability
  onIteration: (state, step) => { metrics.record(step); },
  onGuard: (signal) => { logger.warn("Guard fired", signal); },

  // Cost tracking — extract USD cost from each brain response
  costExtractor: (payload) => payload.trace?.totalCostUsd ?? 0,

  // Hooks
  onPlanCreated: async (sessionId, plan) => { /* notify user plan is ready */ },
  onFatalError: async (sessionId, error) => "I apologize, something went wrong.",
  onInjectionDetected: async (sessionId, patterns) => null, // null = continue
});
```

### LoopOutcome Types

| Type            | When                                         | Key fields                                      |
| --------------- | -------------------------------------------- | ----------------------------------------------- |
| `response`      | Brain says respond / task complete           | `text`, `language`, `payload`                   |
| `clarification` | Brain asks a question or confidence too low  | `question`, `payload`                           |
| `escalated`     | Brain hands off to a human                   | `reason`, `payload`                             |
| `delegated`     | Brain routes to another agent role           | `targetRole`, `payload`                         |
| `aborted`       | Control bus killed the task or paused tenant | `taskId`, `reason`                              |
| `suppressed`    | Gate filtered the event (no delivery)        | `reason: "acknowledgement" \| "business_hours"` |
| `error`         | Brain returned malformed output              | `error`, `payload?`                             |
| `custom`        | Brain returned a non-standard action         | `action`, `payload`                             |

---

## 5. Guard System

Guards evaluate the agent's state every loop iteration and every tool call. Hard guards stop execution. Soft guards emit an advisory signal to `onGuard` for you to handle.

| Guard                | Type | Trigger                               | Response                          |
| -------------------- | ---- | ------------------------------------- | --------------------------------- |
| **Confidence Gate**  | Hard | Tool call with confidence < threshold | Converts to clarification request |
| **Iteration Budget** | Hard | iteration >= maxIterations            | Force-respond with last text      |
| **Cost Budget**      | Hard | totalCost >= costCapPerTask           | Force-respond                     |
| **Time Budget**      | Hard | elapsed >= timeoutMs                  | Force-respond                     |
| **Rate Limited**     | Hard | ToolAdapter.checkRateLimit() > 0      | Skip tool, continue loop          |
| **Tool Disabled**    | Hard | Control bus disabled this tool        | Skip tool, continue loop          |
| **Task Killed**      | Hard | Control bus killed this task          | Return `aborted` outcome          |
| **Tenant Paused**    | Hard | Control bus paused this tenant        | Return `aborted` outcome          |
| **Repetition**       | Soft | Same tool 3+ times consecutively      | Advisory signal via `onGuard`     |
| **Dead-End**         | Soft | 4+ failures across 2 or more tools    | Advisory signal via `onGuard`     |
