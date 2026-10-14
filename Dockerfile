# syntax=docker/dockerfile:1
# The app image: the web UI + API (`serve`), and the `db:init` / `ingest` CLIs, on Bun.
# Published to GHCR by .github/workflows/container.yml; docker-compose.yml runs it next to MongoDB.

ARG BUN_VERSION=1.4.2

FROM oven/bun:${BUN_VERSION}-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
# Runtime dependencies only: Bun runs the TypeScript directly, so tsc and vitest aren't needed.
RUN bun install --frozen-lockfile --production

FROM oven/bun:${BUN_VERSION}-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    NO_OPEN=1
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src
USER bun
EXPOSE 3000
# The slim image has no curl; Bun's fetch checks that the server answers.
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=5 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["bun", "src/server/serve.ts"]
