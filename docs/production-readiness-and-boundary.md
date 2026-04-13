# msm-agent Production Readiness and Ownership Boundary

Date: 2026-04-13

## Purpose

This document answers two questions:

1. Is msm-agent feature-complete with Dalil production agent behavior?
2. What code belongs to the project app vs msm-agent vs MSM brain?

Short answer:

- msm-agent is a strong portable execution core.
- msm-agent is not the full Dalil platform.
- Production parity requires project-level systems around the core.

## Dalil Baseline Used For Comparison

Production baseline was taken from:

- kader/dalil/doc/internals/execution-engine.md
- kader/dalil/doc/internals/tool-system.md
- kader/dalil/doc/internals/memory-system.md
- kader/dalil/doc/internals/channel-system.md
- kader/dalil/doc/internals/observability-system.md
- kader/dalil/doc/internals/llm-subsystem.md

## Parity Matrix

| Capability                                      | Dalil baseline                                               | msm-agent status                                | Owner                       |
| ----------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------- | --------------------------- |
| Core event -> context -> brain -> dispatch loop | 22-step production loop                                      | Implemented                                     | msm-agent                   |
| Per-session concurrency lock                    | Session-safe execution                                       | Implemented                                     | msm-agent                   |
| Fast-intent pre-hook                            | Greeting/FAQ short-circuit                                   | Implemented                                     | msm-agent + project rules   |
| Guard system                                    | Confidence, budget, repetition, dead-end                     | Implemented (core set)                          | msm-agent                   |
| Tool validation hook                            | 7-check validation in gateway                                | Adapter hook available                          | project ToolAdapter         |
| Tool rate limit hook                            | Per-tenant per-tool limits                                   | Adapter hook available                          | project ToolAdapter         |
| Plan tracking                                   | Create/advance/fail/replan tracking                          | Implemented                                     | msm-agent                   |
| Context enrichment                              | Task + memories + tool catalog                               | Implemented                                     | msm-agent + project memory  |
| History compaction                              | Dynamic compaction + summarization                           | Hook implemented                                | msm-agent + project         |
| Control bus commands                            | kill/pause/disable checks                                    | Implemented interface + checks                  | msm-agent + project adapter |
| Approval gate                                   | Durable approval requests and resume                         | ✅ Implemented (sync + durable async)           | msm-agent + project adapter |
| Resumption engine                               | Resume after approval/clarification/callback                 | ✅ Implemented (3 resume paths)                 | msm-agent + project adapter |
| FlushGate state machine for resume buffering    | collect/drain while rebuilding context                       | FlushGate is write buffer; resume uses RunState | msm-agent                   |
| Distributed destructive idempotency             | Redis NX + cached tool result                                | ✅ Adapter hooks wired in loop                  | msm-agent + project adapter |
| Task state durability across restarts           | Redis run-state hydration + TTL extension                    | ✅ saveRunState/loadRunState/extendRunStateTTL  | msm-agent + project adapter |
| Abort in-flight tool on kill                    | withAbortOnKill polling                                      | ✅ AbortController per iteration                | msm-agent                   |
| ActionReceipt / ResponseEvidence generation     | Built and attached on responses                              | ✅ buildEvidence() + receipts on response       | msm-agent                   |
| Channel pre-processing gates                    | opt-out, ack suppression, FAQ auto-answer                    | Not in package (by design)                      | project channels layer      |
| Employee routing and delegation policy          | sticky/intent/scored routing                                 | Not in package (by design)                      | project routing layer       |
| Multi-layer memory system                       | working/episodic/semantic/procedural/reflection              | Not in package (by design)                      | project memory layer        |
| Observability and quality loop                  | traces, trust scorecard, quality scorer, self-improving loop | Hooks only                                      | project observability layer |
| LLM provider failover and model routing         | multi-provider resilient router                              | Not in package (by design)                      | MSM brain layer             |

## Ownership Contract

Use this as the non-negotiable boundary when building new agentic projects.

### 1) Belongs to MSM brain (msm-ai)

- Translation, classification, orchestration, generation, validation logic
- Prompt strategy and persona behavior
- LLM provider routing, model policy, retries, failover
- Domain reasoning quality

### 2) Belongs to msm-agent

- Generic execution loop and action dispatch
- Guard engine
- Plan state tracking
- Context assembly contract into brain input
- Adapter contracts for memory/tools/events/delivery/control bus
- Cross-project reusable runtime primitives

### 3) Belongs to your project app

- Real adapters: DB, tools, channels, queue workers
- Domain tools and integration credentials
- Approval workflow durability and UX
- Channel-specific behavior and formatting
- Employee routing, autonomy policy, access control
- Observability dashboards, QA loops, SLO governance

## What a New Project Must Provide

These are required if you want Dalil-like production behavior.

1. Persistent MemoryAdapter

- Conversation and task storage in Postgres/MongoDB/Redis
- Optional search() for semantic enrichment

2. Real ToolAdapter

- Tool catalog with schema validation
- Rate limiting
- Domain-specific idempotency for destructive operations

3. EventAdapter with durable ingress

- Webhooks and/or queue consumers
- Retry and dead-letter strategy

4. DeliveryAdapter for your channels

- Channel output formatting
- Typing indicators and approval prompts if needed

5. Optional but strongly recommended ControlBusAdapter

- kill_task, pause_tenant, disable_tool operations

6. Production hooks

- onIteration and onGuard wired to metrics/logging
- audit persistence via FlushGate or your own sink

## Reference Integration Skeleton

```text
my-project/
  src/
    brain/
      pipeline.ts               # msm-ai setup, model/router/policies
    agent/
      index.ts                  # createAgent wiring
      adapters/
        memory.adapter.ts       # project DB implementation
        tools.adapter.ts        # domain tools + validation + rate limits
        events.adapter.ts       # webhook/queue intake
        delivery.adapter.ts     # channel output
        control-bus.adapter.ts  # optional runtime controls
    channels/
      whatsapp.ts               # parsing + pre-gates + delivery formatting
      telegram.ts
    observability/
      metrics.ts
      traces.ts
      qa-loop.ts
```

## Example Boundary in Code

```ts
// Project-owned composition root
import { createAgent } from "msm-agent";
import { createPipeline } from "msm-ai";
import { PostgresMemoryAdapter } from "./adapters/memory.adapter";
import { DomainToolAdapter } from "./adapters/tools.adapter";
import { QueueEventAdapter } from "./adapters/events.adapter";
import { WhatsAppDeliveryAdapter } from "./adapters/delivery.adapter";
import { RedisControlBusAdapter } from "./adapters/control-bus.adapter";

const brain = createPipeline("support-agent", [
  // project selects layers/providers/policies in msm-ai
]);

const agent = createAgent({
  brain,
  memory: new PostgresMemoryAdapter(),
  tools: new DomainToolAdapter(),
  events: new QueueEventAdapter(),
  delivery: new WhatsAppDeliveryAdapter(),
  controlBus: new RedisControlBusAdapter(),
  tenantId: "tenant-123",
  config: {
    maxIterations: 6,
    maxReplans: 2,
    confidenceThreshold: 0.6,
    timeoutMs: 30_000,
    costCapPerTask: 0.5,
    toolDedup: true,
  },
  onIteration: (state, step) => {
    // project-owned telemetry
  },
  onGuard: (signal) => {
    // project-owned alerting
  },
});

await agent.start();
```

## Production Readiness Checklist

Mark all as done before claiming Dalil-level readiness.

- [ ] Persistent adapters are implemented and load tested.
- [ ] Destructive tool idempotency exists beyond in-process dedup.
- [ ] Approval flow is durable and resumable.
- [ ] Retry and dead-letter policies are defined for event ingestion.
- [ ] Control bus is connected for kill/pause/disable operations.
- [ ] Metrics/tracing/quality loops are wired and monitored.
- [ ] Domain-specific evaluation scenarios pass at target quality.
- [ ] Ownership boundary is documented for contributors.

## Additional Features (v2 update, 2026-04-13)

The following production features were added to close all identified gaps:

| Feature               | Module                     | Description                                                       |
| --------------------- | -------------------------- | ----------------------------------------------------------------- |
| Output sanitization   | `src/core/sanitize.ts`     | Strips API keys, PII, secrets from all responses before delivery  |
| Input guard           | `src/core/input-guard.ts`  | Prompt injection defense (13+ patterns, truncation, sanitization) |
| Structured responses  | `ResponseFormat` type      | Text, list, buttons, carousel, confirmation formats               |
| Conversation repair   | `onFatalError` hook        | Delivers user-friendly message on brain crash                     |
| Plan acknowledgment   | `onPlanCreated` hook       | Sends "working on it..." for multi-step plans                     |
| Injection detection   | `onInjectionDetected` hook | Alerts on prompt injection attempts                               |
| Durable approval      | `waiting_approval` status  | Async approval with `approval_callback` resume                    |
| Run state persistence | `MemoryAdapter` extensions | `saveRunState`, `loadRunState`, `extendRunStateTTL`               |

See [INTEGRATION-GUIDE.md](./INTEGRATION-GUIDE.md) for full usage documentation.

## Current Recommendation

msm-agent now includes all runtime primitives needed for Dalil-level production behavior. Use it as the execution core for new projects, with project-owned adapters wired to your real infrastructure (databases, queues, channels, tools). See the integration guide for complete implementation patterns.
