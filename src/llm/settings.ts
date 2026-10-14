// Resolves which LLM backend to use, and with what key, URL, API and models, from config.
// Pure (no env access) so it can be unit-tested; provider.ts calls it once with `config`.
//
// Precedence: LLM_PROVIDER if set; else an LLM_BASE_URL means a self-hosted OpenAI-compatible
// server; else OPENAI_API_KEY means OpenAI; else Anthropic. With none of the LLM_* variables set,
// the result is exactly the original behaviour. LLM_PROVIDER=ollama is a preset of the
// OpenAI-compatible path with Ollama's defaults, its own env vars, and an optional API key.

export type ProviderName = "openai" | "anthropic" | "openai-compatible" | "ollama";
export type OpenAiApi = "responses" | "chat";
export type ReasoningMode = "auto" | "on" | "off";
/** How forceTool gets structured output: a forced tool call, or a JSON-schema response format. */
export type ForceMode = "tool" | "schema";

export interface LlmConfig {
  llmProvider: string;
  llmBaseUrl: string;
  llmApiKey: string;
  llmApi: string;
  llmModel: string;
  llmChatModel: string;
  llmSynthModel: string;
  llmReasoning: string;
  llmForceMode: string;
  openaiApiKey: string;
  anthropicApiKey: string;
  ollamaHost: string;
  ollamaApiKey: string;
}

export interface LlmSettings {
  provider: ProviderName;
  /** Which OpenAI wire API to speak. Ignored for Anthropic. */
  api: OpenAiApi;
  /** Undefined means the SDK default (which for OpenAI still honours OPENAI_BASE_URL). */
  baseURL?: string;
  /** Empty only for Ollama without a key: the client then sends no Authorization header. */
  apiKey: string;
  models: { synth: string; chat: string };
  reasoning: ReasoningMode;
  /** Only the Chat Completions path honours "schema"; the Responses and Anthropic paths force a tool. */
  forceMode: ForceMode;
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

/**
 * Ollama's OpenAI-compatible base URL from LLM_BASE_URL or OLLAMA_HOST, in any form Ollama itself
 * accepts: "http://host:11434/v1", "http://host:11434", "host:11434", or a bind address like
 * "0.0.0.0", which a client reaches as localhost. Ollama Cloud is "https://ollama.com".
 */
export function ollamaBaseUrl(llmBaseUrl: string, ollamaHost: string): string {
  let url = (llmBaseUrl || ollamaHost).trim() || "http://localhost:11434";
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  const parsed = new URL(url);
  if (parsed.hostname === "0.0.0.0" || parsed.hostname === "[::]") parsed.hostname = "localhost";
  // OLLAMA_HOST without a port means Ollama's default port, except for an https host such as ollama.com.
  if (!parsed.port && parsed.protocol === "http:" && !llmBaseUrl.trim()) parsed.port = "11434";
  const path = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = path.endsWith("/v1") ? path : `${path}/v1`;
  return parsed.toString().replace(/\/$/, "");
}

export function resolveLlmSettings(cfg: LlmConfig): LlmSettings {
  const baseUrl = cfg.llmBaseUrl.trim().replace(/\/$/, "");
  const inferred: ProviderName = baseUrl ? "openai-compatible" : cfg.openaiApiKey ? "openai" : "anthropic";
  const provider = oneOf("LLM_PROVIDER", cfg.llmProvider, ["openai", "anthropic", "openai-compatible", "ollama"], inferred);
  const reasoning = oneOf("LLM_REASONING", cfg.llmReasoning, ["auto", "on", "off"], "auto");
  // Ollama ignores tool_choice, so a forced tool call there is only a request; a schema is enforced.
  const forceMode = oneOf("LLM_FORCE_MODE", cfg.llmForceMode, ["tool", "schema"], provider === "ollama" ? "schema" : "tool");

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
      forceMode,
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
      forceMode,
    };
  }

  if (provider === "ollama") {
    if (!synthOverride || !chatOverride) {
      throw new Error("LLM_PROVIDER=ollama needs LLM_MODEL, a model you have pulled (see `ollama list`), e.g. qwen3:8b.");
    }
    // Ollama implements Chat Completions fully; /v1/responses exists from Ollama 0.13.3, stateless only.
    const api = oneOf("LLM_API", cfg.llmApi, ["responses", "chat"], "chat");
    if (api === "responses" && forceMode === "schema") {
      throw new Error(
        "Schema forcing (the Ollama default) needs LLM_API=chat. To use LLM_API=responses with Ollama, also set " +
          "LLM_FORCE_MODE=tool, knowing Ollama does not enforce tool_choice, so a model may answer without calling the tool.",
      );
    }
    return {
      provider,
      api,
      baseURL: ollamaBaseUrl(cfg.llmBaseUrl, cfg.ollamaHost),
      // A local Ollama needs no key. Ollama Cloud, or a proxy in front of Ollama, takes one as a bearer token.
      apiKey: cfg.llmApiKey || cfg.ollamaApiKey,
      models: { synth: synthOverride, chat: chatOverride },
      reasoning,
      forceMode,
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
    forceMode,
  };
}

/** GPT-5 / o-series are reasoning models; LLM_REASONING=on|off overrides the name check for other models. */
export function isReasoningModel(model: string, mode: ReasoningMode): boolean {
  if (mode === "on") return true;
  if (mode === "off") return false;
  return /^(gpt-5|o\d)/.test(model);
}
