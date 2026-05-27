# ─── msm-agent Docker image ───────────────────────────────────────────────────
#
# Multi-stage build: builder compiles TypeScript, runner is a clean Node runtime.
#
# Build context must be the PROJECTS ROOT (two levels above this file):
#
#   From msm-ai/agent/:
#     docker build -f Dockerfile -t msm-agent ../..
#
#   Via docker compose (recommended):
#     docker compose up          # context is set automatically
#
# Run:
#   docker run \
#     -e AGENT_FILE=/app/agent.md \
#     -e OPENAI_API_KEY=sk-... \
#     -v ./support-agent.md:/app/agent.md:ro \
#     -p 3000:3000 \
#     msm-agent
#
# Optional env vars:
#   MEMORY_PATH     Path inside the container to the SQLite DB (e.g. /data/agent.db)
#                   Mount a volume to persist across restarts.
#   PORT            HTTP server port (default: 3000)
#   HOST            HTTP server host (default: 0.0.0.0)
#   OPENAI_BASE_URL Override OpenAI-compatible base URL
#   OLLAMA_ENDPOINT Ollama base URL (default: http://localhost:11434)
# ──────────────────────────────────────────────────────────────────────────────

# ─── Stage 1: builder ─────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

# Install pnpm via corepack (locked to major version for reproducibility)
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /workspace

# ── Copy @intenttext/core (pre-built, file: dep of the agent) ─────────────────
# The agent's package.json references "file:../../IntentText/packages/core".
# We copy the compiled dist + package.json so pnpm --frozen-lockfile can resolve it.
COPY IntentText/packages/core/package.json IntentText/packages/core/package.json
COPY IntentText/packages/core/dist/        IntentText/packages/core/dist/

# ── Install agent dependencies ────────────────────────────────────────────────
COPY msm-ai/agent/package.json    msm-ai/agent/package.json
COPY msm-ai/agent/pnpm-lock.yaml  msm-ai/agent/pnpm-lock.yaml

WORKDIR /workspace/msm-ai/agent
RUN pnpm install --frozen-lockfile --prod=false

# ── Compile TypeScript ────────────────────────────────────────────────────────
COPY msm-ai/agent/src/        src/
COPY msm-ai/agent/tsconfig.json tsconfig.json

RUN pnpm build

# ─── Stage 2: runner ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runner

# Create a non-root user for security
RUN addgroup -S agent && adduser -S agent -G agent

WORKDIR /app

# Copy only what is needed to run the server
COPY --from=builder --chown=agent:agent /workspace/msm-ai/agent/dist/         ./dist/
COPY --from=builder --chown=agent:agent /workspace/msm-ai/agent/node_modules/  ./node_modules/
COPY --from=builder --chown=agent:agent /workspace/msm-ai/agent/package.json   ./package.json

# Data directory for optional SQLite memory (MEMORY_PATH=/data/agent.db)
RUN mkdir -p /data && chown agent:agent /data

USER agent

EXPOSE 3000

ENV PORT=3000
ENV HOST=0.0.0.0

# node:sqlite is stable in Node 22.12+ — no --experimental-sqlite flag needed.
ENTRYPOINT ["node", "dist/server/cli.js"]
