# msm-agent — Portable Agent for MSM Brain

> **Status**: Planning. Do not build until MSM brain is validated in dalil production.

## What is msm-agent

A portable, infrastructure-agnostic agent package that uses MSM as its brain. The agent is the "hands" — it receives events, asks the brain what to do, executes tools, feeds results back, and delivers responses. The brain (MSM) never executes anything — it only decides.

## Sequence — when to build

1. ✅ MSM v3.0.0 shipped (5-layer brain, execution layer removed)
2. ⬜ Replace dalil's `reason()` with MSM brain — validate contracts under real load
3. ⬜ Extract dalil's proven agent patterns into msm-agent with adapter interfaces
4. ⬜ Publish msm-agent — teams use it with their own manifest YAML

## Architecture

```
msm-agent/
├── src/
│   ├── core/
│   │   ├── types.ts            ← Agent contracts (AgentConfig, EventPayload, etc.)
│   │   ├── agent.ts            ← createAgent() — wires adapters + starts loop
│   │   ├── loop.ts             ← The execution loop (event → brain → execute → brain)
│   │   ├── planner.ts          ← Plan tracking, advancePlanStep(), replan()
│   │   ├── context.ts          ← Context builder (assembles brain input from state)
│   │   └── guards.ts           ← Repetition guard, dead-end detection, confidence gate
│   ├── adapters/
│   │   ├── memory.ts           ← MemoryAdapter interface
│   │   ├── tools.ts            ← ToolAdapter interface
│   │   ├── events.ts           ← EventAdapter interface
│   │   └── delivery.ts         ← DeliveryAdapter interface
│   ├── adapters-dummy/
│   │   ├── memory.ts           ← InMemoryAdapter (Map-based, no DB)
│   │   ├── tools.ts            ← MockToolAdapter (simulated responses)
│   │   ├── events.ts           ← ManualEventAdapter (programmatic trigger)
│   │   └── delivery.ts         ← ConsoleDeliveryAdapter (logs to stdout)
│   └── index.ts                ← Public API
├── tests/
├── examples/
│   ├── minimal.ts              ← Simplest possible agent (dummy everything)
│   ├── food-agent.ts           ← Food commerce with MSM brain
│   └── medical-agent.ts        ← Medical triage with MSM brain
├── package.json
└── README.md
```

## Core loop — extracted from dalil's executeTask()

```
Agent receives event (user message, webhook, cron, queue job)
     ↓
Build context (conversation history, previous steps, plan state, memory)
     ↓
Call brain: brain.run({ raw, modality, tool_results?, history? })
     ↓
Brain returns action:
  ├─ "use_tool"  → execute tool → advancePlanStep() → loop back to brain
  ├─ "respond"   → deliver response to user → done
  ├─ "escalate"  → route to human agent → done
  ├─ "clarify"   → ask user for more info → pause, wait for reply
  └─ custom      → agent handles internally → done
     ↓
If use_tool: check iteration limit (max 10)
  ├─ Tool succeeded → feed result back to brain
  └─ Tool failed → replan (max 2 retries) → if exhausted, go freestyle
```

## Adapter interfaces

### MemoryAdapter

```typescript
interface MemoryAdapter {
  // Conversation / session
  getConversation(sessionId: string): Promise<Message[]>;
  addMessage(sessionId: string, message: Message): Promise<void>;

  // Task state (plan, steps, status)
  getTask(taskId: string): Promise<TaskState | null>;
  saveTask(task: TaskState): Promise<void>;
  updatePlan(taskId: string, plan: PlanState): Promise<void>;
  addStep(taskId: string, step: StepResult): Promise<void>;

  // Optional: semantic/episodic memory for advanced agents
  search?(query: string, limit: number): Promise<MemoryEntry[]>;
  store?(entry: MemoryEntry): Promise<void>;
}
```

### ToolAdapter

```typescript
interface ToolAdapter {
  list(): ToolDefinition[]; // available tools
  execute(name: string, params: Record<string, unknown>): Promise<ToolResult>;
  validate?(name: string, params: Record<string, unknown>): ValidationResult;
}
```

### EventAdapter

```typescript
interface EventAdapter {
  onEvent(handler: (event: AgentEvent) => Promise<void>): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

type AgentEvent =
  | { type: "user_message"; sessionId: string; text: string; modality: string }
  | { type: "webhook"; source: string; payload: unknown }
  | { type: "cron"; schedule: string; taskType: string }
  | { type: "queue"; jobId: string; data: unknown }
  | { type: "tool_callback"; taskId: string; result: ToolResult };
```

### DeliveryAdapter

```typescript
interface DeliveryAdapter {
  send(sessionId: string, message: AgentMessage): Promise<void>;
  requestApproval?(sessionId: string, action: string): Promise<boolean>;
}
```

## Safety guards — extracted from dalil

| Guard              | What it does                                     | Source                          |
| ------------------ | ------------------------------------------------ | ------------------------------- |
| Repetition guard   | Same tool called 3+ times → warn brain           | dalil execution-engine L640-656 |
| Dead-end detection | Last 4 steps all failed, 2+ tools → signal brain | dalil execution-engine L659-677 |
| Confidence gate    | confidence < 0.6 → convert to ask_clarification  | dalil execution-engine L600-625 |
| Iteration limit    | Max 10 iterations per event → force respond      | dalil executeTask loop          |
| Replan limit       | Max 2 replans → switch to freestyle              | dalil planner replan()          |
| Tool validation    | Check tool exists + permissions before execute   | dalil execution-engine L675-705 |

## Context builder — what brain receives each iteration

| Section              | Source                 | Compression                       |
| -------------------- | ---------------------- | --------------------------------- |
| User message         | Current event          | None                              |
| Conversation history | MemoryAdapter          | Summary + last 6 if > 10 messages |
| Previous steps       | MemoryAdapter (task)   | Last 2 full, older compressed     |
| Plan with status     | In-memory (loop state) | Always full (✓/✗/○ markers)       |
| Tool results         | Last tool execution    | Full                              |
| Available tools      | ToolAdapter.list()     | Names + descriptions              |

## Usage — what it looks like

```typescript
import { createAgent } from "msm-agent";
import { createPipeline } from "msm-ai";

// Brain (MSM)
const brain = await createPipeline("./cardiology.yaml");

// Agent — production
const agent = createAgent({
  brain,
  memory: new RedisMongoMemoryAdapter({ redis: redisUrl, mongo: mongoUrl }),
  tools: new ApiToolAdapter(toolRegistry),
  events: new BullMQEventAdapter(queueUrl),
  delivery: new WhatsAppDeliveryAdapter(waConfig),
  guards: { maxIterations: 10, maxReplans: 2, confidenceThreshold: 0.6 },
});

await agent.start();

// Agent — testing (zero infrastructure)
const testAgent = createAgent({
  brain,
  memory: new InMemoryAdapter(),
  tools: new MockToolAdapter(),
  events: new ManualEventAdapter(),
  delivery: new ConsoleDeliveryAdapter(),
});

const result = await testAgent.handleEvent({
  type: "user_message",
  sessionId: "test-1",
  text: "book appointment with Dr. Ahmed",
  modality: "text",
});
```

## What NOT to include (keep in brain / keep in app)

| Concern               | Where it belongs | Why                             |
| --------------------- | ---------------- | ------------------------------- |
| Translation           | MSM brain (L1)   | Domain knowledge, not execution |
| Classification        | MSM brain (L2)   | Domain knowledge, not execution |
| Response generation   | MSM brain (L4)   | Domain knowledge, not execution |
| Validation / safety   | MSM brain (L5)   | Policy, not execution           |
| Database schemas      | App layer        | Business-specific               |
| User authentication   | App layer        | Infrastructure-specific         |
| WhatsApp/Telegram SDK | Delivery adapter | Channel-specific                |
| Payment processing    | Tool adapter     | Integration-specific            |

## Deployment targets

### 1. Shared brain service (cloud / on-premise)

One MSM brain instance serves 100s of agents. Each agent connects via HTTP. The brain is a pure function: `f(message, manifest_id) → decision`.

**Multi-tenant by design — no routing infrastructure:**

The agent sends `manifest_id` with every request. The brain has no concept of tenants, sessions, or routing. It loads the manifest, runs the pipeline, returns a decision.

```
Agent (salon-riyadh)     → { message, manifest_id: "booking-gulf" }     ──┐
Agent (hotel-jeddah)     → { message, manifest_id: "booking-gulf" }     ──┤
Agent (restaurant-dubai) → { message, manifest_id: "food-gulf" }        ──┤──→ Brain Service
Agent (clinic-riyadh)    → { message, manifest_id: "healthcare-gulf" }  ──┘    (one instance, one GPU)
```

No gateway. No tenant→manifest config table. The agent IS the tenant — it already knows its manifest at deploy time.

**Why manifest_id per request (not tenant routing):**

- Brain stays fully stateless — no tenant awareness, no config tables, no hidden state
- Zero infrastructure between agent and brain
- Agent is self-describing — carries everything brain needs in the request
- New business = new manifest file, not a routing rule update
- Same input always produces same output — pure function, fully testable

**Model deduplication — shared models loaded once in GPU memory:**

```
Manifest A (booking-gulf):    [arabic-translate, intent-classify, booking-orchestrate, gulf-generate, format-validate]
Manifest B (food-gulf):       [arabic-translate, intent-classify, food-orchestrate, gulf-generate, format-validate]
Manifest C (healthcare-gulf): [arabic-translate, intent-classify, health-orchestrate, medical-generate, format-validate]
Manifest D (retail-gulf):     [arabic-translate, intent-classify, retail-orchestrate, gulf-generate, format-validate]
Manifest E (salon-gulf):      [arabic-translate, intent-classify, booking-orchestrate, gulf-generate, format-validate]

Naive: 5 × 5 = 25 model loads
Actual: 9 unique models loaded once (4 shared + 5 unique)

Model cache is keyed by model ID, not manifest:
  const loadedModels = new Map<string, Model>()
  // Same model referenced by multiple manifests = one Map entry = one GPU allocation
```

**Layer shareability analysis:**

| Layer          | Shared? | Reasoning                                                                                                                                                                                 |
| -------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Translation    | 100%    | Arabic→English is Arabic→English regardless of domain                                                                                                                                     |
| Classification | ~80%    | Core intents (book, cancel, inquire, complain) are universal. Only niche intents (refill prescription) are domain-specific                                                                |
| Orchestration  | ~50%    | Same pattern (intent → tool), but tool names differ. If actions are generic (`use_tool("book_appointment")`), orchestrator is more shareable. Agent resolves what the tool actually calls |
| Generation     | ~70%    | Response structure is similar, but brand voice / terminology differs. A fine-tuned generation model per vertical (hospitality, healthcare, retail) covers most cases                      |
| Validation     | 100%    | Language checks, format checks, safety checks — all domain-agnostic                                                                                                                       |

**Three sharing scenarios:**

| Scenario                         | Example                              | Sharing                                                                             | What differs                                      |
| -------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------- |
| Same vertical                    | 50 restaurants                       | 100% brain shared (same manifest)                                                   | Only agent tool config (which APIs to call)       |
| Same pattern, different vertical | hotel + salon + clinic (all booking) | ~80% shared (same translate/classify/validate, maybe different generation for tone) | 1-2 models per vertical at most                   |
| Different patterns               | food delivery + banking              | ~50% shared (translate + validate shared, different classify/orchestrate/generate)  | Still one deployed service, routes by manifest_id |

**Economics at scale:**

```
Competitor: 5 separate LLM API deployments = 5× cost
MSM: 7-9 small models on one GPU serving all 5 businesses

Cost: ~$300/month (cloud A10 GPU) or one-time ~$2K (on-premise)
      vs Gemini/GPT: 5-50× cheaper at 10K-100K conversations/day
      Flat pricing — no per-token billing
```

**Model cache implementation:**

```typescript
// Brain-level model cache — keyed by model ID
const modelCache = new Map<string, Model>();

function getModel(modelId: string): Model {
  if (!modelCache.has(modelId)) {
    modelCache.set(modelId, loadFromDisk(modelId)); // GPU load once
  }
  return modelCache.get(modelId)!; // every subsequent call = Map lookup
}

// Manifest cache — parsed manifests cached by manifest_id
const manifestCache = new Map<string, ParsedManifest>();
```

**Open questions for shared brain:**

- Model eviction policy: LRU when GPU memory is full? Or preload all manifests at startup?
- Manifest hot-reload: when a manifest YAML changes, invalidate cache + load new models?
- Concurrency: multiple requests hitting same model simultaneously — inference server handles batching (vLLM, Ollama)
- Auth: should brain validate manifest_id against an allowlist? Or trust the agent? (recommendation: trust in private network, validate in public)

### 2. Edge / offline (mobile, desktop, browser)

Full stack runs on-device — zero internet required.

| Component | Edge runtime                                   | Storage                  |
| --------- | ---------------------------------------------- | ------------------------ |
| MSM brain | llama.cpp / ONNX Runtime / WebLLM (WASM)       | Models bundled or cached |
| msm-agent | JS/TS (Node, Bun, React Native, browser)       | —                        |
| Memory    | SQLite (mobile/desktop) or IndexedDB (browser) | Local                    |
| Tools     | On-device APIs / local functions               | —                        |
| Events    | UI events / push notifications                 | —                        |
| Delivery  | In-app UI component                            | —                        |

Use cases:

- Medical tablet in clinic with no internet
- Offline customer service kiosk
- PWA that works without connectivity
- Desktop app with local AI (no cloud dependency)
- Privacy-critical: no data leaves the device

### 3. Hybrid (edge + cloud brain fallback)

Agent runs locally. Tries local brain first. Falls back to cloud brain if local models unavailable or confidence too low.

```typescript
const localBrain = await createPipeline("./cardiology-local.yaml"); // small/quantized models
const cloudBrain = new HttpBrainAdapter("https://brain.company.com"); // full models

const agent = createAgent({
  brain: new FallbackBrain(localBrain, cloudBrain, {
    confidenceThreshold: 0.7,
  }),
  memory: new SQLiteAdapter("./agent.db"),
  tools: new LocalToolAdapter(),
  events: new UIEventAdapter(),
  delivery: new ChatUIAdapter(),
});
```

## Open questions

- Should plan generation live in the agent or ask the brain? (dalil uses LLM for planning — MSM brain already returns plan[] from orchestration layer)
- Should msm-agent ship production adapters (Redis, Mongo, BullMQ) or keep them separate packages? (Recommendation: separate — `msm-agent-redis`, `msm-agent-bullmq`)
- ✅ ~~How to handle multi-tenant isolation?~~ → Agent sends `manifest_id` per request. Brain is stateless, no tenant awareness. Isolation is at manifest level, not brain level.
- Should the agent support parallel tool execution? (dalil does sequential — simpler, safer)
- Edge model format: ONNX vs GGUF (llama.cpp) vs both? (ONNX for classification/validation, GGUF for generation)
- Browser bundle size budget? (agent loop is tiny, models are the bottleneck — quantized 1B model ~500MB)
- Offline sync: when device comes back online, should it sync conversation history to cloud? (yes — memory adapter handles this)

## Model Sizing Guide — What Each Layer Actually Needs

### What the brain receives from the agent (KB + context)

The brain never touches databases. The agent fetches KB snippets, company profile, and conversation history BEFORE calling the brain. The brain generates grounded responses from this provided context.

```typescript
brain.run({
  raw: "كم سعر قص الشعر؟",
  modality: "text",
  manifest_id: "salon-gulf",
  history: [...],
  tool_results: [...],        // if returning from a tool call
  context: {
    company_profile: {
      name: "صالون نورة",
      location: "الرياض، حي النرجس",
      hours: "10:00-22:00",
      tone: "friendly_gulf",
      language: "ar-gulf"
    },
    kb_snippets: [
      { text: "قص شعر نسائي: 150 ريال، قص + سشوار: 200 ريال", source: "price_list" },
      { text: "خصم 10% للحجز عن طريق التطبيق", source: "policies" }
    ]
  }
})
```

### How KB + context changes each layer's job

| Layer          | Without KB/context           | With KB/context                                                                                                                                                                           |
| -------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Translation    | Translate user message       | Same — KB is already in the payload                                                                                                                                                       |
| Classification | Identify intent from message | Same — intent doesn't depend on KB                                                                                                                                                        |
| Orchestration  | Map intent → tool            | **Decides if KB is sufficient or tool call needed** — "KB has prices, no tool needed" vs "need real-time availability, call tool"                                                         |
| Generation     | Template response            | **Grounded generation from KB + tool_results + company_profile.** Must follow instructions: "only use info from provided context." Synthesizes brand-voice responses from structured data |
| Validation     | Format + safety check        | **Grounds response against KB + profile.** Prices match KB? Hours match profile? No hallucinated info? If fail → retry generation with feedback                                           |

### Layer-by-layer model analysis (verified against HuggingFace)

#### L1 — Translation

**Job:** Convert Gulf Arabic ↔ English, including dialect terms, time conventions, cultural context annotations.

**Why it needs ML:** "أبغى" (Gulf for "I want"), "الساعة ٤ العصر" (4 PM via prayer time reference), "شي خفيف" (snack, not low-calorie). Rule-based can't handle this.

**Options:**
| Model | Params | Disk (FP16) | Notes |
|-------|--------|-------------|-------|
| Helsinki-NLP/opus-mt-ar-en (MarianMT) | ~74M | ~308MB (FP32), ~150MB (FP16) | Trained on MSA. **Weak on Gulf dialect** — "أبغى" may mistranslate. Needs fine-tuning for Gulf. Source: HuggingFace (pytorch_model.bin = 308MB) |
| facebook/nllb-200-distilled-600M | 600M | ~1.2GB | Covers 200 language variants under `arb_Arab`. Better dialect coverage than OPUS-MT. **Gulf Arabic not a separate code** — falls under general Arabic, needs testing. |
| Qwen2.5-1.5B (as translator) | 1.5B | ~1GB (Q4) | Multilingual, handles dialects well, but using an LLM for translation is less efficient than a dedicated translation model |

**Recommendation:** NLLB-200-distilled-600M for multi-language, or fine-tuned OPUS-MT for ar↔en only.
**Risk:** Gulf dialect handling — needs benchmark testing with Gulf-specific test set.

#### L2 — Classification

**Job:** Identify intent (`book_appointment`, `inquire_price`, `cancel`, etc.), domain, urgency, language from ~12-20 labels.

**Why it needs ML:** "أبغى أغير موعدي" could be reschedule or cancel-and-rebook. Sentence-level understanding, not keyword matching.

**Options:**
| Model | Params | Disk | Notes |
|-------|--------|------|-------|
| sentence-transformers/all-MiniLM-L6-v2 + classification head | **22.7M** | ~90MB | English-only, 384-dim embeddings. Works because L1 translates to English first. Fine-tune with classification head on domain intents. Source: HuggingFace (22.7M params confirmed) |
| CAMeL-Lab/bert-base-arabic-camelbert-da | ~110M | ~440MB | Arabic dialect-aware (trained on Gulf + Levantine + Egyptian). Classifies directly on Arabic, **skips L1 translation dependency**. More robust if translation is weak |
| microsoft/mdeberta-v3-base | ~86M | ~350MB | Multilingual, strong on classification tasks. Compromise between English-only and Arabic-specific |

**Recommendation:** MiniLM-L6-v2 + head (22.7M) if translation is strong. CAMeLBERT-DA + head (110M) if you want Arabic-native classification independent of L1 quality.
**Trade-off:** MiniLM is 5× smaller but depends on L1 accuracy. CAMeLBERT is 5× larger but self-sufficient.

#### L3 — Orchestration (the thinking layer)

**Job:** NOT just intent→tool mapping. Five sub-tasks:

1. **Parameter extraction** — "الساعة ٨ لشخصين" → `{ time: "20:00", party_size: 2 }`
2. **Missing parameter detection** — "أبغى أحجز" (no time/service) → `action: "clarify"`
3. **Context-aware reasoning** — history says service was "haircut", don't re-ask
4. **Multi-step planning** — "book + order" → plan with 2 steps, execute first
5. **KB-sufficiency check** — "كم السعر?" + KB has prices → `action: "respond"` (no tool needed). "أبغى أحجز" → `action: "use_tool"` (need real-time availability)

**Why it needs an LLM:** Parameter extraction from Arabic text, reasoning about what's missing vs already known from context, deciding between KB-answer and tool-call — this is structured reasoning over natural language.

**Options:**
| Model | Params | Disk (Q4) | Notes |
|-------|--------|-----------|-------|
| Qwen2.5-0.5B-Instruct | 500M | ~350MB | Too small for reliable JSON extraction + context reasoning. Struggles with multi-step plans |
| **Qwen2.5-1.5B-Instruct** | **1.54B** (non-embedding: 1.31B) | **~1GB** | Sweet spot. "Significant improvements in generating structured outputs especially JSON." 29+ languages including Arabic. 32K context. Source: HuggingFace confirmed 1.54B params |
| Qwen2.5-3B-Instruct | 3B | ~2GB | More reliable for complex multi-step, but overkill for bounded domains with ~15 intents |

**Recommendation:** Qwen2.5-1.5B-Instruct (Q4). Confirmed to support structured JSON output and Arabic.
**Confidence:** HIGH — HuggingFace specs verified.

#### L4 — Generation (grounded, not creative)

**Job:** Synthesize response from KB snippets + tool_results + company_profile. Must:

1. Present structured data as fluent Arabic ("عندنا ٣ مواعيد متاحة: ٢ الظهر، ٤ العصر، و٧ المساء")
2. Handle edge cases ("للأسف الخميس كامل 😕 أقرب موعد يوم الثلاثاء")
3. Weave multiple tool results into one response
4. Follow brand voice (salon = warm/casual, bank = formal)
5. **Stay grounded** — only use facts from KB/tool_results, never hallucinate

**Why 0.5B isn't enough:** Grounded generation (RAG-style) requires instruction-following discipline. The model must obey "only use information from provided context." 0.5B models frequently "go creative" and invent facts. 1.5B has much stronger instruction adherence.

**Model: Same Qwen2.5-1.5B-Instruct as L3** — loaded once, used with different system prompts.

- L3 system prompt: "Extract parameters, output JSON"
- L5 system prompt: "Generate Gulf Arabic response using ONLY the provided KB and tool results. Company: {profile}. Tone: {tone}."

**Same model, different prompts = zero additional GPU memory.**

#### L5 — Validation

**Job:** Verify response quality before delivery. Four checks:

1. **Language correctness** — response is in the right language/dialect
2. **Safety** — no inappropriate content
3. **Completeness** — booking confirmation includes date + time + service
4. **Factual grounding** — prices/hours in response match KB/profile data

**Options:**
| Approach | Model | Disk | Handles |
|----------|-------|------|---------|
| Rule-based | None | 0 | Checks 1-3 (blocked words, regex patterns, field presence) |
| Rule-based + fastText langdetect | fastText lid.176.bin | ~1MB | Adds language detection |
| Rule-based + NLI model | MiniCheck / DeBERTa-v3-small | ~170MB | Adds factual consistency (check 4). Production-grade |

**Recommendation:** Rule-based for MVP. Add NLI model for production if generation model hallucinates.

#### L6 — Outbound Translation

**Same model as L1** — runs in reverse direction (English → Arabic). No additional GPU memory.

### Production configurations (verified numbers)

**Config A — Gulf Arabic, maximum quality:**

```
NLLB-200-distilled-600M   (600M)   →  1.2GB disk, ~1.4GB GPU
CAMeLBERT-DA + head       (110M)   →  440MB disk, ~500MB GPU
Qwen2.5-1.5B-Instruct Q4  (1.54B) →  1.0GB disk, ~1.2GB GPU  ← shared L3+L4+L6(if using LLM)
Rule-based + fastText      (~0)    →    1MB disk
                                      ─────────────────────
Total: 3 models, ~2.6GB disk, ~3.1GB GPU RAM
Fits on: any GPU ≥4GB, Apple M-series, edge devices with 4GB+ RAM
```

**Config B — Gulf Arabic, minimum size:**

```
NLLB-200-distilled-600M   (600M)   →  1.2GB disk, ~1.4GB GPU
MiniLM-L6-v2 + head       (22.7M)  →   90MB disk, ~100MB GPU  ← depends on L1 quality
Qwen2.5-1.5B-Instruct Q4  (1.54B) →  1.0GB disk, ~1.2GB GPU  ← shared L3+L4
Rule-based                 (~0)    →    0MB
                                      ─────────────────────
Total: 3 models, ~2.3GB disk, ~2.7GB GPU RAM
Fits on: any GPU ≥4GB, laptops, phones with 4GB+ RAM
```

**Config C — English-only (no translation layer):**

```
MiniLM-L6-v2 + head       (22.7M)  →   90MB disk, ~100MB GPU
Qwen2.5-1.5B-Instruct Q4  (1.54B) →  1.0GB disk, ~1.2GB GPU  ← shared L3+L4
Rule-based                 (~0)    →    0MB
                                      ─────────────────────
Total: 2 models, ~1.1GB disk, ~1.3GB GPU RAM
Fits on: browser (WASM), phones, Raspberry Pi with 2GB+ RAM
```

### What still needs testing (honest unknowns)

| Question                                               | Risk                                         | How to test                                                                  |
| ------------------------------------------------------ | -------------------------------------------- | ---------------------------------------------------------------------------- |
| Does NLLB handle Gulf dialect specifically?            | Medium — "أبغى" may map to MSA "أريد" poorly | Run 50 Gulf phrases through NLLB, measure BLEU                               |
| Does Qwen2.5-1.5B stay grounded to KB in Arabic?       | Medium — may hallucinate prices              | Run 100 KB+question pairs, count hallucinated facts                          |
| Can MiniLM classify accurately after NLLB translation? | Low — but L1 errors cascade to L2            | End-to-end accuracy test: Gulf Arabic → L1 → L2, compare to CAMeLBERT direct |
| Q4 quantization quality loss?                          | Low for 1.5B (well-studied)                  | Compare Q4 vs FP16 on structured output accuracy                             |
| Exact Q4 file sizes?                                   | Low — varies by quantization method          | Measure: llama.cpp GGUF Q4_K_M vs GPTQ vs AWQ                                |

---

## Areas for Improvement / Potential Risks

### Latency Accumulation

While small models are fast, running 5 of them in a row (Translation → Classification → Orchestration → Generation → Validation) can add up. `Pipeline.run()` overhead must be near-zero — the framework should add microseconds, not milliseconds. Measure and optimize the inter-layer handoff.

### The "Cold Start" Problem

If you have 50 different manifests for 50 different business types, managing which models stay in GPU memory could get tricky. May eventually need a **Model Router** or a **Warm Cache** strategy — LRU eviction when GPU memory is full, preloading high-traffic manifests, and batching inference across manifests that share models.

### Developer Friction

Writing 5 prompts (one for each layer) is more work than writing one big prompt. To make MSM go viral, may need a **Manifest Generator** that helps developers scaffold a new project quickly — `msm init --domain food --region gulf` → generates manifest + layer configs + example prompts.
