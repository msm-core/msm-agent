# msm-agent

Portable agent framework for the [MSM](https://github.com/msm-core/msm-ai) brain standard. The agent is the **hands** — it receives events, asks the brain what to do, executes tools, feeds results back, and delivers responses. The brain never executes anything; it only decides.

Brain-agnostic and pluggable — implement 5 adapter interfaces to connect your infrastructure.

```
npm install msm-agent
```

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
                 │  Brain          │
                 │  (any LLM       │
                 │   pipeline)     │
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

// 1. Define a brain (any function that takes input → returns a decision)
const brain = {
  run: async (input) => ({
    orchestration: { action: "respond" },
    generation: { text: `Echo: ${input.text}`, language: "en" },
  }),
};

// 2. Create the agent with dummy adapters
const agent = createAgent({
  brain,
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

### With MSM Brain (optional)

If you use [msm-ai](https://github.com/msm-core/msm-ai) as your brain, install the bridge:

```typescript
import { wrapMSM } from "msm-agent/bridge/msm";
import { Pipeline } from "msm-ai";

const pipeline = new Pipeline("my-agent", layers);
const brain = wrapMSM(pipeline);

const agent = createAgent({ brain, ...adapters });
```

## The 5 Adapter Interfaces

The agent framework provides the loop, guards, planning, and orchestration. **You provide 5 adapters** that connect it to your project's infrastructure. Each adapter has a dummy implementation included for testing.

### 1. MemoryAdapter — How the agent remembers

```typescript
import type { MemoryAdapter } from "msm-agent";

class MongoMemoryAdapter implements MemoryAdapter {
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

  // Optional: Semantic Memory
  async search(query: string, limit: number): Promise<MemoryEntry[]> {
    return vectorDb.search(query, limit);
  }
  async store(entry: MemoryEntry): Promise<void> {
    await vectorDb.upsert(entry);
  }
}
```

Production implementations typically use Redis for working memory and a database (MongoDB/Postgres) for conversation and task persistence. The optional `search()` method enables semantic memory enrichment — when implemented, the context builder automatically queries it every iteration.

### 2. ToolAdapter — How the agent executes tools

```typescript
import type { ToolAdapter, ToolDefinition, ToolResult } from "msm-agent";

class MyToolAdapter implements ToolAdapter {
  list(): ToolDefinition[] {
    return [
      {
        name: "search_products",
        description: "Search the product catalog",
        parameters: { query: { type: "string", required: true } },
        category: "catalog",
        rateLimit: { requestsPerMinute: 30 },
      },
      {
        name: "create_order",
        description: "Create a new order",
        parameters: { productId: { type: "string", required: true } },
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
      default:
        return {
          tool: name,
          status: "failed",
          result: { error: "Unknown tool" },
        };
    }
  }

  // Optional: parameter validation, rate limiting, idempotency checks
  validate?(
    name: string,
    params: Record<string, unknown>,
  ): { valid: boolean; errors: string[] };
  checkRateLimit?(name: string): number;
  checkIdempotency?(
    name: string,
    params: Record<string, unknown>,
  ): Promise<ToolResult | null>;
}
```

### 3. EventAdapter — How the agent receives work

```typescript
import type { EventAdapter, AgentEvent } from "msm-agent";

class BullMQEventAdapter implements EventAdapter {
  private handler: ((event: AgentEvent) => Promise<void>) | null = null;

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

### 4. DeliveryAdapter — How the agent delivers responses

```typescript
import type { DeliveryAdapter, LoopOutcome } from "msm-agent";

class WhatsAppDeliveryAdapter implements DeliveryAdapter {
  async send(sessionId: string, outcome: LoopOutcome) {
    const phone = await getPhoneForSession(sessionId);
    switch (outcome.type) {
      case "response":
        await whatsapp.sendText(phone, outcome.text);
        break;
      case "clarification":
        await whatsapp.sendText(phone, outcome.question);
        break;
      case "escalated":
        await escalationService.handoff(sessionId);
        break;
    }
  }

  // Optional: typing indicator, human approval for destructive tools
  async sendTyping?(sessionId: string): Promise<void>;
  async requestApproval?(
    sessionId: string,
    action: string,
    params: Record<string, unknown>,
  ): Promise<boolean>;
}
```

### 5. ControlBusAdapter — Runtime operability (optional)

```typescript
import type { ControlBusAdapter } from "msm-agent";

class RedisControlBus implements ControlBusAdapter {
  async isTaskKilled(taskId: string) {
    return redis.get(`agent:kill:${taskId}`);
  }
  async isTenantPaused(tenantId: string) {
    return redis.get(`agent:pause:${tenantId}`);
  }
  async isToolDisabled(toolName: string) {
    return redis.get(`agent:disable:${toolName}`);
  }
  async execute(command: ControlCommand) {
    /* ... */
  }
}
```

Commands: `PAUSE_TENANT`, `RESUME_TENANT`, `KILL_TASK`, `DISABLE_TOOL`, `ENABLE_TOOL`. Checked every loop iteration.

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
  controlBus: new RedisControlBus(redis),
  tenantId: "tenant-123",

  // Fast-intent pre-hook — skip the brain loop for trivials
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

  // Custom history compaction (replace naive truncation with LLM summary)
  compactHistory: async (messages) => {
    if (messages.length <= 10)
      return messages.map((m) => ({ role: m.role as any, content: m.content }));
    const summary = await llm.summarize(messages.slice(0, -6));
    const tail = messages
      .slice(-6)
      .map((m) => ({ role: m.role as any, content: m.content }));
    return [{ role: "assistant", content: `[Summary] ${summary}` }, ...tail];
  },

  // Observability hooks
  onIteration: (state, step) => {
    metrics.recordStep(step);
  },
  onGuard: (signal) => {
    logger.warn(`Guard fired: ${signal.type}`, signal);
  },
});
```

## The Execution Loop

Every event goes through this loop:

```
0. [Session Lock]  Acquire per-session mutex (prevents concurrent execution)
   [Pre-Hook]     If preHook returns an outcome → deliver & skip loop
1. [Control Bus]   Check: is task killed? Is tenant paused?
2. [Typing]        Send typing indicator via DeliveryAdapter
3. [Context]       Build brain input:
                     - Conversation history (compacted)
                     - Task state (status, plan progress, recent failures)
                     - Semantic memory (MemoryAdapter.search())
                     - Available tool catalog
                     - Tool results from previous iterations
4. [Brain]         Call brain → get orchestration decision
5. [Plan]          If brain returned a plan, track it
6. [Guards]        Check all guards:
                     - Confidence gate (< threshold → clarify)
                     - Iteration/cost/time budgets
                     - Repetition (3+ same tool → soft signal)
                     - Dead-end (4+ failures across 2+ tools → soft signal)
7. [Dispatch]      Route based on brain's action:
   respond/complete  → record → deliver → DONE
   escalate          → record → deliver → DONE
   clarify           → record → deliver → DONE
   delegate          → record → deliver → DONE
   use_tool          → continue to step 8
   use_tool (no name) → ABORT (INVALID_REASONING)
8. [Tool Disabled?] Check control bus
9. [Rate Limit?]   Check ToolAdapter.checkRateLimit()
10. [Dedup?]       Same tool+params already executed → return cached
11. [Validate]     ToolAdapter.validate() if available
12. [Approval]     If tool.requiresApproval → requestApproval()
13. [Execute]      ToolAdapter.execute()
14. [Record]       Save step to memory
15. [Plan Mgmt]    Success → advance plan. Failure → replan or freestyle
16. [Loop]         Go to step 1 with tool result as context
```

If the loop exhausts `maxIterations` without a terminal action, it force-responds with the last available text.

## Guard System

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

Hard guards block execution. Soft guards are advisory — passed via `onGuard` so you can decide how to handle them.

## FlushGate — Buffered Writes

```typescript
import { FlushGate } from "msm-agent";

const auditGate = new FlushGate<StepResult>({
  flush: async (steps) => {
    await db.auditLog.insertMany(steps);
  },
  intervalMs: 2000,
  maxBufferSize: 100,
  onError: (err, items) => {
    logger.error("Audit flush failed", err);
  },
});

auditGate.start();
```

## LoopOutcome Types

| Type            | When                                     | Key fields                               |
| --------------- | ---------------------------------------- | ---------------------------------------- |
| `response`      | Brain says respond/complete              | `text`, `textAr?`, `language`, `payload` |
| `clarification` | Brain says clarify or confidence too low | `question`, `questionAr?`, `payload`     |
| `escalated`     | Brain says escalate to human             | `reason`, `payload`                      |
| `delegated`     | Brain says delegate to another role      | `targetRole`, `payload`                  |
| `aborted`       | Control bus killed task or paused tenant | `taskId`, `reason`                       |
| `error`         | Brain returned malformed output          | `error`, `payload?`                      |
| `custom`        | Brain returned non-standard action       | `action`, `payload`                      |

## API Reference

### `createAgent(options) → AgentHandle`

Returns `{ handleEvent, start, stop }`.

| Option            | Type                                       | Description                                      |
| ----------------- | ------------------------------------------ | ------------------------------------------------ |
| `brain`           | `Brain`                                    | Decision engine — `{ run(input): BrainPayload }` |
| `memory`          | `MemoryAdapter`                            | Conversation and task persistence                |
| `tools`           | `ToolAdapter`                              | Tool catalog and execution                       |
| `events`          | `EventAdapter`                             | Event ingress (webhooks, queues, manual)         |
| `delivery`        | `DeliveryAdapter`                          | Response delivery (channels, console)            |
| `config?`         | `AgentConfig`                              | Iteration limits, thresholds, budgets            |
| `controlBus?`     | `ControlBusAdapter`                        | Runtime kill/pause/disable                       |
| `preHook?`        | `(event) => Promise<LoopOutcome \| null>`  | Fast-intent gate                                 |
| `compactHistory?` | `(messages) => Promise<{role, content}[]>` | Custom history compaction                        |
| `onIteration?`    | `(state, step) => void`                    | Observability hook                               |
| `onGuard?`        | `(signal) => void`                         | Guard firing hook                                |

### `executeEvent(event, deps) → LoopOutcome`

Low-level: run a single event through the full loop. No session mutex or pre-hook.

### `checkGuards(state, config, action, confidence, toolName) → GuardSignal[]`

### `hasHardBlock(signals) → boolean`

### `checkDedup(toolName, params, recentSteps) → DedupResult`

### `FlushGate<T>` — `push(item)`, `start()`, `stop()`, `flush()`, `.pending`

### Planner functions

`createPlan`, `advancePlanStep`, `failPlanStep`, `canReplan`, `replan`, `clearPlan`, `isPlanComplete`, `getCurrentStep`

## Progression Path

**Stage 1: Prototype (1 hour)**

```
msm-agent + InMemoryAdapter + MockToolAdapter + ManualEventAdapter + ConsoleDeliveryAdapter
```

All dummy adapters. Everything in-memory. Good for testing brain logic.

**Stage 2: Working agent (1 day)**

```
Replace MemoryAdapter → Postgres/MongoDB
Replace ToolAdapter → your 3-5 real tools
Replace EventAdapter → Express webhook or BullMQ
Replace DeliveryAdapter → your channel (API response, WebSocket, etc.)
```

**Stage 3: Production (1 week)**

```
Add ControlBusAdapter → Redis for runtime operability
Add rate limiting, approval gates, observability
Configure guards → cost cap, timeout, confidence threshold
Wire FlushGate for audit logs
```

**Stage 4: Scale**

```
Multiple channels, multi-tenant, rich tool catalog
LLM routing with circuit breakers (inside brain)
Alert engine + monitoring dashboards
Equipment-based tool resolution
```

## Docs

- [Production Readiness & Ownership Boundary](docs/production-readiness-and-boundary.md)
- [Integration Guide](docs/INTEGRATION-GUIDE.md)

## Testing

```
pnpm test
```

All tests use the included dummy adapters — no external dependencies needed.

## License

MIT
