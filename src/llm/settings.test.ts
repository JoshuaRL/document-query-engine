import { describe, expect, it } from "vitest";
import { isReasoningModel, resolveLlmSettings, type LlmConfig } from "./settings.js";

/** Build a config from env-style names, everything else blank (as config.ts would with nothing set). */
function cfg(env: Record<string, string> = {}): LlmConfig {
  return {
    llmProvider: env.LLM_PROVIDER ?? "",
    llmBaseUrl: env.LLM_BASE_URL ?? "",
    llmApiKey: env.LLM_API_KEY ?? "",
    llmApi: env.LLM_API ?? "",
    llmModel: env.LLM_MODEL ?? "",
    llmChatModel: env.LLM_CHAT_MODEL ?? "",
    llmSynthModel: env.LLM_SYNTH_MODEL ?? "",
    llmReasoning: env.LLM_REASONING ?? "",
    openaiApiKey: env.OPENAI_API_KEY ?? "",
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? "",
  };
}

describe("resolveLlmSettings: unchanged behaviour with no LLM_* set", () => {
  it("uses Anthropic and its default models when no OpenAI key is set", () => {
    expect(resolveLlmSettings(cfg({ ANTHROPIC_API_KEY: "a" }))).toEqual({
      provider: "anthropic",
      api: "responses",
      baseURL: undefined,
      apiKey: "a",
      models: { synth: "claude-haiku-4-5-20251001", chat: "claude-sonnet-4-6" },
      reasoning: "auto",
    });
  });

  it("uses OpenAI's Responses API when OPENAI_API_KEY is set", () => {
    expect(resolveLlmSettings(cfg({ OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a" }))).toEqual({
      provider: "openai",
      api: "responses",
      baseURL: undefined,
      apiKey: "o",
      models: { synth: "gpt-5.4-mini", chat: "gpt-5.4-mini" },
      reasoning: "auto",
    });
  });
});

describe("resolveLlmSettings: self-hosted OpenAI-compatible", () => {
  it("is selected by LLM_BASE_URL, defaults to chat, strips one trailing slash, and needs no key", () => {
    const s = resolveLlmSettings(cfg({ LLM_BASE_URL: "http://localhost:11434/v1/", LLM_MODEL: "qwen3:8b" }));
    expect(s).toEqual({
      provider: "openai-compatible",
      api: "chat",
      baseURL: "http://localhost:11434/v1",
      apiKey: "not-needed",
      models: { synth: "qwen3:8b", chat: "qwen3:8b" },
      reasoning: "auto",
    });
  });

  it("wins over OPENAI_API_KEY, and uses that key when LLM_API_KEY is blank", () => {
    const s = resolveLlmSettings(cfg({ LLM_BASE_URL: "http://h/v1", LLM_MODEL: "m", OPENAI_API_KEY: "o" }));
    expect(s.provider).toBe("openai-compatible");
    expect(s.apiKey).toBe("o");
  });

  it("prefers LLM_API_KEY", () => {
    const s = resolveLlmSettings(cfg({ LLM_BASE_URL: "http://h/v1", LLM_MODEL: "m", LLM_API_KEY: "l", OPENAI_API_KEY: "o" }));
    expect(s.apiKey).toBe("l");
  });

  it("accepts LLM_API=responses for servers that implement it", () => {
    expect(resolveLlmSettings(cfg({ LLM_BASE_URL: "http://h/v1", LLM_MODEL: "m", LLM_API: "Responses" })).api).toBe("responses");
  });

  it("needs a model", () => {
    expect(() => resolveLlmSettings(cfg({ LLM_BASE_URL: "http://h/v1" }))).toThrow(/LLM_MODEL/);
    expect(() => resolveLlmSettings(cfg({ LLM_BASE_URL: "http://h/v1", LLM_SYNTH_MODEL: "s" }))).toThrow(/LLM_MODEL/);
  });

  it("needs a base URL when chosen explicitly", () => {
    expect(() => resolveLlmSettings(cfg({ LLM_PROVIDER: "openai-compatible", LLM_MODEL: "m" }))).toThrow(/LLM_BASE_URL/);
  });
});

describe("resolveLlmSettings: overrides for OpenAI and Anthropic", () => {
  it("LLM_PROVIDER=openai keeps OpenAI with a custom base URL on the Responses API", () => {
    const s = resolveLlmSettings(cfg({ LLM_PROVIDER: "openai", LLM_BASE_URL: "http://proxy/v1", OPENAI_API_KEY: "o" }));
    expect(s).toMatchObject({ provider: "openai", api: "responses", baseURL: "http://proxy/v1", apiKey: "o" });
  });

  it("LLM_API=chat switches OpenAI to Chat Completions", () => {
    expect(resolveLlmSettings(cfg({ OPENAI_API_KEY: "o", LLM_API: "chat" })).api).toBe("chat");
  });

  it("per-role model names beat LLM_MODEL, which beats the defaults", () => {
    const both = resolveLlmSettings(cfg({ OPENAI_API_KEY: "o", LLM_MODEL: "m", LLM_SYNTH_MODEL: "s" }));
    expect(both.models).toEqual({ synth: "s", chat: "m" });
    const anth = resolveLlmSettings(cfg({ LLM_CHAT_MODEL: "claude-opus-4-1" }));
    expect(anth.models).toEqual({ synth: "claude-haiku-4-5-20251001", chat: "claude-opus-4-1" });
  });

  it("LLM_PROVIDER=anthropic with LLM_BASE_URL points the Anthropic client there", () => {
    const s = resolveLlmSettings(cfg({ LLM_PROVIDER: "anthropic", LLM_BASE_URL: "http://proxy", OPENAI_API_KEY: "o" }));
    expect(s).toMatchObject({ provider: "anthropic", baseURL: "http://proxy" });
  });
});

describe("resolveLlmSettings: validation", () => {
  it("rejects unknown values and names the variable", () => {
    expect(() => resolveLlmSettings(cfg({ LLM_PROVIDER: "azure" }))).toThrow(/LLM_PROVIDER/);
    expect(() => resolveLlmSettings(cfg({ OPENAI_API_KEY: "o", LLM_API: "completions" }))).toThrow(/LLM_API/);
    expect(() => resolveLlmSettings(cfg({ LLM_REASONING: "maybe" }))).toThrow(/LLM_REASONING/);
  });
});

describe("isReasoningModel", () => {
  it("follows the name check on auto and the override otherwise", () => {
    expect(isReasoningModel("gpt-5.4-mini", "auto")).toBe(true);
    expect(isReasoningModel("o3", "auto")).toBe(true);
    expect(isReasoningModel("qwen3:8b", "auto")).toBe(false);
    expect(isReasoningModel("qwen3:8b", "on")).toBe(true);
    expect(isReasoningModel("gpt-5.4-mini", "off")).toBe(false);
  });
});
