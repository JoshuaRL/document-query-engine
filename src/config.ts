// Bun auto-loads a local .env into process.env, so config just reads from there.
/** Environment-backed configuration. Reads from process.env (populate via .env or shell). */
export const config = {
  mongoUri: process.env.MONGO_URI ?? "mongodb://localhost:27017",
  mongoDb: process.env.MONGO_DB ?? "workshop",
  githubToken: process.env.GITHUB_TOKEN ?? "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  // If set, the engine uses OpenAI instead of Anthropic (see src/llm/provider.ts).
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  callerLogin: process.env.CALLER_LOGIN ?? "",
  // Optional LLM overrides, e.g. for a self-hosted OpenAI-compatible server (see src/llm/settings.ts).
  llmProvider: process.env.LLM_PROVIDER ?? "", // openai | anthropic | openai-compatible
  llmBaseUrl: process.env.LLM_BASE_URL ?? "",
  llmApiKey: process.env.LLM_API_KEY ?? "",
  llmApi: process.env.LLM_API ?? "", // responses | chat
  llmModel: process.env.LLM_MODEL ?? "",
  llmChatModel: process.env.LLM_CHAT_MODEL ?? "",
  llmSynthModel: process.env.LLM_SYNTH_MODEL ?? "",
  llmReasoning: process.env.LLM_REASONING ?? "", // auto | on | off
};

/** Throws if a required env var is missing — call at the top of a CLI that needs it. */
export function requireConfig(...keys: (keyof typeof config)[]): void {
  const missing = keys.filter((k) => !config[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required env: ${missing.join(", ")}. See .env.example.`);
  }
}
