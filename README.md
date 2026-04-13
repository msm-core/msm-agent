# msm-agent

Portable agent framework for the [MSM](https://github.com/emadjumaah/msm) brain standard. The agent is the **hands** — it receives events, asks the MSM brain what to do, executes tools, feeds results back, and delivers responses. The brain never executes anything; it only decides.

Extracted from the production-proven execution engine of the [Dalil AI](https://github.com/emadjumaah/kader) platform (17-step loop, 65+ tools, 6 channels, 8 LLM providers), made generic and pluggable so any project can reach the same level of sophistication by implementing 5 adapter interfaces.

```
npm install msm-agent msm-ai
```

## Production Readiness Guide

For Dalil parity status, ownership boundaries (what belongs to brain vs agent vs project), and a concrete integration checklist, see:

- [docs/production-readiness-and-boundary.md](docs/production-readiness-and-boundary.md)

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  YOUR PROJECT                                           │
│                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌────────────────┐  │
│  │ EventAdapter │  │ ToolAdapter │  │ DeliveryAdapter│  │
│  │ (webhooks,   │  │ (your APIs, │  │ (WhatsApp,     │  │
│  │  queues,     │  │  DB queries, │  │  Telegram,     │  │
│  │  cron)       │  │  HTTP calls) │  │  email, web)   │  │
│  └──────┬───────┘  └──────┬──────┘  └───────┬────────┘  │
│         │                 │                  │           │
│  ┌──────┴─────────────────┴──────────────────┴────────┐  │
│  │              msm-agent (this package)               │  │
│  │                                                     │  │
│  │  event → context → brain → guard → dispatch:        │  │
│  │    respond/escalate/clarify/delegate → deliver      │  │
│  │    use_tool → validate → dedup → execute → loop     │  │
│  │                                                     │  │
│  │  + session mutex (no double-tap races)             │  │
│  │  + pre-hook (fast-intent short-circuit)             │  │
│  │  + context: task state + semantic memory + tools    │  │
│  │  + control bus (kill/pause/disable)                 │  │
│  │  + guards (confidence/budget/repetition/dead-end)   │  │
│  │  + plan tracking (create/advance/replan/freestyle)  │  │
│  │  + tool dedup (same call → cached result)           │  │
│  │  + strict tool validation (abort on bad reasoning)  │  │
│  │  + flush gate (buffered writes)                     │  │
│  └──────────────────────┬──────────────────────────────┘  │
│                         │                                 │
│  ┌──────────────────────┴──────────────────────────────┐  │
│  │  MemoryAdapter (Redis, MongoDB, Postgres, etc.)     │  │
│  └─────────────────────────────────────────────────────┘  │
│                         │                                 │
│  ┌──────────────────────┴──────────────────────────────┐  │
│  │  ControlBusAdapter (Redis, DB, message bus)         │  │
│  └─────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                          │
                 ┌────────┴────────┐
                 │  MSM Brain      │
                 │  (msm-ai        │
                 │   Pipeline)     │
                 │                 │
                 │  Translation    │
                 │  Classification │
                 │  Orchestration  │
                 │  Generation     │
                 │  Validation     │
                 └─────────────────┘
```

## Quick Start

```typescript
import {
  createAgent,
  InMemoryAdapter,
  MockToolAdapter,
  ManualEventAdapter,
  ConsoleDeliveryAdapter,
} from "msm-agent";
import {
  Pipeline,
  DummyTranslation,
  DummyClassification,
  DummyOrchestration,
  DummyGeneration,
  DummyValidation,
} from "msm-ai";

// 1. Create an MSM brain
const pipeline = new Pipeline("my-agent", [
  new DummyTranslation(),
  new DummyClassification(),
  new DummyOrchestration(),
  new DummyGeneration(),
  new DummyValidation(),
]);

// 2. Create the agent with dummy adapters
const agent = createAgent({
  brain: { run: (input) => pipeline.run(input) },
  memory: new InMemoryAdapter(),
  tools: new MockToolAdapter(),
  events: new ManualEventAdapter(),
  delivery: new ConsoleDeliveryAdapter(),
});

// 3. Handle an event
const outcome = await agent.handleEvent({
  type: "user_message",
  sessionId: "session-1",
  text: "What restaurants are near me?",
  modality: "text",
});

console.log(outcome);
// { type: "response", text: "...", language: "en", payload: { ... } }
```

## The 5 Adapter Interfaces

The agent framework provides the loop, guards, planning, and orchestration. **You provide 5 adapters** that connect it to your project's infrastructure. Each adapter has a dummy implementation included for testing.

### 1. MemoryAdapter — How the agent remembers

```typescript
import type { MemoryAdapter } from "msm-agent";

class MongoMemoryAdapter implements MemoryAdapter {
  // ── Required ──
  async getConversation(sessionId: string): Promise<Message[]> {
    return db.conversations.find({ sessionId }).sort({ timestamp: 1 });
  }
  async addMessage(sessionId: string, message: Message): Promise<void> {
    await db.conversations.insertOne({ sessionId, ...message });
  }
  async getTask(taskId: string): Promise<TaskState | null> {
    return db.tasks.findOne({ taskId });
  }
  async saveTask(task: TaskState): Promise<void> {
    await db.tasks.insertOne(task);
  }
  async updatePlan(taskId: string, plan: TaskPlan): Promise<void> {
    await db.tasks.updateOne({ taskId }, { $set: { plan } });
  }
  async addStep(taskId: string, step: StepResult): Promise<void> {
    await db.tasks.updateOne({ taskId }, { $push: { steps: step } });
  }
  async updateTaskStatus(taskId: string, status: TaskStatus): Promise<void> {
    await db.tasks.updateOne({ taskId }, { $set: { status } });
  }

  // ── Optional: Semantic Memory ──
  async search(query: string, limit: number): Promise<MemoryEntry[]> {
    // Vector search, full-text search, or simple substring match
    return vectorDb.search(query, limit);
  }
  async store(entry: MemoryEntry): Promise<void> {
    await vectorDb.upsert(entry);
  }
}
```

**Dalil equivalent:** Redis working memory (ephemeral state, 5-min TTL with Lua atomic updates) + MongoDB for 14 entity types (tasks, conversations, customers, employees, bookings, leads, FAQs, services, tool executions, audit logs, agencies, business state).

**Context enrichment:** When your `MemoryAdapter` implements the optional `search(query, limit)` method, the context builder automatically queries it every iteration and injects matching memories into the `system_context` field of `BrainInput`. This gives the MSM brain episodic/semantic awareness without any extra wiring.

**Minimum for a new project:** A single Postgres or MongoDB database is enough. Start with `InMemoryAdapter` for prototyping, then swap to your DB when ready.

### 2. ToolAdapter — How the agent executes tools

```typescript
import type { ToolAdapter, ToolDefinition, ToolResult } from "msm-agent";

class MyToolAdapter implements ToolAdapter {
  list(): ToolDefinition[] {
    return [
      {
        name: "search_products",
        description: "Search the product catalog",
        parameters: {
          query: {
            type: "string",
            description: "Search query",
            required: true,
          },
          limit: { type: "number", description: "Max results", default: 10 },
        },
        category: "catalog",
        rateLimit: { requestsPerMinute: 30 },
      },
      {
        name: "create_order",
        description: "Create a new order",
        parameters: {
          productId: {
            type: "string",
            description: "Product ID",
            required: true,
          },
          quantity: { type: "number", description: "Quantity", required: true },
        },
        destructive: true,
        requiresApproval: true,
        category: "orders",
      },
    ];
  }

  async execute(
    name: string,
    params: Record<string, unknown>,
  ): Promise<ToolResult> {
    switch (name) {
      case "search_products":
        const results = await productApi.search(params.query as string);
        return { tool: name, status: "ok", result: { products: results } };
      case "create_order":
        const order = await orderApi.create(params);
        return { tool: name, status: "ok", result: { orderId: order.id } };
      default:
        return {
          tool: name,
          status: "failed",
          result: { error: "Unknown tool" },
        };
    }
  }

  // Optional: parameter validation before execution
  validate(name: string, params: Record<string, unknown>) {
    const def = this.list().find((t) => t.name === name);
    if (!def) return { valid: false, errors: ["Unknown tool"] };
    const missing = Object.entries(def.parameters)
      .filter(([_, p]) => p.required && !(params as any)[_])
      .map(([k]) => `Missing required: ${k}`);
    return { valid: missing.length === 0, errors: missing };
  }

  // Optional: rate limit enforcement
  checkRateLimit(name: string): number {
    return rateLimiter.check(name); // Returns 0 if ok, ms to wait if limited
  }
}
```

**Dalil equivalent:** 65+ tools across 16 categories (knowledge, CRM, booking, sales, analytics, ERP, channel, collaboration, marketing, support, internal, MCP), with a tool gateway doing 7-point pre-execution validation, equipment-based 3-level tool resolution, and sales funnel tracking.

**Minimum for a new project:** Start with 2-3 tools (e.g., `search_knowledge`, `get_info`, `create_record`). Add more as your domain grows.

### 3. EventAdapter — How the agent receives work

```typescript
import type { EventAdapter, AgentEvent } from "msm-agent";
import { createBullMQQueue } from "bullmq";

class BullMQEventAdapter implements EventAdapter {
  private handler: ((event: AgentEvent) => Promise<void>) | null = null;
  private worker: Worker | null = null;

  onEvent(handler: (event: AgentEvent) => Promise<void>) {
    this.handler = handler;
  }

  async start() {
    this.worker = new Worker("agent-tasks", async (job) => {
      await this.handler?.(job.data as AgentEvent);
    });
  }

  async stop() {
    await this.worker?.close();
  }
}
```

**Dalil equivalent:** BullMQ with 10 specialized queues, WhatsApp/Telegram webhook receivers, cron scheduler, and internal API triggers.

**Minimum for a new project:** Use `ManualEventAdapter` for CLI/testing, an Express webhook handler for APIs, or BullMQ for queued processing.

### 4. DeliveryAdapter — How the agent delivers responses

```typescript
import type { DeliveryAdapter, LoopOutcome } from "msm-agent";

class WhatsAppDeliveryAdapter implements DeliveryAdapter {
  async send(sessionId: string, outcome: LoopOutcome) {
    const phoneNumber = await getPhoneForSession(sessionId);
    switch (outcome.type) {
      case "response":
        await whatsapp.sendText(phoneNumber, outcome.text);
        break;
      case "clarification":
        await whatsapp.sendText(phoneNumber, outcome.question);
        break;
      case "escalated":
        await whatsapp.sendText(
          phoneNumber,
          "Connecting you to a human agent...",
        );
        await escalationService.handoff(sessionId);
        break;
    }
  }

  // Optional: typing indicator
  async sendTyping(sessionId: string) {
    const phoneNumber = await getPhoneForSession(sessionId);
    await whatsapp.sendTyping(phoneNumber);
  }

  // Optional: human approval for destructive tools
  async requestApproval(
    sessionId: string,
    action: string,
    params: Record<string, unknown>,
  ) {
    const phoneNumber = await getPhoneForSession(sessionId);
    await whatsapp.sendButtonMessage(phoneNumber, {
      text: `Approve: ${action}?`,
      buttons: [
        { id: "approve", title: "Yes" },
        { id: "deny", title: "No" },
      ],
    });
    return waitForButtonResponse(sessionId); // true if "approve"
  }
}
```

**Dalil equivalent:** 6 channel adapters (WhatsApp Cloud API with interactive buttons/lists/templates, Telegram Bot API with inline keyboards, web widget via WebSocket, email via SMTP/SendGrid, voice via VoIP, media processor for images/audio/documents).

**Minimum for a new project:** `ConsoleDeliveryAdapter` for CLI, or a simple HTTP/SSE adapter for web apps.

### 5. ControlBusAdapter — Runtime operability (optional)

```typescript
import type { ControlBusAdapter, ControlCommand } from "msm-agent";
import Redis from "ioredis";

class RedisControlBus implements ControlBusAdapter {
  constructor(private redis: Redis) {}

  async isTaskKilled(taskId: string) {
    return this.redis.get(`agent:kill:${taskId}`);
  }

  async isTenantPaused(tenantId: string) {
    return this.redis.get(`agent:pause:${tenantId}`);
  }

  async isToolDisabled(toolName: string) {
    return this.redis.get(`agent:disable:${toolName}`);
  }

  async execute(command: ControlCommand) {
    switch (command.type) {
      case "kill_task":
        await this.redis.setex(
          `agent:kill:${command.taskId}`,
          3600,
          command.reason,
        );
        break;
      case "pause_tenant":
        await this.redis.set(`agent:pause:${command.tenantId}`, command.reason);
        break;
      case "resume_tenant":
        await this.redis.del(`agent:pause:${command.tenantId}`);
        break;
      case "disable_tool":
        await this.redis.set(
          `agent:disable:${command.toolName}`,
          command.reason,
        );
        break;
      case "enable_tool":
        await this.redis.del(`agent:disable:${command.toolName}`);
        break;
    }
  }
}
```

**Dalil equivalent:** Redis command dispatcher with Lua atomic state updates, checked every loop iteration. Supports PAUSE_TENANT, RESUME_TENANT, KILL_TASK, DISABLE_TOOL, ENABLE_TOOL. Plus an alert engine with rule-based anomaly detection and situational awareness for dashboards.

**Minimum for a new project:** Skip it — it's optional. Add it when you need admin controls or multi-tenant operability.

## Configuration

```typescript
const agent = createAgent({
  brain,
  memory,
  tools,
  events,
  delivery,
  config: {
    maxIterations: 6, // Max loop iterations per event (default: 6)
    maxReplans: 2, // Max plan retries before freestyle (default: 2)
    confidenceThreshold: 0.6, // Tool calls below this → clarification (default: 0.6)
    costCapPerTask: 0.5, // USD limit per task, 0 = unlimited (default: 0)
    timeoutMs: 30000, // Wall-clock timeout, 0 = unlimited (default: 0)
    toolDedup: true, // Deduplicate identical tool calls (default: true)
  },

  // Optional: control bus for runtime operability
  controlBus: new RedisControlBus(redis),
  tenantId: "tenant-123",

  // Optional: fast-intent pre-hook — skip the brain loop for trivials
  preHook: async (event) => {
    if (event.type === "user_message" && /^(hi|hello|hey)$/i.test(event.text)) {
      return {
        type: "response",
        text: "Hello! How can I help?",
        language: "en",
        payload: {} as any,
      };
    }
    return null; // proceed to brain loop
  },

  // Optional: custom history compaction (replace naive truncation with LLM summary)
  compactHistory: async (messages) => {
    if (messages.length <= 10)
      return messages.map((m) => ({ role: m.role as any, content: m.content }));
    const summary = await llm.summarize(messages.slice(0, -6));
    const tail = messages
      .slice(-6)
      .map((m) => ({ role: m.role as any, content: m.content }));
    return [{ role: "assistant", content: `[Summary] ${summary}` }, ...tail];
  },

  // Optional: observability hooks
  onIteration: (state, step) => {
    metrics.recordStep(step);
    logger.info(`[iter ${state.iteration}] ${step.action} → ${step.toolName}`);
  },
  onGuard: (signal) => {
    logger.warn(`Guard fired: ${signal.type}`, signal);
  },
});
```

## The Execution Loop

Every event goes through this loop (equivalent of dalil's 17-step `executeTask()`):

```
0. [Session Lock]  Acquire per-session mutex (prevents concurrent execution)
   [Pre-Hook]     If preHook returns an outcome → deliver & skip loop entirely
1. [Control Bus]   Check: is task killed? Is tenant paused?
2. [Typing]        Send typing indicator via DeliveryAdapter
3. [Context]       Build brain input:
                     - Conversation history (compactHistory hook or built-in heuristic)
                     - Task state (status, plan progress, recent failures)
                     - Semantic memory (MemoryAdapter.search() if available)
                     - Available tool catalog
                     - Tool results from previous iterations
4. [Brain]         Call MSM pipeline → get orchestration decision
5. [Plan]          If brain returned a plan, track it
6. [Guards]        Check all guards:
                     - Confidence gate (< threshold on tool calls → clarify)
                     - Iteration budget (>= max → force respond)
                     - Cost budget (>= cap → force respond)
                     - Time budget (>= timeout → force respond)
                     - Repetition (3+ same tool → soft signal)
                     - Dead-end (4+ failures across 2+ tools → soft signal)
7. [Dispatch]      Route based on brain's action:

   respond/complete  → record message → deliver → DONE
   escalate          → record → deliver → DONE
   clarify           → record → deliver → DONE
   delegate          → record → deliver → DONE
   use_tool          → continue to step 8
   use_tool (no name) → ABORT with error (INVALID_REASONING)
   custom action     → return to caller → DONE

8. [Tool Disabled?] Check control bus
9. [Rate Limit?]   Check ToolAdapter.checkRateLimit()
10. [Dedup?]       Check if same tool+params already executed → return cached
11. [Validate]     Check ToolAdapter.validate() if available
12. [Approval]     If tool.requiresApproval → DeliveryAdapter.requestApproval()
13. [Execute]      Call ToolAdapter.execute()
14. [Record]       Save step to memory
15. [Plan Mgmt]    Success → advance plan. Failure → fail step → replan or freestyle
16. [Loop]         Go to step 1 with tool result as context for next brain call
```

If the loop exhausts `maxIterations` without a terminal action, it force-responds with the last available text.

## Guard System

Guards are safety mechanisms checked every iteration:

| Guard                | Type | Trigger                               | Behavior                   |
| -------------------- | ---- | ------------------------------------- | -------------------------- |
| **Confidence Gate**  | Hard | Tool call with confidence < threshold | Converts to clarification  |
| **Iteration Budget** | Hard | iteration >= maxIterations            | Force respond              |
| **Cost Budget**      | Hard | totalCost >= costCapPerTask           | Force respond              |
| **Time Budget**      | Hard | elapsed >= timeoutMs                  | Force respond              |
| **Rate Limited**     | Hard | checkRateLimit() > 0                  | Skip tool, continue loop   |
| **Aborted**          | Hard | Control bus kill/pause                | Return aborted outcome     |
| **Repetition**       | Soft | Same tool 3+ times consecutively      | Signal to brain (advisory) |
| **Dead-End**         | Soft | 4+ failures across 2+ tools           | Signal to brain (advisory) |

Hard guards block execution. Soft guards are advisory — they're passed to the brain via `onGuard` so you can decide how to handle them (e.g., inject a hint into the next brain call).

## FlushGate — Buffered Writes

For high-throughput scenarios where you don't want per-event DB writes:

```typescript
import { FlushGate } from "msm-agent";

const auditGate = new FlushGate<StepResult>({
  flush: async (steps) => {
    await db.auditLog.insertMany(steps);
  },
  intervalMs: 2000, // Flush every 2s
  maxBufferSize: 100, // Or when 100 items buffered
  onError: (err, items) => {
    logger.error("Audit flush failed", err, items.length);
    // Items are automatically requeued for retry
  },
});

auditGate.start();

// In your onIteration hook:
const agent = createAgent({
  // ...
  onIteration: (state, step) => {
    auditGate.push(step); // Fire-and-forget, flushed in batches
  },
});

// On shutdown:
await auditGate.stop(); // Flushes remaining items
```

## Session Mutex — Concurrent Event Safety

When a user double-taps "Yes" on WhatsApp, or two webhooks arrive for the same session simultaneously, you don't want two `executeEvent()` calls racing on the same task. `createAgent` includes a built-in per-session mutex:

- Events on the **same session** are serialized (queued behind each other)
- Events on **different sessions** run in parallel (no global bottleneck)
- No configuration needed — it's automatic when using `createAgent`

If you use the low-level `executeEvent()` directly, bring your own mutex.

## Pre-Hook — Fast Intent Routing

Skip the expensive brain loop for trivial events (greetings, FAQs, static replies):

```typescript
const agent = createAgent({
  // ...adapters...
  preHook: async (event) => {
    if (event.type === "user_message") {
      // Greeting → instant response, no brain call
      if (/^(hi|hello|hey|مرحبا)$/i.test(event.text)) {
        return {
          type: "response",
          text: "Hello! How can I help?",
          language: "en",
          payload: {} as any,
        };
      }
      // FAQ → look up from cache
      const faq = await faqCache.match(event.text);
      if (faq) {
        return {
          type: "response",
          text: faq.answer,
          language: "en",
          payload: {} as any,
        };
      }
    }
    return null; // not a trivial event → proceed to brain loop
  },
});
```

**Dalil equivalent:** FastIntent gate that short-circuits greetings and FAQ matches before the planner.

## History Compaction

When conversations exceed 10 messages, context must be compacted to stay within token budgets. msm-agent provides two levels:

**Built-in heuristic (default):** Summarizes dropped messages into a single `[Earlier conversation summary: ...]` entry with topic hints extracted from user messages, then appends the last 6 messages. Better than naive truncation — the brain still knows what was discussed earlier.

**Custom hook (production):** Replace with an LLM-based summarizer for full fidelity:

```typescript
const agent = createAgent({
  // ...adapters...
  compactHistory: async (messages) => {
    if (messages.length <= 10) {
      return messages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));
    }
    // Summarize the old messages with your LLM
    const old = messages.slice(0, -6);
    const summary = await llm.chat([
      {
        role: "system",
        content: "Summarize this conversation in 2-3 sentences.",
      },
      ...old.map((m) => ({ role: m.role, content: m.content })),
    ]);
    const tail = messages.slice(-6).map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));
    return [
      { role: "assistant", content: `[Conversation summary] ${summary}` },
      ...tail,
    ];
  },
});
```

**Dalil equivalent:** Dynamic summarization with strict compaction rules (task state drops last).

## Context Enrichment

The context builder (`buildContext()`) assembles a `BrainInput` with a `system_context` field that includes:

| Source              | What gets injected                                           | When                           |
| ------------------- | ------------------------------------------------------------ | ------------------------------ |
| **Task state**      | `status`, plan progress (`N steps, current=M`), replan count | Always when a task exists      |
| **Recent failures** | Tool names + error details from failed steps                 | When any recent step failed    |
| **Semantic memory** | Up to 5 relevant entries from `MemoryAdapter.search()`       | When `search()` is implemented |
| **Tool catalog**    | Names, descriptions, `[destructive]` flags                   | When tools are registered      |

This gives the MSM brain the same situational awareness that Dalil's 5-layer prompt assembly provides, without requiring you to build custom prompt logic.

## How to Reach Dalil-Level Complexity

The Dalil platform has ~180 TypeScript files across 6 packages. Here's what belongs where when you build a project of that scale:

### What msm-agent gives you (use as-is)

| Capability                                                                  | msm-agent module                    |
| --------------------------------------------------------------------------- | ----------------------------------- |
| Execution loop (event → brain → tool → loop)                                | `executeEvent()`                    |
| Session mutex (per-session concurrency safety)                              | `SessionMutex` in `agent.ts`        |
| Fast-intent pre-hook (skip brain loop for trivials)                         | `preHook` option                    |
| Rich context assembly (task state + semantic memory + tool catalog)         | `buildContext()` + `system_context` |
| Custom history compaction hook (LLM summarizer)                             | `compactHistory` option             |
| 8 guard types (confidence, budget, repetition, dead-end, rate limit, abort) | `checkGuards()`                     |
| Strict tool validation (abort on malformed brain output)                    | `loop.ts` INVALID_REASONING gate    |
| Plan tracking (create, advance, fail, replan, freestyle)                    | `planner.ts`                        |
| Tool deduplication                                                          | `checkDedup()`                      |
| Task abort / kill                                                           | `ControlBusAdapter`                 |
| Tenant pause / resume                                                       | `ControlBusAdapter`                 |
| Tool disable / enable                                                       | `ControlBusAdapter`                 |
| Buffered writes                                                             | `FlushGate`                         |
| Observability hooks                                                         | `onIteration`, `onGuard`            |
| Audit trail types                                                           | `ActionReceipt`, `ResponseEvidence` |

### What you implement at the project level

| Dalil Feature                                    | Where it belongs                   | Why                                                                                                       |
| ------------------------------------------------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **LLM providers + circuit breakers**             | MSM brain layers / LLM wrapper     | The brain is a black box to the agent — resilience belongs inside the brain or its LLM adapter            |
| **Prompt engineering / personas**                | MSM brain layers                   | Translation, Classification, Orchestration, Generation, Validation — all prompt logic lives in MSM layers |
| **Token budgeting / compaction**                 | MSM brain layers                   | The brain manages its own context window                                                                  |
| **Domain tools** (CRM, booking, ERP, analytics)  | `ToolAdapter` implementation       | Every project has different tools                                                                         |
| **Channel adapters** (WhatsApp, Telegram, email) | `EventAdapter` + `DeliveryAdapter` | Channel-specific formatting, webhook parsing, interactive components                                      |
| **Database persistence**                         | `MemoryAdapter` implementation     | MongoDB, Postgres, Redis — your choice                                                                    |
| **Multi-tenant capabilities / plans**            | Project config                     | Subscription tiers, feature gates, per-tenant settings                                                    |
| **NL approval classifier**                       | Project-specific                   | Tenant-defined approval rules + LLM classifier                                                            |
| **Equipment-based tool resolution**              | Project-specific                   | Per-employee tool permissions, connector-gated access                                                     |
| **Alert engine / anomaly detection**             | Project monitoring                 | Rule-based alerts for queue depth, failure rates, stuck tasks                                             |
| **Situational awareness dashboard**              | Project UI                         | Aggregated system state for operators                                                                     |
| **Sales funnel tracking**                        | Project analytics                  | Domain-specific event tracking                                                                            |

### Progression path: prototyping → production

**Stage 1: Prototype (1 hour)**

```
msm-agent + InMemoryAdapter + MockToolAdapter + ManualEventAdapter + ConsoleDeliveryAdapter
```

All dummy adapters. Everything in-memory. Good for testing your brain logic.

**Stage 2: Working agent (1 day)**

```
Replace MemoryAdapter → Postgres/MongoDB
Replace ToolAdapter → your 3-5 real tools
Replace EventAdapter → Express webhook or BullMQ
Replace DeliveryAdapter → your channel (API response, WebSocket, etc.)
```

**Stage 3: Production agent (1 week)**

```
Add ControlBusAdapter → Redis for runtime operability
Add rate limiting → ToolAdapter.checkRateLimit()
Add approval gates → DeliveryAdapter.requestApproval()
Add observability → onIteration + FlushGate for audit logs
Add tool validation → ToolAdapter.validate()
Configure guards → cost cap, timeout, confidence threshold
```

**Stage 4: Dalil-level platform (ongoing)**

```
65+ tools across categories
Multiple channels (WhatsApp, Telegram, web, email, voice)
Multi-tenant with capability system
LLM routing with circuit breakers (inside MSM brain)
Rich persona system (MSM layers)
Alert engine + situational awareness
Equipment-based tool resolution
NL auto-approve classifier
```

## Connecting to Databases

### MongoDB (Mongoose)

```typescript
import type {
  MemoryAdapter,
  Message,
  TaskState,
  TaskPlan,
  StepResult,
} from "msm-agent";
import { ConversationModel, TaskModel } from "./models.js";

export class MongoMemoryAdapter implements MemoryAdapter {
  async getConversation(sessionId: string): Promise<Message[]> {
    const conv = await ConversationModel.findOne({ sessionId }).lean();
    return conv?.messages ?? [];
  }

  async addMessage(sessionId: string, message: Message): Promise<void> {
    await ConversationModel.updateOne(
      { sessionId },
      { $push: { messages: message } },
      { upsert: true },
    );
  }

  async getTask(taskId: string): Promise<TaskState | null> {
    return TaskModel.findOne({ taskId }).lean();
  }

  async saveTask(task: TaskState): Promise<void> {
    await TaskModel.create(task);
  }

  async updatePlan(taskId: string, plan: TaskPlan): Promise<void> {
    await TaskModel.updateOne({ taskId }, { $set: { plan } });
  }

  async addStep(taskId: string, step: StepResult): Promise<void> {
    await TaskModel.updateOne({ taskId }, { $push: { steps: step } });
  }

  async updateTaskStatus(taskId: string, status: string): Promise<void> {
    await TaskModel.updateOne({ taskId }, { $set: { status } });
  }
}
```

### PostgreSQL (Drizzle)

```typescript
import type { MemoryAdapter, Message, TaskState } from "msm-agent";
import { db } from "./db.js";
import { messages, tasks, taskSteps } from "./schema.js";
import { eq } from "drizzle-orm";

export class PostgresMemoryAdapter implements MemoryAdapter {
  async getConversation(sessionId: string): Promise<Message[]> {
    return db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(messages.timestamp);
  }

  async addMessage(sessionId: string, message: Message): Promise<void> {
    await db.insert(messages).values({ sessionId, ...message });
  }

  async getTask(taskId: string): Promise<TaskState | null> {
    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.taskId, taskId));
    return task ?? null;
  }

  async saveTask(task: TaskState): Promise<void> {
    await db.insert(tasks).values(task);
  }

  async updatePlan(taskId: string, plan: any): Promise<void> {
    await db.update(tasks).set({ plan }).where(eq(tasks.taskId, taskId));
  }

  async addStep(taskId: string, step: any): Promise<void> {
    await db.insert(taskSteps).values({ taskId, ...step });
  }

  async updateTaskStatus(taskId: string, status: string): Promise<void> {
    await db.update(tasks).set({ status }).where(eq(tasks.taskId, taskId));
  }
}
```

### Redis (for ControlBus + ephemeral state)

```typescript
import type { ControlBusAdapter, ControlCommand } from "msm-agent";
import Redis from "ioredis";

export class RedisControlBus implements ControlBusAdapter {
  constructor(private redis: Redis) {}

  async isTaskKilled(taskId: string): Promise<string | null> {
    return this.redis.get(`agent:kill:${taskId}`);
  }

  async isTenantPaused(tenantId: string): Promise<string | null> {
    return this.redis.get(`agent:pause:${tenantId}`);
  }

  async isToolDisabled(toolName: string): Promise<string | null> {
    return this.redis.get(`agent:disable:${toolName}`);
  }

  async execute(command: ControlCommand): Promise<void> {
    switch (command.type) {
      case "kill_task":
        // 1-hour TTL so kill flags auto-expire
        await this.redis.setex(
          `agent:kill:${command.taskId}`,
          3600,
          command.reason,
        );
        break;
      case "pause_tenant":
        await this.redis.set(`agent:pause:${command.tenantId}`, command.reason);
        break;
      case "resume_tenant":
        await this.redis.del(`agent:pause:${command.tenantId}`);
        break;
      case "disable_tool":
        await this.redis.set(
          `agent:disable:${command.toolName}`,
          command.reason,
        );
        break;
      case "enable_tool":
        await this.redis.del(`agent:disable:${command.toolName}`);
        break;
    }
  }
}
```

## Full Production Example

```typescript
import { createAgent, FlushGate } from "msm-agent";
import type { StepResult, Message } from "msm-agent";
import { Pipeline } from "msm-ai";

// ── Brain: your MSM pipeline with real LLM layers ──
const brain = {
  run: (input) => pipeline.run(input),
};

// ── Adapters: your project implementations ──
const memory = new MongoMemoryAdapter(mongoClient);
const tools = new ProjectToolAdapter(apiClients);
const events = new BullMQEventAdapter(redisConnection);
const delivery = new WhatsAppDeliveryAdapter(whatsappConfig);
const controlBus = new RedisControlBus(redis);

// ── Audit: buffered writes ──
const auditGate = new FlushGate<StepResult>({
  flush: async (steps) => await db.auditLog.insertMany(steps),
  intervalMs: 2000,
  onError: (err) => logger.error("Audit flush failed", err),
});
auditGate.start();

// ── Create agent ──
const agent = createAgent({
  brain,
  memory,
  tools,
  events,
  delivery,
  controlBus,
  tenantId: process.env.TENANT_ID,
  config: {
    maxIterations: 10,
    confidenceThreshold: 0.5,
    costCapPerTask: 1.0,
    timeoutMs: 60000,
  },

  // Fast-intent: skip the brain for greetings
  preHook: async (event) => {
    if (event.type === "user_message" && /^(hi|hello|hey)$/i.test(event.text)) {
      return {
        type: "response",
        text: "Hello! How can I help?",
        language: "en",
        payload: {} as any,
      };
    }
    return null;
  },

  // LLM-based history compaction instead of naive truncation
  compactHistory: async (messages: Message[]) => {
    if (messages.length <= 10)
      return messages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));
    const summary = await summarizeLLM(messages.slice(0, -6));
    const tail = messages.slice(-6).map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));
    return [
      { role: "assistant" as const, content: `[Summary] ${summary}` },
      ...tail,
    ];
  },

  onIteration: (state, step) => {
    auditGate.push(step);
    logger.info({
      iter: state.iteration,
      action: step.action,
      tool: step.toolName,
    });
  },
  onGuard: (signal) => {
    logger.warn({ guard: signal.type, ...signal });
  },
});

// ── Start ──
await agent.start();

// ── Graceful shutdown ──
process.on("SIGTERM", async () => {
  await agent.stop();
  await auditGate.stop();
  process.exit(0);
});
```

## API Reference

### `createAgent(options) → AgentHandle`

Creates an agent that wires adapters together. Returns `{ handleEvent, start, stop }`.

Key options beyond the 5 adapters:

| Option           | Type                                       | Description                                                                                         |
| ---------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `preHook`        | `(event) => Promise<LoopOutcome \| null>`  | Fast-intent gate — return an outcome to skip the brain loop entirely, or `null` to proceed normally |
| `compactHistory` | `(messages) => Promise<{role, content}[]>` | Custom history compaction — replace the built-in truncation with an LLM-based summarizer            |
| `controlBus`     | `ControlBusAdapter`                        | Runtime operability — kill tasks, pause tenants, disable tools                                      |
| `tenantId`       | `string`                                   | Tenant ID for control bus pause checks                                                              |
| `onIteration`    | `(state, step) => void`                    | Called after every loop iteration for observability                                                 |
| `onGuard`        | `(signal) => void`                         | Called when any guard fires                                                                         |

All events on the same `sessionId` are automatically serialized by a built-in session mutex to prevent concurrent execution races.

### `executeEvent(event, deps) → LoopOutcome`

Low-level: run a single event through the full loop. Use this for custom wiring instead of `createAgent`. **Note:** does not include session mutex or pre-hook — those are `createAgent`-level features.

### `checkGuards(state, config, action, confidence, toolName) → GuardSignal[]`

Check all guards for the current iteration. Returns signals (may be empty).

### `hasHardBlock(signals) → boolean`

Returns `true` if any signal is a hard block (requires stopping/converting the current action).

### `checkDedup(toolName, params, recentSteps) → DedupResult`

Check if a tool call is a duplicate of a recent successful call.

### `FlushGate<T>`

Generic buffered emitter. `push(item)`, `start()`, `stop()`, `flush()`, `.pending`.

### Planner functions

- `createPlan(steps, reasoning) → TaskPlan`
- `advancePlanStep(plan) → TaskPlan`
- `failPlanStep(plan) → TaskPlan`
- `canReplan(plan, maxReplans) → boolean`
- `replan(plan, newSteps, reasoning) → TaskPlan`
- `clearPlan() → null`
- `isPlanComplete(plan) → boolean`
- `getCurrentStep(plan) → PlanStep | null`

## LoopOutcome Types

| Type            | When                                                                   | Key fields                               |
| --------------- | ---------------------------------------------------------------------- | ---------------------------------------- |
| `response`      | Brain says respond/complete                                            | `text`, `textAr?`, `language`, `payload` |
| `clarification` | Brain says clarify or confidence too low                               | `question`, `questionAr?`, `payload`     |
| `escalated`     | Brain says escalate to human                                           | `reason`, `payload`                      |
| `delegated`     | Brain says delegate to another role                                    | `targetRole`, `payload`                  |
| `aborted`       | Control bus killed task or paused tenant                               | `taskId`, `reason`                       |
| `error`         | Brain returned no orchestration or malformed `use_tool` (no tool_name) | `error`, `payload?`                      |
| `custom`        | Brain returned non-standard action                                     | `action`, `payload`                      |

## Testing

107 tests across 10 test files:

```
pnpm test
```

All tests use the included dummy adapters — no external dependencies needed.

## License

MIT
