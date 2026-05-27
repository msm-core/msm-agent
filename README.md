# msm-agent

**msm-agent** is a portable AI agent runtime. Write one file describing who your agent is, run one command, and get a production-ready AI agent with an HTTP API, WhatsApp integration, semantic memory, and a self-improving feedback loop — no framework knowledge required.

```bash
npm install msm-agent
```

The agent is the **hands** — it receives events, asks the brain what to do, executes tools, feeds results back, and delivers responses. The brain (LLM) only decides; it never executes. This separation is what makes the runtime safe, testable, and independently deployable.

```
A product manager writes support-agent.md in 10 minutes.
A developer runs docker run -v ./support-agent.md msm-agent.
Done.
```

---

## Table of Contents

1. [The Agent Definition File](#1-the-agent-definition-file)
2. [Quick Start](#2-quick-start)
3. [Architecture](#3-architecture)
4. [How It Works — The Execution Loop](#4-how-it-works--the-execution-loop)
5. [The 5 Adapter Interfaces](#5-the-5-adapter-interfaces)
6. [Brain Integration](#6-brain-integration)
7. [Production Adapters](#7-production-adapters)
8. [Equipment — Connected External Systems](#8-equipment--connected-external-systems)
9. [Skills — Reusable In-Process Tool Packs](#9-skills--reusable-in-process-tool-packs)
10. [Pre-Processing Gates](#10-pre-processing-gates)
11. [Quality Scoring and Self-Improvement](#11-quality-scoring-and-self-improvement)
12. [Arabic-Native Routing](#12-arabic-native-routing)
13. [Sovereign Deployment — Zero Cloud](#13-sovereign-deployment--zero-cloud)
14. [Deeper Evolving Layer — Signal Decay & Contradiction Detection](#14-deeper-evolving-layer--signal-decay--contradiction-detection)
15. [Jobs and Missions](#15-jobs-and-missions)
16. [MCP Server](#16-mcp-server)
17. [Running as a Microservice](#17-running-as-a-microservice) — [full guide →](docs/DEPLOYMENT.md)
18. [HTTP API Reference](#18-http-api-reference) — [full reference →](docs/DEPLOYMENT.md#2-http-api-reference)
19. [Ops Dashboard](#19-ops-dashboard) — [details →](docs/DEPLOYMENT.md#3-ops-dashboard)
20. [Configuration Reference](#20-configuration-reference) — [full options →](docs/DEPLOYMENT.md#4-configuration-reference)
21. [Guard System](#21-guard-system) — [reference →](docs/DEPLOYMENT.md#5-guard-system)
22. [Testing](#22-testing)
23. [License](#23-license)

---

## 1. The Agent Definition File

An agent is defined in a single `.md` file. No YAML, no code, no configuration objects. The runtime parses the file and compiles it into a validated configuration.

```markdown
# Support Agent

Domain: E-commerce customer support
Language: Arabic and English

## Persona

Name: Nour
Style: warm, direct, solution-focused

## Capabilities

- answer product questions
- check order status
- create support tickets
- escalate billing disputes to human

## Brain

provider: openai
model: gpt-4o-mini

## Limits

maxIterations: 6
confidenceThreshold: 0.7
costCapPerTask: 0.05

## Hours

Timezone: Asia/Qatar
Mon-Fri: 09:00-18:00
Sat: 10:00-14:00
Message: We are currently closed. We'll respond first thing in the morning.

## Skills

- booking
- payments

## Equipment

connectors:

- type: shopify
  operations: [orders.list, customers.get]
  access: read
  endpoint: ${SHOPIFY_ENDPOINT}
  credentials:
  type: api_key
  value: ${SHOPIFY_API_KEY}
  dedicatedTools: [generate_quote, escalate_to_human]
```

The runtime compiles this into your agent. Every section is optional. You can start with just a name, a persona, and a brain — and add capabilities incrementally.

If you prefer a more structured, machine-queryable format, the same definition works as an IntentText `.it` file. The runtime auto-detects the format.

---

## 2. Quick Start

### Option A — Docker (zero code)

```bash
# Write your agent definition (see section 1)
cat > support-agent.md << 'EOF'
# Support Agent
Domain: Customer support
Language: English

## Persona
Name: Alex
Style: helpful and direct

## Brain
provider: openai
model: gpt-4o-mini
EOF

# Run
docker run \
  -e AGENT_FILE=/agent/support-agent.md \
  -e OPENAI_API_KEY=sk-... \
  -v ./support-agent.md:/agent/support-agent.md:ro \
  -p 3000:3000 \
  msm-agent

# Talk to it
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "What are your business hours?"}'
```

### Option B — Node.js (embedded in your project)

```typescript
import {
  createAgent,
  loadAgent,
  buildBrain,
  InMemoryAdapter,
  MockToolAdapter,
  ManualEventAdapter,
  ConsoleDeliveryAdapter,
} from "msm-agent";

// Load the definition file
const def = await loadAgent("./support-agent.md");

// Create the agent
const agent = createAgent({
  brain: buildBrain(def), // reads OPENAI_API_KEY from env
  memory: new InMemoryAdapter(),
  tools: new MockToolAdapter(),
  events: new ManualEventAdapter(),
  delivery: new ConsoleDeliveryAdapter(),
  config: def.config,
});

// Handle an event
const outcome = await agent.handleEvent({
  type: "user_message",
  sessionId: "session-1",
  text: "What is the status of my order?",
  modality: "text",
});

console.log(outcome.type); // "response" | "clarification" | "escalated" | ...
```

### With MSM Brain

If you use [msm-ai](https://github.com/msm-core/msm-ai) as your brain (the 6-layer prompt pipeline):

```typescript
import { wrapMSM } from "msm-agent/bridge/msm";
import { createPipeline } from "msm-ai";

const pipeline = await createPipeline("./support.yaml");
const brain = wrapMSM(pipeline);
const agent = createAgent({ brain, ...adapters });
```

---

## 3. Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│  AGENT DEFINITION FILE  (support-agent.md or support-agent.it)    │
│                                                                   │
│  Persona · Capabilities · Brain · Limits · Hours ·                │
│  Skills · Equipment · Memory rules                                │
└─────────────────────────────┬─────────────────────────────────────┘
                              │  loadAgent()
                              ▼
┌───────────────────────────────────────────────────────────────────┐
│  msm-agent runtime                                                │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  Pre-Processing Gates (zero LLM cost)                       │  │
│  │  Acknowledgement gate · Business hours gate                 │  │
│  └──────────────────────────┬──────────────────────────────────┘  │
│                             │                                     │
│  ┌──────────────────────────▼──────────────────────────────────┐  │
│  │  Execution Loop                                             │  │
│  │                                                             │  │
│  │  event → context builder → brain → guards → dispatch:      │  │
│  │    respond / escalate / clarify / delegate → deliver        │  │
│  │    use_tool → validate → dedup → execute → loop             │  │
│  │                                                             │  │
│  │  + session mutex (prevents race conditions)                 │  │
│  │  + pre-hook (fast-intent short-circuit)                     │  │
│  │  + plan tracking (create / advance / replan / freestyle)    │  │
│  │  + control bus (kill / pause / disable per iteration)       │  │
│  │  + tool dedup (same call → cached result)                   │  │
│  │  + strict tool validation (abort on bad reasoning)          │  │
│  │  + flush gate (buffered async writes)                       │  │
│  └──────────────────────────┬──────────────────────────────────┘  │
│                             │                                     │
│  ┌──────────────────────────▼──────────────────────────────────┐  │
│  │  Quality Scoring (zero LLM cost)                            │  │
│  │  scoreOutcome() → resolution · efficiency · error rate      │  │
│  └──────────────────────────┬──────────────────────────────────┘  │
│                             │                                     │
│  ┌──────────────────────────▼──────────────────────────────────┐  │
│  │  Evolving Layer                                             │  │
│  │  postOutcome() writes · preReason() injects hints           │  │
│  │  refreshStrategies() computes improvement notes             │  │
│  └──────────────────────────┬──────────────────────────────────┘  │
└─────────────────────────────┼─────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
  ┌───────────────┐  ┌────────────────┐  ┌────────────────────┐
  │ MemoryAdapter │  │  ToolAdapter   │  │  ControlBusAdapter │
  │ SQLite/Mongo/ │  │  Equipment /   │  │  Redis / in-memory │
  │ Postgres/Neo4j│  │  Skills / Mock │  └────────────────────┘
  └───────────────┘  └────────────────┘
          ▲                   ▲
  ┌───────┴────────┐  ┌───────┴─────────┐
  │  EventAdapter  │  │ DeliveryAdapter │
  │  WhatsApp /    │  │  WhatsApp /     │
  │  BullMQ /      │  │  Console /      │
  │  Manual        │  │  Custom         │
  └────────────────┘  └─────────────────┘
                              │
                     ┌────────┴────────┐
                     │      Brain      │
                     │  OpenAI  ·      │
                     │  Anthropic ·    │
                     │  Ollama  ·      │
                     │  MSM Pipeline   │
                     └─────────────────┘
```

The runtime sits between your event sources and your brain. It provides everything except the LLM call and your business logic — guards, planning, memory, tool execution, delivery, observability, and self-improvement all ship out of the box.

---

## 4. How It Works — The Execution Loop

Every incoming event goes through this sequence:

```
 0. [Session Lock]    Acquire per-session mutex — prevents two events
                      from the same user running concurrently.

 1. [Gates]           Zero-LLM pre-processing checks:
                        - Acknowledgement: "ok", "thanks", "👍", "تمام"
                          → suppressed (no brain call, no delivery)
                        - Business hours: outside configured schedule
                          → canned closed-message (no brain call)

 2. [Pre-Hook]        Optional fast-intent gate — return an outcome directly
                      for trivial inputs (greetings, FAQs) to skip the loop.

 3. [Control Bus]     Per-iteration kill/pause check. Stops immediately
                      if the task was killed or tenant is paused.

 4. [Typing]          Send typing indicator via DeliveryAdapter (optional).

 5. [Context]         Build brain input:
                        - Conversation history (compacted if long)
                        - Task state: status, plan progress, recent failures
                        - Semantic memory: MemoryAdapter.search()
                        - Available tools catalog
                        - Equipment block (connected external systems)
                        - Evolving hints: [strategy] and [past approach] notes
                        - Tool results from previous iterations

 6. [Brain]           Call brain → orchestration decision.

 7. [Plan]            If brain returned a multi-step plan, track it.

 8. [Guards]          Evaluate all guard conditions:
                        - Confidence gate (below threshold → clarify)
                        - Iteration / cost / time budgets (hard limits)
                        - Repetition guard (3+ same tool → advisory signal)
                        - Dead-end guard (4+ failures across 2+ tools → advisory)

 9. [Dispatch]        Route on brain's action:
                        respond / complete → record → deliver → DONE
                        escalate          → record → deliver → DONE
                        clarify           → record → deliver → DONE
                        delegate          → record → deliver → DONE
                        use_tool          → continue to step 10

10. [Tool Pipeline]   For tool calls:
                        a. Check if tool is disabled (control bus)
                        b. Check rate limit
                        c. Dedup check (same tool + same params → return cached)
                        d. Validate parameters
                        e. Human approval (if tool.requiresApproval = true)
                        f. Execute
                        g. Record step to memory

11. [Plan Advance]    On success → advance plan step.
                      On failure → replan (up to maxReplans) → freestyle.

12. [Loop]            Go to step 3 with tool result in context.

13. [Quality]         After terminal outcome: scoreOutcome() computes
                      resolution, efficiency, error rate, and flags.

14. [Evolving]        postOutcome() writes structured learning event to memory.
                      Flags feed into strategy notes for future runs.
```

If the loop exhausts `maxIterations` without a terminal action, the runtime force-responds with the last available text rather than hanging.

---

## 5. The 5 Adapter Interfaces

The runtime provides the loop. You provide 5 adapters that connect it to your infrastructure.

| Adapter             | Purpose                                                                           | Built-in options                                                                                              |
| ------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `MemoryAdapter`     | Conversation history, task state, semantic search                                 | `InMemoryAdapter`, `SQLiteMemoryAdapter`, `PostgresMemoryAdapter`, `MongoMemoryAdapter`, `Neo4jMemoryAdapter` |
| `ToolAdapter`       | Execute domain actions; mark tools `requiresApproval` to pause for human sign-off | Your implementation or `EquipmentToolAdapter`, `SkillsToolAdapter`                                            |
| `EventAdapter`      | Receive work from webhooks, queues, or manual calls                               | `BullMQEventAdapter` (durable), simple HTTP handler                                                           |
| `DeliveryAdapter`   | Send responses to the user's channel                                              | `WhatsAppDeliveryAdapter`, your implementation                                                                |
| `ControlBusAdapter` | Kill tasks, pause tenants, disable tools at runtime                               | `RedisControlBus` (production), `InMemoryControlBus` (dev)                                                    |

Each adapter has a dummy implementation for tests (`DummyMemoryAdapter`, etc.) — no external services required.

→ **Full interface specs, code examples, and production wiring in [docs/INTEGRATION-GUIDE.md](docs/INTEGRATION-GUIDE.md)**

---

## 6. Brain Integration

The runtime ships built-in LLM brains for OpenAI, Anthropic, and Ollama. `buildBrain(def)` auto-selects based on your agent definition:

```typescript
import { buildBrain, loadAgent } from "msm-agent";
const def = await loadAgent("./support-agent.md");
const brain = buildBrain(def); // reads OPENAI_API_KEY / ANTHROPIC_API_KEY / OLLAMA_ENDPOINT
```

| Provider     | `provider:` value | Env var             |
| ------------ | ----------------- | ------------------- |
| OpenAI       | `openai`          | `OPENAI_API_KEY`    |
| Anthropic    | `anthropic`       | `ANTHROPIC_API_KEY` |
| Ollama       | `ollama`          | `OLLAMA_ENDPOINT`   |
| Azure OpenAI | `openai`          | `OPENAI_BASE_URL`   |

For the [msm-ai](https://github.com/msm-core/msm-ai) 6-layer prompt pipeline, wrap it with `wrapMSM()` from `msm-agent/bridge/msm`. Any object with a `run(input): Promise<BrainPayload>` method also works as a custom brain.

→ **Full examples and custom brain spec in [docs/INTEGRATION-GUIDE.md](docs/INTEGRATION-GUIDE.md)**

---

## 7. Production Adapters

The CLI selects adapters automatically from environment variables. For embedded use, import them directly from `"msm-agent"`.

| Adapter                   | Activate via                    | Peer dep                  | Best for                        |
| ------------------------- | ------------------------------- | ------------------------- | ------------------------------- |
| `InMemoryAdapter`         | default                         | none                      | Tests, prototypes               |
| `SQLiteMemoryAdapter`     | `MEMORY_PATH=/data/agent.db`    | none (Node.js 22+)        | Dev, single-container           |
| `PostgresMemoryAdapter`   | `DATABASE_URL=postgresql://...` | `pnpm add postgres`       | Production, SQL workloads       |
| `MongoMemoryAdapter`      | `DATABASE_URL=mongodb://...`    | `pnpm add mongodb`        | Production, Atlas Vector Search |
| `Neo4jMemoryAdapter`      | `NEO4J_URL=bolt://...`          | `pnpm add neo4j-driver`   | Graph-enriched semantic search  |
| `RedisControlBus`         | `REDIS_URL=redis://...`         | `pnpm add ioredis`        | Multi-instance control bus      |
| `BullMQEventAdapter`      | manual / `pnpm add bullmq`      | `pnpm add bullmq ioredis` | Durable queue, cron, retries    |
| `WhatsAppDeliveryAdapter` | `WHATSAPP_GATEWAY_URL=...`      | none                      | Kader WhatsApp Gateway bridge   |

Neo4j wraps any primary adapter as a graph enrichment layer. Failed BullMQ jobs retry 3× with exponential back-off.

→ **Full setup details, connect patterns, and Neo4j stacking in [docs/INTEGRATION-GUIDE.md](docs/INTEGRATION-GUIDE.md)**

---

## 8. Equipment — Connected External Systems

Equipment lets you connect external APIs (CRM systems, booking platforms, e-commerce stores) directly from the agent definition file. No code changes required — credentials are resolved from environment variables at load time.

```markdown
## Equipment

connectors:

- type: shopify
  operations: [orders.list, orders.get, customers.get]
  access: read
  endpoint: ${SHOPIFY_ENDPOINT}
  credentials:
  type: api_key
  value: ${SHOPIFY_API_KEY}
- type: fresha
  operations: [bookings.list, bookings.create, bookings.update]
  access: readwrite
  endpoint: ${FRESHA_ENDPOINT}
  credentials:
  type: bearer
  value: ${FRESHA_TOKEN}
  dedicatedTools: [generate_quote, escalate_to_human]
```

When the agent has equipment, the runtime automatically injects an `EQUIPMENT` block into every brain call so the LLM explicitly knows which systems it has access to:

```
EQUIPMENT (connected systems):
- shopify: orders.list, orders.get, customers.get [read]
- fresha: bookings.list, bookings.create, bookings.update [readwrite]
DEDICATED TOOLS: generate_quote, escalate_to_human
```

### Registering Connector Types

A connector is a ~50-line module mapping API operations to tool definitions:

```typescript
import { ConnectorRegistry } from "msm-agent";

ConnectorRegistry.register("shopify", (config) => ({
  tools: [
    {
      name: "orders.list",
      description: "List recent Shopify orders",
      execute: async (args) => {
        const response = await fetch(`${config.endpoint}/orders.json`, {
          headers: { "X-Shopify-Access-Token": config.credentials.value },
        });
        return { status: "ok", result: await response.json() };
      },
    },
  ],
}));
```

Once registered, any agent definition that lists `type: shopify` in its equipment block will automatically get these tools.

### Programmatic Usage

```typescript
import { EquipmentToolAdapter, loadAgent } from "msm-agent";

const def = await loadAgent("./agent.md");
const tools = EquipmentToolAdapter.create(def.equipment, baseToolAdapter);
const agent = createAgent({ tools, ...rest });
```

---

## 9. Skills — Reusable In-Process Tool Packs

Skills are named bundles of tools that live inside your process — no external API calls, no credentials. They are the right choice for shared business logic that multiple agents reuse.

```markdown
## Skills

- booking
- payments
- knowledge
```

### Registering Skills

```typescript
import { SkillRegistry } from "msm-agent";

SkillRegistry.register("booking", (options) => [
  {
    name: "booking_check_availability",
    description: "Check available slots for a service",
    parameters: {
      serviceId: { type: "string", required: true },
      date: { type: "string" },
    },
    execute: async (args) => {
      const slots = await calendar.getSlots(args.serviceId, args.date);
      return { status: "ok", result: { slots } };
    },
  },
  {
    name: "booking_create",
    description: "Create a booking",
    parameters: { serviceId: { type: "string" }, slotId: { type: "string" } },
    execute: async (args) => {
      const booking = await calendar.book(args);
      return { status: "ok", result: { booking } };
    },
  },
]);
```

### Comparison: Skills vs. Equipment

|                   | Equipment (Connectors)            | Skills                 |
| ----------------- | --------------------------------- | ---------------------- |
| Needs credentials | Yes — API key, bearer token, etc. | No                     |
| External API      | Yes                               | No — runs in-process   |
| Defined in        | `.md` `## Equipment` block        | `.md` `## Skills` list |
| Registry          | `ConnectorRegistry`               | `SkillRegistry`        |
| Adapter           | `EquipmentToolAdapter`            | `SkillToolAdapter`     |

---

## 10. Pre-Processing Gates

Gates are zero-LLM filters that run before the brain loop. They handle common patterns cheaply, saving a full LLM call each time they fire.

### Acknowledgement Gate

Suppresses meaningless acknowledgements — "ok", "thanks", "got it", "👍", "تمام", "شكرا", and similar — with no response delivered. No LLM call, no delivery.

### Business Hours Gate

Returns a configurable canned message outside working hours. No LLM call.

```markdown
## Hours

Timezone: Asia/Qatar
Mon-Fri: 09:00-18:00
Sat: 10:00-14:00
Message: We are currently closed. We will respond first thing when we open.
```

Both gates are activated by the CLI when the corresponding sections are present in the definition file. For embedded use:

```typescript
import { checkGates } from "msm-agent";

const agent = createAgent({
  gates: {
    acknowledgement: true,
    businessHours: {
      timezone: "Asia/Qatar",
      schedule: { "Mon-Fri": "09:00-18:00", Sat: "10:00-14:00" },
      closedMessage: "We are closed. Open Mon–Fri 9am–6pm.",
    },
  },
  ...adapters,
});
```

---

## 11. Quality Scoring and Self-Improvement

The runtime measures the quality of every task outcome without any LLM calls. These measurements feed an automatic self-improvement loop.

### Quality Scoring

After each task, `scoreOutcome()` computes three dimensions from the `LoopOutcome`:

| Dimension    | Signal                                                | Range |
| ------------ | ----------------------------------------------------- | ----- |
| `resolution` | Did the task reach a response? (vs. error/escalation) | 0–1   |
| `efficiency` | How many tool calls were needed? (fewer is better)    | 0–1   |
| `errorRate`  | What fraction of tool calls succeeded?                | 0–1   |

When a dimension falls below its threshold, a flag is raised:

| Flag                | Trigger                      |
| ------------------- | ---------------------------- |
| `failed_resolution` | resolution < 0.5             |
| `slow_response`     | efficiency < 0.5 (> 5 tools) |
| `high_error_rate`   | > 30% tool calls failed      |

```typescript
import { scoreOutcome } from "msm-agent";

const score = scoreOutcome(outcome);
// { resolution: 0.7, efficiency: 0.9, errorRate: 1.0, flags: [] }
```

### Evolving Layer — How Agents Learn

The evolving layer connects quality scores to actual behavior improvement. It uses the existing memory adapter — no new database, no ML pipeline.

```
Every task:
  preReason()   → inject strategy notes + past approach hints into brain context
  postOutcome() → write quality flags and outcome to memory
  (on startup in assist mode):
  refreshStrategies() → analyze recent quality flags, write improvement notes
```

**Three modes:**

| Mode     | Learning         | Hint injection | Purpose                                             |
| -------- | ---------------- | -------------- | --------------------------------------------------- |
| `off`    | none             | none           | Default — total silence                             |
| `shadow` | writes to memory | none           | Safe observation — collect data without influencing |
| `assist` | writes to memory | injects hints  | Full loop — learns and applies                      |

**How hints work:** In `assist` mode, `preReason()` retrieves strategy notes from memory and injects them at the top of the brain's context. For example, after several `failed_resolution` events, the agent's context will include:

```
[strategy] Ask clarifying questions when the user's intent is ambiguous.
           Break compound requests into individual steps before proceeding.
```

**FLAG_STRATEGIES** maps each quality flag to an actionable improvement note:

```typescript
import { FLAG_STRATEGIES } from "msm-agent";

FLAG_STRATEGIES.failed_resolution;
// → "Ask clarifying questions when the user's intent is ambiguous..."

FLAG_STRATEGIES.slow_response;
// → "Prioritize direct tool calls over multi-step planning..."

FLAG_STRATEGIES.high_error_rate;
// → "Verify tool parameters carefully before execution..."
```

Enable via environment variable:

```bash
EVOLVING_MODE=shadow   # observe and collect (safe starting point)
EVOLVING_MODE=assist   # observe, collect, and inject improvement hints
```

The evolving layer requires a memory adapter that implements `search()` and `store()` (SQLite, Postgres, or MongoDB). Without these, it degrades silently to a no-op.

---

## 12. Arabic-Native Routing

When `language: arabic` (or `ar`) is declared in the `## Brain` section of the agent definition, the runtime automatically routes Arabic user input through an Arabic-capable model. No code changes required.

```markdown
## Brain

provider: ollama
model: phi4-mini
language: arabic
```

**How it works:**

1. The brain factory builds a `RoutingBrain` wrapping two sub-brains.
2. Before each request, `detectLanguage(input)` runs a Unicode character-set heuristic — if > 30% of non-whitespace characters fall in the Arabic block (U+0600–U+06FF), the input is classified as Arabic.
3. Arabic input → routes to the Arabic-capable model. English/other → routes to the primary model.
4. Both sub-brains implement the same `Brain` interface — the rest of the runtime is unaware.

**Environment variables:**

| Variable                 | Default | Purpose                                                     |
| ------------------------ | ------- | ----------------------------------------------------------- |
| `ARABIC_OLLAMA_MODEL`    | `jais`  | Ollama model for Arabic input                               |
| `ARABIC_OPENAI_MODEL`    | —       | OpenAI model override for Arabic (falls back to primary)    |
| `ARABIC_ANTHROPIC_MODEL` | —       | Anthropic model override for Arabic (falls back to primary) |

**Language values accepted in `## Brain`:**

| Value            | Behaviour                                                              |
| ---------------- | ---------------------------------------------------------------------- |
| `arabic` / `ar`  | Arabic input → Arabic model; others → primary                          |
| `auto`           | Same as `arabic`; falls back to primary if no Arabic model env var set |
| `english` / `en` | No routing — same as omitting the field                                |
| omitted          | No routing (existing behaviour)                                        |

```typescript
import { detectLanguage, RoutingBrain } from "msm-agent";

// Detect language of a string:
detectLanguage("مرحباً كيف حالك"); // → "ar"
detectLanguage("Hello there"); // → "en"

// Use RoutingBrain directly in programmatic mode:
const router = new RoutingBrain(primaryBrain, arabicBrain);
```

The language detector runs in < 1ms. No API call, no ML model. Safe to call on every request.

---

## 13. Sovereign Deployment — Zero Cloud

For government, healthcare, and legal deployments that cannot use cloud LLMs, `msm-agent` supports a **sovereign mode** that enforces local-only processing.

```bash
# Zero API keys. Zero cloud. Fully air-gapped.
docker run \\
  -e AGENT_FILE=/agent/inquiry-agent.md \\
  -e SOVEREIGN=true \\
  -e OLLAMA_ENDPOINT=http://ollama:11434 \\
  -v ./inquiry-agent.md:/agent/inquiry-agent.md:ro \\
  -v agent-data:/data \\
  -p 3000:3000 \\
  msm-agent
```

**What `SOVEREIGN=true` does:**

1. **Validates at startup** — if `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` are present in the environment, the process exits with an error. This prevents accidental credential exposure.
2. **Defaults the brain provider to Ollama** — if the agent definition has no `## Brain` section (or uses a cloud provider), it is overridden to `provider: ollama, model: phi4-mini`.
3. **Defaults storage to SQLite** — if neither `DATABASE_URL` nor `MEMORY_PATH` is set, `MEMORY_PATH` is defaulted to `/data/agent.db`. No external database required.
4. **Logs a sovereign banner** at startup: `Sovereign mode: all processing is local — no cloud credentials loaded.`
5. **Adds `sovereign: true`** to the `/health` response for readiness probe confirmation.

```bash
curl http://localhost:3000/health
# → { "status": "ok", "sovereign": true, "provider": "ollama", ... }
```

**Recommended agent definition for sovereign deployments:**

```markdown
# Government Inquiry Agent

Domain: Citizen services
Language: Arabic and English

## Brain

provider: ollama
model: phi4-mini
language: arabic

## Capabilities

- answer public service inquiries
- explain application procedures
- escalate complex cases to a human officer

## Rules

- never fabricate policy details
- respond in the same language as the user
- escalate when confidence < 70%
```

**Air-gap checklist:**

- [ ] Ollama running in the same private network (no external calls)
- [ ] SQLite volume mounted at `/data` (or Postgres on private infra)
- [ ] No `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` in the environment
- [ ] `SOVEREIGN=true` set — runtime validates the above on startup
- [ ] `/health` returns `"sovereign": true` — use as liveness probe

---

## 14. Deeper Evolving Layer — Signal Decay & Contradiction Detection

Phase 14 introduced automatic strategy notes (flag frequency → improvement hints). Phase 17 adds three mechanisms that make the learning layer reliable at scale:

### Signal Decay

Strategy notes lose relevance over time. `computeDecayScore()` assigns a score based on how recently the note was supported by quality events:

```
decayScore = supportingEventCount / (daysSinceLastEvidence + 1)
             × recencyWeight  (1.0 if < 7 days, 0.5 if < 30, 0.1 otherwise)
```

Notes with `decayScore < 0.1` are pruned by `consolidate()`. An agent running for months will retain only the strategy notes backed by recent evidence.

### Contradiction Detection

When the flag-counting system produces contradictory advice (e.g., "ask clarifying questions" vs. "respond directly"), both notes would otherwise be injected into the prompt — confusing the agent. `consolidate()` detects these pairs and removes the note with the lower decay score.

```typescript
import { areContradictory, CONTRADICTION_PAIRS } from "msm-agent";

areContradictory(
  "Ask clarifying questions when intent is ambiguous.",
  "Respond directly without asking extra questions.",
);
// → true — the lower-scored note will be removed on consolidation
```

### Task Complexity Weighting

A `failed_resolution` on a 6-tool, 10-iteration task is a stronger signal than one on a simple FAQ lookup. `computeTaskWeight()` scales the flag count contribution accordingly:

```
weight = 1 + log(toolCount + 1) + (maxIterations / actualIterations)
```

Set `quality.weight` on the `QualityScore` before calling `postOutcome()` to activate weighted counting in `refreshStrategies()`.

### Running Consolidation

```typescript
import { consolidateStrategies } from "msm-agent";
// Or via the MemoryEvolvingAdapter:
const report = await evolvingAdapter.consolidate(memory);
// { pruned: 2, contradictionsResolved: 1, consolidatedAt: "2025-..." }
```

Run consolidation periodically (e.g., nightly, alongside `refreshStrategies()` on startup in `assist` mode) to keep the evolving layer clean.

---

## 15. Jobs and Missions

For long-running stateful workflows that span multiple interactions or run on a schedule, use the Jobs API.

```bash
ENABLE_JOBS=true   # activates the Jobs adapter and HTTP routes
```

### Creating a Job

```bash
curl -X POST http://localhost:3000/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "user-123",
    "name": "Monthly inventory audit",
    "budget": { "maxSteps": 50, "maxDurationMs": 3600000 }
  }'
# { "jobId": "jbm_a1b2c3", "status": "running" }
```

### Job Lifecycle

```
POST /jobs            → creates job, status: "running"
POST /v1/event        → each event on the session increments job step count
                        terminal outcomes (response, escalated) → "waiting"
                        budget exceeded → "failed" (HTTP 402)
POST /jobs/:id/cancel → job marked "cancelled"
GET  /jobs/:id        → job state, step count, elapsed duration
GET  /jobs            → list all jobs (filterable by status, sessionId)
```

### Storage

`InMemoryJobAdapter` is used by default when `ENABLE_JOBS=true`. For persistence, set `MEMORY_PATH` alongside `ENABLE_JOBS=true` to use `SQLiteJobAdapter` (same database file as the memory adapter, zero extra dependencies).

---

## 16. MCP Server

Expose the agent as an [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server so any MCP client — Claude Desktop, Cursor, custom AI tools — can call it as a tool provider.

```bash
ENABLE_MCP=true                        # stdio transport (CLI / IDE)
ENABLE_MCP=true MCP_TRANSPORT=http     # HTTP transport (server deployments)
MCP_PORT=3001                          # HTTP transport port (default: 3001)
```

### MCP Tools Exposed

| Tool                  | Description                                                  |
| --------------------- | ------------------------------------------------------------ |
| `agent_chat`          | Send a message and get a response (auto-generates sessionId) |
| `agent_approve_task`  | Approve or deny a pending tool requiring human approval      |
| `agent_search_memory` | Full-text search of the agent's semantic memory              |

### MCP Resources Exposed

| Resource                | Description                           |
| ----------------------- | ------------------------------------- |
| `session://{sessionId}` | Conversation transcript for a session |
| `agent://definition`    | Agent identity and capabilities       |

### Programmatic Usage

```typescript
import { createMcpServer } from "msm-agent/server";

const mcp = await createMcpServer(agent, def, {
  transport: "http",
  port: 3001,
  memory,
});

// later:
await mcp.stop();
```

---

## 17. Running as a Microservice

The CLI boots an HTTP server from any `.md` or `.it` definition file. Adapters wire automatically from environment variables — no code changes needed.

```bash
# Minimal (in-memory, local dev)
AGENT_FILE=./agent.md OPENAI_API_KEY=sk-... node dist/server/cli.js

# Full production
AGENT_FILE=./agent.md DATABASE_URL=postgresql://... REDIS_URL=redis://... node dist/server/cli.js
```

**Progression:** In-memory → SQLite → Postgres/Mongo → add Redis + BullMQ + `EVOLVING_MODE=shadow`.

→ **Docker Compose, all environment variables, and deployment guide in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**

---

## 18. HTTP API Reference

| Endpoint            | Method | Description                                  |
| ------------------- | ------ | -------------------------------------------- |
| `/health`           | GET    | Agent identity and readiness                 |
| `/v1/event`         | POST   | Process any `AgentEvent` (stateful sessions) |
| `/chat`             | POST   | Stateless single-turn (demo / testing)       |
| `/session/:id`      | GET    | Conversation history + active task           |
| `/task/approve`     | POST   | Resume a paused approval task                |
| `/webhook/whatsapp` | POST   | Inbound WhatsApp (HMAC-SHA256 verified)      |
| `/jobs/*`           | —      | Jobs CRUD (`ENABLE_JOBS=true`)               |
| `/admin/*`          | —      | Control bus + memory search (password-gated) |
| `/dashboard`        | GET    | Ops panel UI (`DASHBOARD_PASSWORD` required) |

→ **Full request/response examples in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#2-http-api-reference)**

---

## 19. Ops Dashboard

When `DASHBOARD_PASSWORD` is set, a built-in ops panel is available at `GET /dashboard`. Panels: pending approvals, control bus commands, memory search, session inspector. No external CDN or build step.

→ [docs/DEPLOYMENT.md#3-ops-dashboard](docs/DEPLOYMENT.md#3-ops-dashboard)

---

## 20. Configuration Reference

Key `createAgent()` options: `brain`, `memory`, `tools`, `events`, `delivery`, plus `controlBus`, `evolving`, `gates`, `preHook`, `compactHistory`, `costExtractor`, `onIteration`, `onGuard`, `onPlanCreated`, `onFatalError`, `onInjectionDetected`.

Loop config defaults: `maxIterations: 6`, `maxReplans: 2`, `confidenceThreshold: 0.6`, `toolDedup: true`, `costCapPerTask: 0` (unlimited), `timeoutMs: 0` (unlimited), `maxToolCallsPerTask: 0` (unlimited).

→ **Full options, `LoopOutcome` types in [docs/DEPLOYMENT.md#4-configuration-reference](docs/DEPLOYMENT.md#4-configuration-reference)**

---

## 21. Guard System

Hard guards abort execution (iteration budget, cost cap, timeout, confidence gate, task killed, tenant paused, rate limited, tool disabled). Soft guards emit advisory signals to `onGuard` (repetition, dead-end).

→ [docs/DEPLOYMENT.md#5-guard-system](docs/DEPLOYMENT.md#5-guard-system)

---

## 22. Testing

```bash
pnpm test
```

**337 tests.** All tests use the included dummy adapters — no external services required. The test suite covers:

- Core loop, session mutex, plan tracking, tool dedup, flush gate
- All 5 guard types
- Memory adapters (in-memory)
- Control bus commands
- Definition file parsing (`.md` and `.it`)
- Brain system prompt generation
- WhatsApp event + delivery adapters
- Equipment connector registry and tool adapter
- Skills registry and tool adapter
- Pre-processing gates (acknowledgement + business hours)
- Quality scoring (`scoreOutcome`, `FLAG_STRATEGIES`)
- Evolving layer (`preReason`, `postOutcome`, `refreshStrategies`)
- **Arabic-native routing** (`detectLanguage`, `RoutingBrain`, `BrainSchema.language`)
- **Sovereign deployment** (`/health sovereign field`, startup validation logic)
- **Deeper evolving layer** (`computeDecayScore`, `areContradictory`, `consolidateStrategies`)
- Jobs lifecycle (create, list, cancel, budget enforcement)
- MCP server tool and resource exposure
- Context builder, output sanitization, input guard

---

## 23. License

MIT

---

## Further Reading

- [Integration Guide](docs/INTEGRATION-GUIDE.md) — adapter specs, brain wiring, production setup, full example
- [Deployment Reference](docs/DEPLOYMENT.md) — CLI, Docker, HTTP API, config options, guard reference
- [Production Readiness & Ownership Boundary](docs/production-readiness-and-boundary.md) — parity matrix, what to build yourself
