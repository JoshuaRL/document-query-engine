# Beyond RAG: Structured Query Synthesis for Engineering Context

Workshop project. Build a structured query engine that turns natural language into
validated MongoDB aggregation pipelines over GitHub PR and Issue data.

Semantic RAG finds similar documents — but it can't reason about time, traverse
relationships, or apply precise filters. Agents need more than similarity search:
they need structured, queryable access to the data behind their workflows.

## How the workshop works

You start with the **whole app already built** — a web UI with a query playground
and a chat agent — but the **query engine is a stub**: every query comes back
*"not implemented yet."* Across the steps you build the engine and watch the UI come
alive. See [PLAN.md](./PLAN.md).

- **Step 0 (this branch):** set up MongoDB, ingest a repo, boot the web app.
- **Steps 1–6:** schema discovery → identity resolution → synthesis → validation →
  retry → full-text search.

## Stack

- [Bun](https://bun.sh) — runtime, package manager, and TypeScript runner
- MongoDB (local via Docker, an existing instance, or Atlas)
- `mongodb`, `@octokit/rest`, `express`, `zod`, and an LLM SDK (`@anthropic-ai/sdk` or `openai`)

## Prerequisites

- **Bun** — install from [bun.sh](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`
  or `brew install oven-sh/bun/bun`); check with `bun --version`. Bun runs the TypeScript
  directly and auto-loads `.env`.
- **GitHub CLI** *(optional, but strongly recommended)* — install
  [`gh`](https://cli.github.com/) and run `gh auth login`; the ingest script picks up its
  token automatically (leave `GITHUB_TOKEN` blank). Easiest path by far.
- **A GitHub token** — only if you skip the CLI: set a
  [personal access token](https://github.com/settings/tokens) in `GITHUB_TOKEN`
  (`public_repo`, or `repo` for private).
- **An LLM API key** — either [Anthropic](https://console.anthropic.com/) (`sk-ant-…`) or
  [OpenAI](https://platform.openai.com/api-keys) (`sk-…`). If both are set, OpenAI is used.
- **MongoDB** — the engine queries a MongoDB instance, so you need one. Easiest is
  **Docker** (`docker compose up -d` spins up `mongo:7` locally); or use an existing
  instance, or a free [Atlas](https://www.mongodb.com/cloud/atlas/register) cluster.
  Details in step 3 below.
- **Docker** — needed only for the easy MongoDB route above (so `docker compose up -d`
  works). Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or
  Engine + Compose). Skip if you bring your own MongoDB or use Atlas.

## Setup

### 1. Install dependencies

```bash
bun install
```

### 2. Configure secrets

```bash
cp .env.example .env        # then edit it — see "Your .env" below
```

### 3. Get a MongoDB (pick one)

**A — Docker (simplest):**
```bash
docker compose up -d        # mongo:7 on localhost:27017
```
The default `MONGO_URI=mongodb://localhost:27017` already points at it.

**B — You already run MongoDB** (locally or in a container): skip Docker. Point
`MONGO_URI` at your instance and use a dedicated DB name so you don't clash with
existing data:
```ini
MONGO_URI=mongodb://localhost:27017   # or your host/container
MONGO_DB=dqe_workshop
```

**C — No Docker, no MongoDB:** install
[MongoDB Community](https://www.mongodb.com/docs/manual/administration/install-community/),
or create a free [Atlas](https://www.mongodb.com/cloud/atlas/register) cluster and set
`MONGO_URI` to its connection string.

> Already have a Mongo container on 27017? Use option B, or change the published port
> in `docker-compose.yml` and match `MONGO_URI`.

### 4. Initialize and ingest

```bash
bun run db:init                  # create indexes; prints which Mongo it connected to
bun run ingest -- owner/repo     # e.g. bun run ingest -- facebook/react
```

### 5. Boot the app

```bash
bun run serve                    # opens http://localhost:3000 — Query / Chat tabs
```

The app runs and the data browses — but the **engine is stubbed**, so a query (or a
chat question) returns *"not implemented yet."* Building it is the workshop.

## Your `.env`

```ini
# GitHub: leave blank to use the `gh` CLI token, or paste a PAT.
GITHUB_TOKEN=

# LLM: set ONE. If OPENAI_API_KEY is present the engine uses OpenAI, else Anthropic.
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=

# Or a self-hosted OpenAI-compatible server — see the next section.
# LLM_BASE_URL=http://localhost:11434/v1
# LLM_API_KEY=
# LLM_MODEL=

# MongoDB
MONGO_URI=mongodb://localhost:27017
MONGO_DB=workshop

# Your GitHub login — treated as "me" / "my" in natural-language queries.
CALLER_LOGIN=your-github-login
```

### Using a self-hosted OpenAI-compatible server

Any server that speaks the OpenAI API works: Ollama, vLLM, LM Studio, llama.cpp's `llama-server`,
or a company gateway. Set its address, its key if it needs one, and the model to use:

```ini
LLM_BASE_URL=http://localhost:11434/v1   # Ollama; vLLM is usually :8000/v1, LM Studio :1234/v1, llama-server :8080/v1
LLM_API_KEY=                             # leave blank if the server doesn't check keys
LLM_MODEL=qwen3:8b                       # whatever name your server lists under /v1/models
```

Setting `LLM_BASE_URL` is enough to select this mode; `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`
are then ignored, and an OpenAI key is never sent to your server. Only `LLM_API_KEY` is.

| Variable | Default | Meaning |
|---|---|---|
| `LLM_PROVIDER` | inferred | `openai`, `anthropic` or `openai-compatible`, to choose explicitly |
| `LLM_API` | `chat` (self-hosted), `responses` (OpenAI) | `chat` uses `/v1/chat/completions`, which every compatible server implements; `responses` uses `/v1/responses` |
| `LLM_SYNTH_MODEL`, `LLM_CHAT_MODEL` | `LLM_MODEL` | a different model for query synthesis and for the chat agent; these also override the OpenAI and Anthropic defaults |
| `LLM_REASONING` | `auto` | `on` sends reasoning effort (and no temperature) for a reasoning model whose name isn't `gpt-5*` / `o*`; `off` never does |

For Ollama, use `LLM_PROVIDER=ollama` instead (next section).

The model needs to support tool calling, since query synthesis forces a tool call. If a model
answers in plain text instead, the engine uses the first JSON object in the reply. The chat
agent's live "thinking" ticker shows reasoning text when the server streams it
(`reasoning_content` or `reasoning` deltas).

### Using Ollama

```ini
LLM_PROVIDER=ollama
LLM_MODEL=qwen3:8b        # any model you have pulled; it needs tool support for the chat agent
```

That talks to a local Ollama at `http://localhost:11434` with no API key, and sends no
`Authorization` header at all. To reach another machine, Ollama Cloud, or an Ollama behind an
authenticating proxy, set Ollama's own variables (`LLM_BASE_URL` and `LLM_API_KEY` also work and win):

```ini
OLLAMA_HOST=https://ollama.com     # or gpu-box:11434, http://10.0.0.5:11434, ...
OLLAMA_API_KEY=...                 # sent as "Authorization: Bearer ..."; OPENAI_API_KEY never is
```

Ollama accepts `tool_choice` but does not enforce it, so a model can answer a synthesis request in
prose instead of calling the tool. With Ollama, query synthesis therefore asks for the tool's input
as a JSON-schema `response_format`, which Ollama does enforce. `LLM_FORCE_MODE=tool` switches back to
a forced tool call; `LLM_FORCE_MODE=schema` also works with any other server that supports
`response_format` (vLLM, LM Studio). Schema forcing needs `LLM_API=chat`, the default.
