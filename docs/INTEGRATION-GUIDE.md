# MSM Agent + Brain: Production Integration Guide

> How to build a production-grade AI agent using `msm-agent` (execution core) and `msm-ai` (brain pipeline).

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Quick Start](#quick-start)
- [The Contract: Brain Decides, Agent Executes](#the-contract-brain-decides-agent-executes)
- [Execution Loop Deep Dive](#execution-loop-deep-dive)
- [Adapter Reference](#adapter-reference)
  - [MemoryAdapter](#1-memoryadapter)
  - [ToolAdapter](#2-tooladapter)
  - [EventAdapter](#3-eventadapter)
  - [DeliveryAdapter](#4-deliveryadapter)
  - [ControlBusAdapter](#5-controlbusadapter)
- [Production Features](#production-features)
  - [Guard System](#guard-system)
  - [Plan Tracking](#plan-tracking)
  - [Tool Deduplication](#tool-deduplication)
  - [Approval Workflows](#approval-workflows)
  - [Task Resumption](#task-resumption)
  - [Output Sanitization](#output-sanitization)
  - [Input Guard (Prompt Injection Defense)](#input-guard-prompt-injection-defense)
  - [Conversation Repair](#conversation-repair)
  - [Cost Tracking](#cost-tracking)
  - [Evidence & Audit Trail](#evidence--audit-trail)
  - [Structured Response Formats](#structured-response-formats)
  - [Session Concurrency Control](#session-concurrency-control)
- [MSM Brain Configuration](#msm-brain-configuration)
- [Building Production Adapters](#building-production-adapters)
- [Full Integration Example](#full-integration-example)
- [Ownership Boundary](#ownership-boundary)
- [Production Readiness Checklist](#production-readiness-checklist)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                   YOUR PROJECT                       │
│                                                      │
│  ┌──────────┐  ┌─────────────┐  ┌────────────────┐  │
│  │ Channels │  │ Adapters    │  │ Domain Tools   │  │
│  │ WhatsApp │  │ Memory (DB) │  │ ERP, Booking,  │  │
│  │ Telegram │  │ Events (MQ) │  │ Payment, CRM   │  │
│  │ Web/API  │  │ Delivery    │  │ Knowledge Base │  │
│  │ Voice    │  │ Control Bus │  │                │  │
│  └────┬─────┘  └──────┬──────┘  └───────┬────────┘  │
│       │               │                 │            │
├───────┴───────────────┴─────────────────┴────────────┤
│                                                      │
│  ┌────────────────── msm-agent ───────────────────┐  │
│  │                                                │  │
│  │  Event → Input Guard → Context Assembly        │  │
│  │    → Brain Call → Guard Check → Dispatch:      │  │
│  │      ├─ respond → Sanitize → Deliver → Done    │  │
│  │      ├─ use_tool → Dedup → Execute → Loop      │  │
│  │      ├─ clarify → Pause → Wait for Reply       │  │
│  │      ├─ escalate → Route to Human              │  │
│  │      ├─ delegate → Route to Specialist         │  │
│  │      └─ approval → Pause → Wait for Decision   │  │
│  │                                                │  │
│  │  Guards │ Planner │ Dedup │ FlushGate │ Mutex  │  │
│  └────────────────────────┬───────────────────────┘  │
│                           │                          │
│  ┌──────────── msm-ai (Brain) ───────────────────┐  │
│  │                                                │  │
│  │  L1 Translation → L2 Classification            │  │
│  │    → L3 Orchestration → L4 Generation          │  │
│  │      → L5 Validation                           │  │
│  │                                                │  │
│  │  Manifest YAML │ Hooks │ Provider Registry     │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

**Three-layer ownership:**

| Layer       | Package     | What it does                                                                                                                               |
| ----------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Brain**   | `msm-ai`    | Decides what to do. 5-layer pipeline: translation, classification, orchestration, generation, validation. Stateless, never executes tools. |
| **Agent**   | `msm-agent` | Executes decisions. The loop: receive events, build context, call brain, run tools, deliver responses. Generic, pluggable via adapters.    |
| **Project** | Your app    | Wires everything. Real databases, real tools, real channels, real business logic, domain-specific policies.                                |

---

## Quick Start

```bash
npm install msm-ai msm-agent
```

### Minimal agent (testing, zero infrastructure):

```typescript
import { createPipeline, DummyRegistry } from "msm-ai";
import {
  createAgent,
  InMemoryAdapter,
  MockToolAdapter,
  ManualEventAdapter,
  ConsoleDeliveryAdapter,
} from "msm-agent";

// 1. Set up brain from manifest
const brain = await createPipeline("./manifests/my-domain.yaml");

// 2. Set up dummy adapters
const memory = new InMemoryAdapter();
const tools = new MockToolAdapter();
const events = new ManualEventAdapter();
const delivery = new ConsoleDeliveryAdapter();

// 3. Create agent
const agent = createAgent({ brain, memory, tools, events, delivery });

// 4. Process a message
const result = await agent.handleEvent({
  type: "user_message",
  sessionId: "test-1",
  text: "Book me an appointment for tomorrow at 3pm",
  modality: "text",
});

console.log(result);
// { type: "response", text: "...", language: "en", payload: {...}, evidence: [...], receipts: [...] }
```

### Production agent:

```typescript
import { wrapMSM } from "msm-agent/bridge/msm";
import {
  createAgent,
  MongoMemoryAdapter,
  BullMQEventAdapter,
  WhatsAppDeliveryAdapter,
  RedisControlBus,
} from "msm-agent";
import { DomainToolAdapter } from "./adapters/tools";

// msm-ai brain (optional — any Brain implementation works)
const brain = wrapMSM(await createPipeline("./manifests/salon-gulf.yaml"));

// Production adapters — all built into msm-agent
const memory = await MongoMemoryAdapter.connect(process.env.DATABASE_URL!);
const events = await BullMQEventAdapter.connect({
  redisUrl: process.env.REDIS_URL!,
  queueName: "agent-events",
  concurrency: 5,
});
const delivery = new WhatsAppDeliveryAdapter(whatsappConfig);
const controlBus = await RedisControlBus.connect(process.env.REDIS_URL!);

const agent = createAgent({
  brain,
  memory,
  tools: new DomainToolAdapter(toolRegistry),
  events,
  delivery,
  controlBus,
  tenantId: "tenant-123",

  config: {
    maxIterations: 6, // max loop iterations per task
    maxReplans: 2, // max plan retries before freestyle
    confidenceThreshold: 0.6, // below this → ask for clarification
    timeoutMs: 30_000, // 30s max per task
    costCapPerTask: 0.5, // $0.50 max per task
    toolDedup: true, // deduplicate redundant tool calls
    maxToolCallsPerTask: 10, // max 10 tool calls per task
  },

  // Observability
  onIteration: (state, step) => {
    metrics.recordIteration(state, step);
    tracer.span("agent.iteration", { step });
  },
  onGuard: (signal) => {
    metrics.recordGuard(signal);
    if (signal.type === "dead_end") alertOps(signal);
  },

  // Production hooks
  preHook: async (event) => {
    if (event.type === "user_message" && isGreeting(event.text)) {
      return {
        type: "response",
        text: "Hello! How can I help?",
        language: "en",
        payload: {},
      };
    }
    return null;
  },
  compactHistory: async (messages) => summarizeWithLLM(messages),
  costExtractor: (payload) => payload.trace?.totalCostUsd ?? 0,
  onPlanCreated: async (sessionId, plan) => {
    if (plan.steps.length > 1) {
      await delivery.send(sessionId, {
        type: "response",
        text: "Let me check on that for you...",
        language: "en",
        payload: {},
      });
    }
  },
  onFatalError: async (sessionId, error) => {
    logger.error("Agent fatal error", { sessionId, error });
    return "Sorry, something went wrong. Let me connect you with a team member.";
  },
  onInjectionDetected: async (sessionId, patterns) => {
    logger.warn("Prompt injection detected", { sessionId, patterns });
    return null; // continue with sanitized input
  },
});

await agent.start();
```

---

## The Contract: Brain Decides, Agent Executes

The MSM brain is **stateless and never executes tools**. It only decides what to do based on the input it receives.

```
Agent sends to brain:
  { raw: "Book me a table for 4",
    modality: "text",
    history: [...past messages...],
    tool_results: [...results from last tool call...],
    system_context: "Task state + memories + available tools" }

Brain returns:
  { orchestration: {
      action: "use_tool",           // or "respond", "escalate", "clarify", "delegate"
      tool_name: "create_booking",
      tool_params: { guests: 4 },
      confidence: 0.92,
      reasoning: "User wants a table reservation",
      plan: [{ description: "Create booking", tool_hint: "create_booking" }]
    },
    generation: { response_text: "I'll book that for you!", response_text_ar: "..." },
    final_output: { text: "I'll book that for you!", language: "en" }
  }
```

The **agent** then:

1. Checks guards (confidence, budget, repetition)
2. Executes the tool
3. Records the result
4. Calls brain again with the tool result
5. Brain says `action: "respond"` → agent delivers the response

---

## Execution Loop Deep Dive

The loop processes a single event through these phases:

### Phase 1: Input Processing

1. **Input Guard** — Strips prompt injection attempts (pattern matching + sanitization)
2. **Task Resumption** — Checks if this event resumes an existing task
   - `tool_callback` → resumes `waiting_tool` task
   - `approval_callback` → resumes `waiting_approval` task
   - `user_message` → resumes `waiting_clarification` task (or creates new)
3. **Run State Hydration** — Loads durable run state if available

### Phase 2: Iteration Loop (max 6 per task)

4. **Control Bus Check** — Is task killed? Tenant paused?
5. **Typing Indicator** — Show "agent is typing..."
6. **Context Assembly** — Build brain input from conversation, task state, memories, tools
7. **Brain Call** — Send to MSM pipeline, get decision back
8. **Cost Tracking** — Extract and accumulate LLM cost
9. **Plan Tracking** — Create/advance/fail plan steps, acknowledge multi-step plans
10. **Run State Persistence** — Save ephemeral state for durability
11. **Guard Check** — 8 guard signals (see table below)

### Phase 3: Action Dispatch

12. **Terminal Actions** → sanitize output → deliver → done
    - `respond/complete` → format response + evidence/receipts → deliver
    - `escalate` → route to human
    - `clarify` → pause task, wait for user reply
    - `delegate` → route to specialist role
13. **Tool Actions** → validate → dedup → approval → execute → record → loop
    - Control bus: tool disabled?
    - Rate limit: too many calls?
    - Distributed idempotency: already executed? (Redis NX)
    - In-process dedup: same call in recent steps?
    - Tool validation: params valid?
    - Approval gate: requires human approval?
      - Sync: returns true/false immediately
      - Async: returns "pending", pauses task, waits for `approval_callback`
    - TTL extension: extend run state before potentially long call
    - Execution: with AbortSignal for kill-task interrupt
    - Post-execution kill check: killed during tool call?
    - Record distributed idempotency result
    - Plan advance/fail management
14. **Custom Actions** → pass through to caller

### Phase 4: Terminal

15. **Output Sanitization** — Strips API keys, PII, secrets from response
16. **Evidence Chain** — Builds audit trail of all tool calls
17. **Conversation Repair** — On fatal error, sends user-friendly error message

---

## Adapter Reference

### 1. MemoryAdapter

The only stateful adapter. Must provide conversation and task persistence.

```typescript
interface MemoryAdapter {
  // Required: Conversation
  getConversation(sessionId: string): Promise<Message[]>;
  addMessage(sessionId: string, message: Message): Promise<void>;

  // Required: Task State
  getTask(taskId: string): Promise<TaskState | null>;
  saveTask(task: TaskState): Promise<void>;
  updatePlan(taskId: string, plan: TaskPlan): Promise<void>;
  addStep(taskId: string, step: StepResult): Promise<void>;
  updateTaskStatus(taskId: string, status: TaskStatus): Promise<void>;

  // Optional: Task Resumption (strongly recommended)
  getActiveTask?(sessionId: string): Promise<TaskState | null>;

  // Optional: Durable Run State (Redis-backed for production)
  saveRunState?(taskId: string, state: RunState): Promise<void>;
  loadRunState?(taskId: string): Promise<RunState | null>;
  extendRunStateTTL?(taskId: string): Promise<void>;

  // Optional: Semantic Memory (for context enrichment)
  search?(query: string, limit: number): Promise<MemoryEntry[]>;
  store?(entry: MemoryEntry): Promise<void>;
}
```

**Production implementation guide:**

| Method                       | Storage                              | Notes                                                                                               |
| ---------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `getConversation/addMessage` | MongoDB/Postgres                     | Index on `sessionId`                                                                                |
| `getTask/saveTask`           | MongoDB/Postgres                     | Index on `taskId`, `sessionId`                                                                      |
| `getActiveTask`              | Same DB                              | Query: `sessionId=X AND status IN (waiting_tool, waiting_clarification, waiting_approval, running)` |
| `saveRunState/loadRunState`  | Redis                                | Key: `agent_state:{taskId}`, TTL: 5 minutes                                                         |
| `extendRunStateTTL`          | Redis                                | `EXPIRE agent_state:{taskId} 300`                                                                   |
| `search`                     | Qdrant / MongoDB Atlas Vector Search | Embed query → cosine similarity search                                                              |
| `store`                      | Same vector DB                       | With confidence decay: `effective = confidence × e^(-decayRate × days)`                             |

**Recommended memory layers (implement via `search` + `system_context`):**

1. **Working Memory** — Current task state (built-in via `RunState`)
2. **Episodic Memory** — Past task summaries (last 10 relevant)
3. **Semantic Memory** — Business facts with confidence decay
4. **Procedural Memory** — Standard workflows per role
5. **Reflection Memory** — Self-corrections from past failures

### 2. ToolAdapter

How the agent executes tools. The heart of your domain integration.

```typescript
interface ToolAdapter {
  // Required
  list(): ToolDefinition[];
  execute(
    name: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult>;

  // Optional: Validation
  validate?(
    name: string,
    params: Record<string, unknown>,
  ): ToolValidationResult;

  // Optional: Rate Limiting
  checkRateLimit?(name: string): number; // ms to wait, 0 = ok

  // Optional: Distributed Idempotency (recommended for destructive tools)
  checkIdempotency?(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<ToolResult | null>;
  recordIdempotency?(
    toolName: string,
    params: Record<string, unknown>,
    result: ToolResult,
  ): Promise<void>;
}
```

**ToolDefinition:**

```typescript
{
  name: "create_booking",
  description: "Create a new appointment booking",
  parameters: {
    serviceId: { type: "string", description: "Service ID", required: true },
    date: { type: "string", description: "Date (ISO 8601)", required: true },
    customerName: { type: "string", description: "Customer name", required: true },
  },
  destructive: true,          // → gets distributed dedup protection
  requiresApproval: true,     // → requires human approval before execution
  category: "booking",
  rateLimit: { requestsPerMinute: 10 },
}
```

**Distributed Idempotency (production pattern):**

```typescript
// Redis-based implementation
async checkIdempotency(toolName: string, params: Record<string, unknown>) {
  const key = `dedup:${sha256(`${toolName}:${stableStringify(params)}`).slice(0, 16)}`;

  // Check for cached result
  const cached = await redis.get(`result:${key}`);
  if (cached) return JSON.parse(cached);

  // Try to reserve (NX = only if not exists)
  const reserved = await redis.set(`inflight:${key}`, "1", "NX", "EX", 60);
  if (!reserved) return null; // Another worker is processing this

  return null; // Proceed with execution
}

async recordIdempotency(toolName: string, params: Record<string, unknown>, result: ToolResult) {
  const key = `dedup:${sha256(`${toolName}:${stableStringify(params)}`).slice(0, 16)}`;
  await redis.set(`result:${key}`, JSON.stringify(result), "EX", 3600); // 1 hour
  await redis.del(`inflight:${key}`);
}
```

### 3. EventAdapter

How the agent receives work. Wire to your messaging infrastructure.

```typescript
interface EventAdapter {
  onEvent(handler: (event: AgentEvent) => Promise<void>): void;
  start(): Promise<void>; // Open webhooks, connect queues, start cron
  stop(): Promise<void>;
}
```

**Event types:**

| Type                | When                     | Resume?                               |
| ------------------- | ------------------------ | ------------------------------------- |
| `user_message`      | Customer sends a message | Resumes `waiting_clarification` tasks |
| `tool_callback`     | Async tool completes     | Resumes `waiting_tool` tasks          |
| `approval_callback` | Human approves/denies    | Resumes `waiting_approval` tasks      |
| `webhook`           | External system event    | Creates new task                      |
| `cron`              | Scheduled job            | Creates new task                      |

**BullMQ implementation pattern:**

```typescript
class BullMQEventAdapter implements EventAdapter {
  private handler!: (event: AgentEvent) => Promise<void>;
  private worker!: Worker;

  onEvent(handler: (event: AgentEvent) => Promise<void>) {
    this.handler = handler;
  }

  async start() {
    this.worker = new Worker(
      "agent-tasks",
      async (job) => {
        await this.handler(job.data as AgentEvent);
      },
      {
        connection: redis,
        concurrency: 5,
        limiter: { max: 100, duration: 1000 },
      },
    );

    // Dead-letter handling
    this.worker.on("failed", (job, err) => {
      if (job && job.attemptsMade >= 3) {
        logger.error("Job dead-lettered", { jobId: job.id, error: err });
      }
    });
  }

  async stop() {
    await this.worker.close();
  }
}
```

### 4. DeliveryAdapter

How the agent sends responses back to users.

```typescript
interface DeliveryAdapter {
  send(sessionId: string, outcome: LoopOutcome): Promise<void>;

  // Optional: Approval flow (two modes)
  requestApproval?(
    sessionId: string,
    taskId: string,
    toolName: string,
    toolParams: Record<string, unknown>,
    reasoning: string,
  ): Promise<boolean | "pending">;

  // Optional: Typing indicator
  sendTyping?(sessionId: string): Promise<void>;
}
```

**Approval modes:**

| Mode      | Return           | Use case                                               |
| --------- | ---------------- | ------------------------------------------------------ |
| **Sync**  | `true` / `false` | CLI prompts, web modals                                |
| **Async** | `"pending"`      | WhatsApp buttons, Telegram keyboards, dashboard clicks |

When `requestApproval` returns `"pending"`, the agent pauses the task and returns a `waiting_approval` outcome. Your system should:

1. Store the approval request (taskId + toolName + params)
2. Notify the human (WhatsApp button, email, dashboard)
3. When they decide, send an `approval_callback` event

**Rich response format:**

The `LoopOutcome` includes an optional `responseFormat` for structured channel rendering:

```typescript
// Brain can indicate rich format via generation.response_format
{
  type: "buttons",
  items: [
    { id: "confirm", title: "Confirm Booking", titleAr: "تأكيد الحجز" },
    { id: "cancel", title: "Cancel", titleAr: "إلغاء" },
  ],
  actions: ["confirm", "cancel"],
}
```

Your delivery adapter should check `outcome.responseFormat?.type` and render accordingly per channel.

### 5. ControlBusAdapter

Runtime operability — kill tasks, pause tenants, disable tools.

```typescript
interface ControlBusAdapter {
  isTaskKilled(taskId: string): Promise<string | null>;
  isTenantPaused(tenantId: string): Promise<string | null>;
  isToolDisabled(toolName: string): Promise<string | null>;
  execute(command: ControlCommand): Promise<void>;
}
```

**Commands:**

```typescript
// Kill a runaway task
bus.execute({
  type: "kill_task",
  taskId: "task-123",
  reason: "Operator killed via dashboard",
});

// Pause all tasks for a tenant (maintenance, billing)
bus.execute({
  type: "pause_tenant",
  tenantId: "t-456",
  reason: "Payment overdue",
});

// Disable a broken tool globally
bus.execute({
  type: "disable_tool",
  toolName: "erp_create_order",
  reason: "ERP down for maintenance",
});
```

**Redis implementation (production pattern):**

```typescript
class RedisControlBusAdapter implements ControlBusAdapter {
  async isTaskKilled(taskId: string) {
    return await redis.get(`c2:killed_task:${taskId}`);
  }
  async isTenantPaused(tenantId: string) {
    return await redis.get(`c2:paused_tenant:${tenantId}`);
  }
  async isToolDisabled(toolName: string) {
    const disabled = await redis.sismember("c2:disabled_tools", toolName);
    return disabled ? `Tool ${toolName} is disabled` : null;
  }
  async execute(cmd: ControlCommand) {
    switch (cmd.type) {
      case "kill_task":
        await redis.set(`c2:killed_task:${cmd.taskId}`, cmd.reason, "EX", 3600);
        break;
      case "pause_tenant":
        await redis.set(`c2:paused_tenant:${cmd.tenantId}`, cmd.reason);
        break;
      case "resume_tenant":
        await redis.del(`c2:paused_tenant:${cmd.tenantId}`);
        break;
      case "disable_tool":
        await redis.sadd("c2:disabled_tools", cmd.toolName);
        break;
      case "enable_tool":
        await redis.srem("c2:disabled_tools", cmd.toolName);
        break;
    }
  }
}
```

---

## Production Features

### Guard System

8 guard signals checked every iteration:

| Guard               | Type | Trigger                                | Action                   |
| ------------------- | ---- | -------------------------------------- | ------------------------ |
| **Confidence Gate** | Hard | Tool call confidence < threshold (0.6) | Convert to clarification |
| **Iteration Limit** | Hard | Iteration ≥ max (6)                    | Force respond            |
| **Cost Cap**        | Hard | Total cost ≥ cap                       | Force respond            |
| **Tool Call Limit** | Hard | Tool calls ≥ max                       | Force respond            |
| **Time Limit**      | Hard | Elapsed ≥ timeout                      | Force respond            |
| **Repetition**      | Soft | Same tool called 3+ times              | Signal via `onGuard`     |
| **Dead End**        | Soft | 4+ failures across 2+ tools            | Signal via `onGuard`     |
| **Rate Limited**    | Soft | Tool rate-limited                      | Signal via `onGuard`     |

Hard guards **block execution**. Soft guards are **advisory** — the brain receives failure context on the next iteration and can adjust strategy.

### Plan Tracking

The brain generates plans; the agent tracks their state:

```
Brain: { plan: [
  { description: "Look up customer", tool_hint: "find_customer" },
  { description: "Check availability", tool_hint: "check_slots" },
  { description: "Create booking", tool_hint: "create_booking" }
]}

Agent tracks:
  Step 1: ✅ done (find_customer succeeded)
  Step 2: ● current (check_slots executing)
  Step 3: ○ pending
```

- **Advance**: On tool success → `current → done`, `pending → current`
- **Fail**: On tool failure → `current → failed`
- **Replan**: Brain generates new plan (max 2 replans)
- **Freestyle**: After max replans, plan is cleared — brain figures it out ad-hoc

Multi-step plans (>1 step) trigger the `onPlanCreated` hook for acknowledge messages.

### Tool Deduplication

Two layers of protection:

1. **In-process dedup** — Scans recent steps for same `toolName + sorted params hash`. Returns cached result for successful calls. Always active.

2. **Distributed dedup** — For destructive tools (`destructive: true`), calls `ToolAdapter.checkIdempotency()` before execution. Uses Redis `SET NX` pattern for cross-worker safety.

### Approval Workflows

Tools marked `requiresApproval: true` trigger the approval gate:

**Sync mode** (simple):

```typescript
// DeliveryAdapter returns boolean immediately
async requestApproval(sessionId, taskId, toolName, params, reasoning) {
  // Show modal, wait for click
  return await showApprovalModal(toolName, params);
}
```

**Async/Durable mode** (production):

```typescript
// DeliveryAdapter returns "pending", agent pauses
async requestApproval(sessionId, taskId, toolName, params, reasoning) {
  await createApprovalRequest(taskId, toolName, params);
  await sendWhatsAppButtons(sessionId, `Approve ${toolName}?`, [
    { id: `approve_${taskId}`, title: "✅ Approve" },
    { id: `reject_${taskId}`, title: "❌ Reject" },
  ]);
  return "pending"; // Agent pauses, returns waiting_approval outcome
}

// Later, when human clicks button:
// Send approval_callback event to resume the task
events.emit({
  type: "approval_callback",
  sessionId: "s1",
  taskId: "task-123",
  approved: true,
  decidedBy: "owner@company.com",
});
```

### Task Resumption

Tasks can be paused and resumed across multiple events:

| Pause state             | Resume trigger                           | What happens                                                |
| ----------------------- | ---------------------------------------- | ----------------------------------------------------------- |
| `waiting_clarification` | `user_message` with matching session     | Task resumes with new user input                            |
| `waiting_tool`          | `tool_callback` with matching taskId     | Task resumes with tool result                               |
| `waiting_approval`      | `approval_callback` with matching taskId | If approved: execution continues. If denied: brain replans. |

**Durable resumption** requires implementing `saveRunState/loadRunState/extendRunStateTTL` on your `MemoryAdapter`. Without these, run state is lost on process restart and resumed tasks start iteration counts from 0.

### Output Sanitization

All agent responses are automatically sanitized before delivery:

- GitHub tokens (`ghp_...`)
- GitLab tokens (`glpat-...`)
- Slack tokens (`xoxb-...`, `xoxp-...`)
- AWS access keys (`AKIA...`)
- OpenAI/Anthropic API keys (`sk-...`)
- Generic secret patterns (`api_key=...`, `token: ...`)
- Credit card numbers
- SSN patterns
- Qatari national IDs (QID)
- Control characters

Redacted values become `[REDACTED]`. The `SanitizeResult` includes a list of what was redacted for logging.

You can also use the utilities directly:

```typescript
import { sanitizeOutput, containsSensitiveData } from "msm-agent";

const { text, redacted } = sanitizeOutput(responseText);
if (redacted.length > 0) logger.warn("Redacted sensitive data", { redacted });
```

### Input Guard (Prompt Injection Defense)

User input is automatically guarded against prompt injection:

**Tier 1: Pattern matching** — 13+ patterns: "ignore previous instructions", "system prompt", "jailbreak", "DAN mode", unicode injection, etc.

**Tier 2: Sanitization** — Length limiting (8000 chars), control character removal, script tag stripping, zero-width character removal.

Injection detection triggers `onInjectionDetected` hook. Return a `LoopOutcome` to short-circuit, or `null` to continue with the cleaned input.

For **Tier 3 (embedding-similarity defense)**, implement it in your `preHook`:

```typescript
preHook: async (event) => {
  if (event.type === "user_message") {
    const embedding = await embed(event.text);
    const similarity = cosineSim(embedding, adversarialBlocklist);
    if (similarity > 0.8) {
      return {
        type: "response",
        text: "I can only help with business questions.",
        language: "en",
        payload: {},
      };
    }
  }
  return null;
};
```

### Conversation Repair

When the brain crashes or a fatal error occurs, the `onFatalError` hook generates a user-friendly recovery message:

```typescript
onFatalError: async (sessionId, error) => {
  logger.error("Agent fatal error", { sessionId, error });
  return "I'm sorry, something went wrong. Let me connect you with a team member who can help.";
};
```

The repair message is automatically delivered to the user before the error outcome is returned.

### Cost Tracking

```typescript
costExtractor: (payload) => {
  // Extract from brain's trace or calculate from token counts
  const trace = payload.trace;
  if (trace?.layers) {
    return Object.values(trace.layers).reduce(
      (sum, l) => sum + (l.costUsd ?? 0),
      0,
    );
  }
  return 0;
};
```

Cost accumulates in `RunState.totalCostUsd` across iterations. The `budget_cost` guard triggers when total exceeds `config.costCapPerTask`.

### Evidence & Audit Trail

Every terminal response includes:

- **`evidence: ResponseEvidence[]`** — Internal: tool name, params, result, cost, latency, timestamp for each tool call
- **`receipts: ActionReceipt[]`** — Customer-visible: action name, reference ID, summary for successful tool calls

```typescript
// Example response
{
  type: "response",
  text: "Your booking is confirmed!",
  evidence: [{
    toolName: "create_booking",
    toolParams: { serviceId: "haircut", date: "2026-04-14T15:00" },
    toolResult: { bookingId: "BK-789", status: "confirmed" },
    costUsd: 0.002,
    latencyMs: 340,
    timestamp: "2026-04-13T12:30:00Z"
  }],
  receipts: [{
    action: "create_booking",
    reference: "create_booking-2",
    summary: "Created booking for haircut on April 14 at 3pm",
    timestamp: "2026-04-13T12:30:00Z"
  }]
}
```

### Structured Response Formats

The brain can indicate rich response formats for channel-specific rendering:

```typescript
// In brain's generation layer output
{
  response_text: "Here are your options:",
  response_format: {
    type: "buttons",    // "text" | "list" | "buttons" | "carousel" | "confirmation"
    items: [
      { id: "opt1", title: "Standard Cut", subtitle: "$30" },
      { id: "opt2", title: "Premium Cut", subtitle: "$50" },
    ],
    actions: ["opt1", "opt2"]
  }
}
```

The `responseFormat` is passed through to the `LoopOutcome`. Your `DeliveryAdapter` renders it per channel:

- **WhatsApp**: Interactive button / list messages
- **Telegram**: Inline keyboard
- **Web**: Custom UI components
- **SMS**: Fallback to plain text

### Session Concurrency Control

The agent includes a built-in per-session mutex that prevents race conditions:

```
User sends "Yes" twice on WhatsApp (double-tap)
  → First "Yes" enters the loop
  → Second "Yes" queues behind the first
  → No duplicate tool executions
```

This is automatic — no configuration needed.

---

## MSM Brain Configuration

Create a manifest YAML for your domain:

```yaml
msm_version: "1.0"
manifest_id: "salon-gulf-v1"
domain: "beauty-salon"
region: "gulf-arabic"
created: "2026-04-13"

layers:
  translation:
    provider: "ollama"
    model: "qwen2.5:3b"
    version: "1.0.0"
    mode: "translated"

  classification:
    provider: "ollama"
    model: "qwen2.5:3b"
    version: "1.0.0"

  orchestration:
    provider: "ollama"
    model: "qwen2.5:3b"
    version: "1.0.0"

  generation:
    provider: "ollama"
    model: "qwen2.5:3b"
    version: "1.0.0"

  validation:
    provider: "dummy" # Policy-based, no LLM needed
    model: "policy-v1"
    version: "1.0.0"

hooks:
  # Domain-specific extensions
  price_check:
    provider: "http"
    model: "price-validator-v1"
    version: "1.0"
    point: "after:generation"
    endpoint: "http://localhost:8010/validate-prices"
```

**Provider options:**

| Provider | Use case          | Notes                                 |
| -------- | ----------------- | ------------------------------------- |
| `dummy`  | Testing, CI/CD    | Zero dependencies, keyword-based      |
| `ollama` | Local development | Requires Ollama server                |
| `http`   | Production        | Any HTTP endpoint (vLLM, TGI, custom) |

---

## Building Production Adapters

### Recommended project structure

```
my-project/
├── manifests/
│   └── my-domain.yaml          # MSM brain configuration
├── src/
│   ├── brain/
│   │   └── pipeline.ts         # msm-ai setup
│   ├── agent/
│   │   ├── index.ts            # createAgent wiring
│   │   └── adapters/
│   │       ├── memory.ts       # MongoDB/Redis implementation
│   │       ├── tools.ts        # Domain tools + ERP connectors
│   │       ├── events.ts       # BullMQ or webhook ingestion
│   │       ├── delivery.ts     # WhatsApp / Telegram / Web
│   │       └── control-bus.ts  # Redis command dispatcher
│   ├── channels/
│   │   ├── whatsapp.ts         # Message parsing + pre-gates
│   │   ├── telegram.ts
│   │   └── web.ts
│   ├── tools/
│   │   ├── registry.ts         # Tool catalog
│   │   ├── booking.ts          # Domain tools
│   │   └── crm.ts
│   ├── observability/
│   │   ├── metrics.ts          # Prometheus/Datadog
│   │   ├── traces.ts           # OpenTelemetry
│   │   └── quality.ts          # QA loops
│   └── workers/
│       ├── agent-worker.ts     # BullMQ agent task worker
│       ├── memory-worker.ts    # Background memory operations
│       └── cron-worker.ts      # Scheduled jobs
├── package.json
└── tsconfig.json
```

### Memory adapter skeleton (MongoDB + Redis)

```typescript
import { MongoClient } from "mongodb";
import { Redis } from "ioredis";
import type { MemoryAdapter, MemoryEntry } from "msm-agent";
import type {
  Message,
  TaskState,
  RunState,
  TaskPlan,
  StepResult,
} from "msm-agent";

export class MongoRedisMemoryAdapter implements MemoryAdapter {
  constructor(
    private db: MongoClient,
    private redis: Redis,
  ) {}

  // ─── Conversation (MongoDB) ──────────
  async getConversation(sessionId: string): Promise<Message[]> {
    return await this.db
      .db()
      .collection("messages")
      .find({ sessionId })
      .sort({ timestamp: 1 })
      .toArray();
  }

  async addMessage(sessionId: string, message: Message) {
    await this.db
      .db()
      .collection("messages")
      .insertOne({ sessionId, ...message });
  }

  // ─── Task State (MongoDB) ───────────
  async getTask(taskId: string) {
    return await this.db.db().collection("tasks").findOne({ taskId });
  }

  async saveTask(task: TaskState) {
    await this.db.db().collection("tasks").insertOne(task);
  }

  async updateTaskStatus(taskId: string, status: string) {
    await this.db
      .db()
      .collection("tasks")
      .updateOne(
        { taskId },
        { $set: { status, completedAt: new Date().toISOString() } },
      );
  }

  async addStep(taskId: string, step: StepResult) {
    await this.db
      .db()
      .collection("tasks")
      .updateOne({ taskId }, { $push: { steps: step } });
  }

  async updatePlan(taskId: string, plan: TaskPlan) {
    await this.db
      .db()
      .collection("tasks")
      .updateOne({ taskId }, { $set: { plan } });
  }

  async getActiveTask(sessionId: string) {
    return await this.db
      .db()
      .collection("tasks")
      .findOne(
        {
          sessionId,
          status: {
            $in: [
              "waiting_tool",
              "waiting_clarification",
              "waiting_approval",
              "running",
            ],
          },
        },
        { sort: { startedAt: -1 } },
      );
  }

  // ─── Durable Run State (Redis) ──────
  async saveRunState(taskId: string, state: RunState) {
    await this.redis.set(
      `agent_state:${taskId}`,
      JSON.stringify(state),
      "EX",
      300,
    );
  }

  async loadRunState(taskId: string) {
    const data = await this.redis.get(`agent_state:${taskId}`);
    return data ? JSON.parse(data) : null;
  }

  async extendRunStateTTL(taskId: string) {
    await this.redis.expire(`agent_state:${taskId}`, 300);
  }

  // ─── Semantic Memory (MongoDB Atlas Vector Search) ──
  async search(query: string, limit: number): Promise<MemoryEntry[]> {
    const embedding = await embedQuery(query);
    return await this.db
      .db()
      .collection("memories")
      .aggregate([
        {
          $vectorSearch: {
            index: "memory_vector_index",
            path: "embedding",
            queryVector: embedding,
            numCandidates: limit * 5,
            limit,
          },
        },
      ])
      .toArray();
  }

  async store(entry: MemoryEntry) {
    const embedding = await embedQuery(entry.content);
    await this.db
      .db()
      .collection("memories")
      .insertOne({ ...entry, embedding });
  }
}
```

---

## Full Integration Example

Complete WhatsApp booking agent:

```typescript
import { wrapMSM } from "msm-agent/bridge/msm";
import {
  createAgent,
  FlushGate,
  MongoMemoryAdapter,
  BullMQEventAdapter,
  WhatsAppDeliveryAdapter,
  RedisControlBus,
} from "msm-agent";
import { BookingToolAdapter } from "./adapters/tools";

// ─── Brain ────────────────
const brain = wrapMSM(await createPipeline("./manifests/salon-gulf.yaml"));

// ─── Adapters (built into msm-agent) ──────────────
const memory = await MongoMemoryAdapter.connect(process.env.DATABASE_URL!);
const events = await BullMQEventAdapter.connect({
  redisUrl: process.env.REDIS_URL!,
  concurrency: 5,
});
const delivery = new WhatsAppDeliveryAdapter(whatsappConfig);
const controlBus = await RedisControlBus.connect(process.env.REDIS_URL!);
const tools = new BookingToolAdapter(erpClient, knowledgeBase);

// ─── Observability ────────
const auditGate = new FlushGate<AuditEntry>({
  flush: (entries) => mongo.db().collection("audit").insertMany(entries),
  intervalMs: 2000,
  maxBufferSize: 50,
});
auditGate.start();

// ─── Agent ────────────────
const agent = createAgent({
  brain,
  memory,
  tools,
  events,
  delivery,
  controlBus,
  tenantId: process.env.TENANT_ID!,

  config: {
    maxIterations: 6,
    maxReplans: 2,
    confidenceThreshold: 0.6,
    timeoutMs: 30_000,
    costCapPerTask: 0.5,
    toolDedup: true,
    maxToolCallsPerTask: 10,
  },

  onIteration: (state, step) => {
    auditGate.push({
      type: "iteration",
      taskId: state.recentSteps[0]?.timestamp,
      step: step.toolName ?? step.action,
      latencyMs: step.latencyMs,
      timestamp: new Date().toISOString(),
    });
  },

  onGuard: (signal) => {
    auditGate.push({
      type: "guard",
      guard: signal.type,
      timestamp: new Date().toISOString(),
    });
    if (signal.type === "dead_end") {
      // Alert ops team
      notifySlack(`Dead-end detected: ${JSON.stringify(signal)}`);
    }
  },

  preHook: async (event) => {
    if (event.type !== "user_message") return null;
    // Greeting fast-path
    if (/^(hi|hello|hey|مرحبا|السلام عليكم)/i.test(event.text)) {
      return {
        type: "response",
        text: "Hello! How can I help you today?",
        textAr: "مرحباً! كيف يمكنني مساعدتك؟",
        language: "ar",
        payload: {} as any,
      };
    }
    // FAQ auto-answer
    const faq = await knowledgeBase.matchFAQ(event.text, 0.85);
    if (faq) {
      return {
        type: "response",
        text: faq.answer,
        textAr: faq.answerAr,
        language: "en",
        payload: {} as any,
      };
    }
    return null;
  },

  compactHistory: async (messages) => {
    if (messages.length <= 10) {
      return messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        }));
    }
    // LLM-based summarization
    const summary = await summarizeConversation(messages.slice(0, -6));
    const tail = messages.slice(-6).map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));
    return [
      { role: "assistant" as const, content: `[Summary: ${summary}]` },
      ...tail,
    ];
  },

  costExtractor: (payload) => payload.trace?.totalCostUsd ?? 0,

  onPlanCreated: async (sessionId, plan) => {
    if (plan.steps.length > 1) {
      await delivery.send(sessionId, {
        type: "response",
        text: "Let me check on that for you...",
        textAr: "دقيقة، خلني أتأكد لك...",
        language: "ar",
        payload: {} as any,
      });
    }
  },

  onFatalError: async (sessionId, error) => {
    logger.error("Fatal agent error", { sessionId, error });
    return "I apologize, something went wrong. Let me connect you with our team.";
  },

  onInjectionDetected: async (sessionId, patterns) => {
    logger.warn("Injection attempt", { sessionId, patterns });
    return null; // Continue with cleaned input
  },
});

// ─── Start ────────────────
await agent.start();
console.log("Agent is running and listening for events");

// ─── Graceful Shutdown ───
process.on("SIGTERM", async () => {
  await agent.stop();
  await auditGate.stop();
  process.exit(0);
});
```

---

## Ownership Boundary

| Concern                                                          | Owner        | Why                  |
| ---------------------------------------------------------------- | ------------ | -------------------- |
| Translation, classification, generation, validation              | `msm-ai`     | Domain reasoning     |
| LLM provider routing, failover, model selection                  | `msm-ai`     | Brain infrastructure |
| Execution loop, guards, planner, dedup, mutex                    | `msm-agent`  | Generic runtime      |
| Adapter contracts (memory, tools, events, delivery, control bus) | `msm-agent`  | Pluggable interfaces |
| Real database adapters                                           | Your project | Business-specific    |
| Domain tools & ERP connectors                                    | Your project | Integration-specific |
| Channel SDKs (WhatsApp, Telegram)                                | Your project | Channel-specific     |
| Approval workflow UX & durability                                | Your project | Business process     |
| Employee routing & access control                                | Your project | Business logic       |
| Observability dashboards & alerting                              | Your project | Ops infrastructure   |
| Token metering & billing                                         | Your project | Business model       |
| Knowledge base & FAQ management                                  | Your project | Content management   |

---

## Production Readiness Checklist

Before claiming production readiness, verify:

### Infrastructure

- [ ] Persistent `MemoryAdapter` implemented and load tested (conversations, tasks, run state)
- [ ] Distributed idempotency for destructive tools (`checkIdempotency/recordIdempotency` via Redis)
- [ ] Durable run state (`saveRunState/loadRunState/extendRunStateTTL` via Redis with TTL)
- [ ] Event adapter with retry and dead-letter policies (BullMQ recommended)
- [ ] Control bus connected and tested (kill/pause/disable)

### Resilience

- [ ] LLM failover chain configured in brain (primary → secondary → tertiary)
- [ ] Tool adapter handles transient failures with retry
- [ ] Graceful degradation: memory search failure doesn't crash the loop
- [ ] Fatal error repair message configured (`onFatalError`)
- [ ] Typing indicators for user experience

### Security

- [ ] Output sanitization active (automatic — verify no secrets in test responses)
- [ ] Input guard active (automatic — verify injection patterns don't reach brain)
- [ ] Approval workflows for destructive tools
- [ ] Tenant isolation in all database queries
- [ ] API key encryption for multi-tenant LLM access

### Observability

- [ ] `onIteration` wired to metrics/tracing (every loop step recorded)
- [ ] `onGuard` wired to alerting (dead-end and repetition signals monitored)
- [ ] `FlushGate` for batched audit persistence
- [ ] Cost tracking via `costExtractor` (per-task USD tracking)
- [ ] Evidence chain available on all responses

### Quality

- [ ] `compactHistory` uses LLM-based summarization (not just truncation)
- [ ] `preHook` handles greetings and FAQ auto-answer
- [ ] Domain-specific evaluation scenarios passing at target accuracy
- [ ] Plan acknowledgment for multi-step tasks (`onPlanCreated`)
- [ ] Structured response formats rendering correctly per channel

### Operations

- [ ] Graceful shutdown drains FlushGate and stops event adapter
- [ ] Session mutex prevents double-tap race conditions (automatic)
- [ ] Token/cost budgets enforce per-tenant limits
- [ ] Ownership boundary documented for team contributors
