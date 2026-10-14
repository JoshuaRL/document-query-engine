// Resolves which LLM backend to use, and with what key, URL, API and models, from config.
// Pure (no env access) so it can be unit-tested; provider.ts calls it once with `config`.
//
// Precedence: LLM_PROVIDER if set; else an LLM_BASE_URL means a self-hosted OpenAI-compatible
// server; else OPENAI_API_KEY means OpenAI; else Anthropic. With none of the LLM_* variables set,
// the result is exactly the original behaviour.

export type ProviderName = "openai" | "anthropic" | "openai-compatible";
export type OpenAiApi = "responses" | "chat";
export type ReasoningMode = "auto" | "on" | "off";

export interface LlmConfig {
  llmProvider: string;
  llmBaseUrl: string;
  llmApiKey: string;
  llmApi: string;
  llmModel: string;
  llmChatModel: string;
  llmSynthModel: string;
  llmReasoning: string;
  openaiApiKey: string;
  anthropicApiKey: string;
}

export interface LlmSettings {
  provider: ProviderName;
  /** Which OpenAI wire API to speak. Ignored for Anthropic. */
  api: OpenAiApi;
  /** Undefined means the SDK default (which for OpenAI still honours OPENAI_BASE_URL). */
  baseURL?: string;
  apiKey: string;
  models: { synth: string; chat: string };
  reasoning: ReasoningMode;
}

const DEFAULT_MODELS: Record<"openai" | "anthropic", { synth: string; chat: string }> = {
  openai: { synth: "gpt-5.4-mini", chat: "gpt-5.4-mini" },
  anthropic: { synth: "claude-haiku-4-5-20251001", chat: "claude-sonnet-4-6" },
};

/** Lower-cased `value` if it is one of `allowed`, `fallback` if blank, else a clear error naming `name`. */
function oneOf<T extends string>(name: string, value: string, allowed: readonly T[], fallback: T): T {
  const v = value.trim().toLowerCase();
  if (!v) return fallback;
  if ((allowed as readonly string[]).includes(v)) return v as T;
  throw new Error(`Invalid ${name}="${value}". Use one of: ${allowed.join(", ")}.`);
}

export function resolveLlmSettings(cfg: LlmConfig): LlmSettings {
  const baseUrl = cfg.llmBaseUrl.trim().replace(/\/$/, "");
  const inferred: ProviderName = baseUrl ? "openai-compatible" : cfg.openaiApiKey ? "openai" : "anthropic";
  const provider = oneOf("LLM_PROVIDER", cfg.llmProvider, ["openai", "anthropic", "openai-compatible"], inferred);
  const reasoning = oneOf("LLM_REASONING", cfg.llmReasoning, ["auto", "on", "off"], "auto");

  const synthOverride = cfg.llmSynthModel || cfg.llmModel;
  const chatOverride = cfg.llmChatModel || cfg.llmModel;

  if (provider === "anthropic") {
    const d = DEFAULT_MODELS.anthropic;
    return {
      provider,
      api: "responses",
      baseURL: baseUrl || undefined,
      apiKey: cfg.llmApiKey || cfg.anthropicApiKey,
      models: { synth: synthOverride || d.synth, chat: chatOverride || d.chat },
      reasoning,
    };
  }

  if (provider === "openai") {
    const d = DEFAULT_MODELS.openai;
    return {
      provider,
      api: oneOf("LLM_API", cfg.llmApi, ["responses", "chat"], "responses"),
      baseURL: baseUrl || undefined,
      apiKey: cfg.llmApiKey || cfg.openaiApiKey,
      models: { synth: synthOverride || d.synth, chat: chatOverride || d.chat },
      reasoning,
    };
  }

  // openai-compatible: there are no sensible defaults for the URL or the model names.
  if (!baseUrl) throw new Error("LLM_PROVIDER=openai-compatible needs LLM_BASE_URL (e.g. http://localhost:11434/v1).");
  if (!synthOverride || !chatOverride) {
    throw new Error("An OpenAI-compatible server needs LLM_MODEL (or both LLM_SYNTH_MODEL and LLM_CHAT_MODEL).");
  }
  return {
    provider,
    // Most self-hosted servers implement Chat Completions; /v1/responses support varies.
    api: oneOf("LLM_API", cfg.llmApi, ["responses", "chat"], "chat"),
    baseURL: baseUrl,
    // Only LLM_API_KEY: falling back to OPENAI_API_KEY would send a real OpenAI key to another host.
    // Many local servers ignore the key, but the OpenAI SDK refuses an empty one.
    apiKey: cfg.llmApiKey || "not-needed",
    models: { synth: synthOverride, chat: chatOverride },
    reasoning,
  };
}

/** GPT-5 / o-series are reasoning models; LLM_REASONING=on|off overrides the name check for other models. */
export function isReasoningModel(model: string, mode: ReasoningMode): boolean {
  if (mode === "on") return true;
  if (mode === "off") return false;
  return /^(gpt-5|o\d)/.test(model);
}
