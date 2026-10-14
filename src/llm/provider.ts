// A thin LLM provider layer so the engine works with Anthropic, OpenAI, or a self-hosted
// OpenAI-compatible server (vLLM, LM Studio, llama.cpp, a gateway), or Ollama. Selection is
// automatic (see settings.ts): LLM_PROVIDER if set, else an LLM_BASE_URL means OpenAI-compatible,
// else OPENAI_API_KEY means OpenAI, else Anthropic. Callers (synthesis, chat) speak in terms of
// the helpers below and never touch a vendor SDK directly. Conversation messages are kept opaque
// (vendor-shaped) and built via userMessage()/toolResultMessage().
//
// The OpenAI path speaks one of two wire APIs, chosen by LLM_API. "responses" (/v1/responses) is
// the default for OpenAI itself: GPT-5 reasoning models don't support function tools on
// chat-completions. "chat" (/v1/chat/completions, see chat-completions.ts) is the default for a
// self-hosted server, since that is the API they implement fully. Anthropic uses the Messages API.
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { config } from "../config.js";
import { chatToolResultMessage, forceToolChat, streamChatTurnChat } from "./chat-completions.js";
import { isReasoningModel as reasoningFor, resolveLlmSettings, type ProviderName } from "./settings.js";

export type { ProviderName };

const settings = resolveLlmSettings(config);

export const provider: ProviderName = settings.provider;

/** Models per provider: built-in defaults for OpenAI and Anthropic, overridable via LLM_*MODEL. */
export const MODELS = settings.models;

/** True for the OpenAI-shaped providers (OpenAI itself and self-hosted compatibles). */
const openaiShaped = provider !== "anthropic";
/** Chat Completions instead of the Responses API. */
const useChat = openaiShaped && settings.api === "chat";

/** GPT-5 / o-series are reasoning models — they take a `reasoning` effort and ignore temperature. */
const isReasoningModel = (model: string): boolean => reasoningFor(model, settings.reasoning);
/** Reasoning models spend output tokens on hidden reasoning, so give responses headroom. */
const outputCap = (model: string, want: number): number => (isReasoningModel(model) ? Math.max(want, 4096) : want);

/** An opaque, vendor-shaped conversation message. Build via the helpers; don't inspect. */
export type LlmMessage =
  | Anthropic.MessageParam
  | OpenAI.Responses.ResponseInputItem
  | OpenAI.Chat.Completions.ChatCompletionMessageParam;

/** A tool the model may call. `schema` is a JSON Schema for the tool's input. */
export interface ToolSpec {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

export interface ForcedToolResult {
  /** The tool's parsed input arguments. */
  input: unknown;
  /** Provider-specific id for this tool call, used to attach a result/error on retry. */
  toolCallId: string;
  /** The assistant turn items to append before feeding back a result (OpenAI requires the
   *  reasoning item to accompany its function_call, so this is the full output, not one item). */
  assistant: LlmMessage[];
}

export interface ChatTurnResult {
  /** Items to append to the conversation for the next turn (assistant tool calls). */
  assistant: LlmMessage[];
  /** Concatenated assistant text for this turn. */
  text: string;
  toolCalls: { id: string; name: string; args: unknown }[];
}

let anthropicClient: Anthropic | undefined;
let openaiClient: OpenAI | undefined;
function anthropic(): Anthropic {
  if (!anthropicClient) anthropicClient = new Anthropic({ apiKey: settings.apiKey, baseURL: settings.baseURL });
  return anthropicClient;
}
function openai(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({
      baseURL: settings.baseURL,
      // No key (a local Ollama): send no Authorization header at all, rather than a placeholder token.
      ...(settings.apiKey ? { apiKey: settings.apiKey } : { apiKey: "unused", defaultHeaders: { Authorization: null } }),
    });
  }
  return openaiClient;
}

/** A plain user-text message (valid input for both providers). */
export function userMessage(text: string): LlmMessage {
  return { role: "user", content: text };
}

/** A tool result to feed back to the model (set isError for validation/runtime failures). */
export function toolResultMessage(toolCallId: string, content: string, isError = false): LlmMessage {
  if (useChat) return chatToolResultMessage(toolCallId, content, isError);
  if (openaiShaped) {
    return { type: "function_call_output", call_id: toolCallId, output: content };
  }
  return { role: "user", content: [{ type: "tool_result", tool_use_id: toolCallId, content, is_error: isError }] };
}

/**
 * Forces the model to call exactly one tool and returns its parsed input. Used for
 * synthesis (emit a query plan) and name extraction (report people).
 */
export async function forceTool(opts: {
  system: string;
  messages: LlmMessage[];
  tool: ToolSpec;
  model: string;
  temperature?: number;
  maxTokens?: number;
}): Promise<ForcedToolResult> {
  const max = opts.maxTokens ?? 1024;

  if (useChat) {
    return forceToolChat(
      openai(),
      { ...opts, messages: opts.messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[] },
      { reasoning: isReasoningModel(opts.model), maxTokens: outputCap(opts.model, max), forceMode: settings.forceMode },
    );
  }

  if (openaiShaped) {
    const res = await openai().responses.create({
      model: opts.model,
      instructions: opts.system,
      input: opts.messages as OpenAI.Responses.ResponseInputItem[],
      tools: [{ type: "function", name: opts.tool.name, description: opts.tool.description, parameters: opts.tool.schema, strict: false }],
      tool_choice: { type: "function", name: opts.tool.name },
      ...(isReasoningModel(opts.model) ? { reasoning: { effort: "low" } } : {}),
      max_output_tokens: outputCap(opts.model, max),
    });
    const fc = res.output.find(
      (o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === "function_call" && o.name === opts.tool.name,
    );
    if (!fc) throw new Error("Model did not produce a tool call.");
    return { input: safeParse(fc.arguments), toolCallId: fc.call_id, assistant: res.output as LlmMessage[] };
  }

  const res = await anthropic().messages.create({
    model: opts.model,
    max_tokens: max,
    temperature: opts.temperature ?? 0,
    system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
    tools: [{ name: opts.tool.name, description: opts.tool.description, input_schema: opts.tool.schema as Anthropic.Tool.InputSchema }],
    tool_choice: { type: "tool", name: opts.tool.name },
    messages: opts.messages as Anthropic.MessageParam[],
  });
  const tu = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === opts.tool.name);
  if (!tu) throw new Error("Model did not produce a tool call.");
  return { input: tu.input, toolCallId: tu.id, assistant: [{ role: "assistant", content: res.content }] };
}

/**
 * Runs one chat turn, streaming the model's thinking as it arrives (Anthropic
 * extended thinking; OpenAI reasoning summaries). Yields `thinking` chunks; the
 * generator's return value is the finished turn.
 */
export async function* streamChatTurn(opts: {
  system: string;
  messages: LlmMessage[];
  tools: ToolSpec[];
  model: string;
  maxTokens: number;
}): AsyncGenerator<{ type: "thinking"; text: string }, ChatTurnResult, void> {
  if (useChat) {
    // yield* forwards the thinking chunks and evaluates to the generator's return value.
    return yield* streamChatTurnChat(
      openai(),
      { ...opts, messages: opts.messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[] },
      { reasoning: isReasoningModel(opts.model), maxTokens: outputCap(opts.model, opts.maxTokens) },
    );
  }

  if (openaiShaped) {
    const stream = await openai().responses.create({
      model: opts.model,
      instructions: opts.system,
      input: opts.messages as OpenAI.Responses.ResponseInputItem[],
      tools: opts.tools.map((t) => ({ type: "function" as const, name: t.name, description: t.description, parameters: t.schema, strict: false })),
      ...(isReasoningModel(opts.model) ? { reasoning: { effort: "low", summary: "auto" } } : {}),
      max_output_tokens: outputCap(opts.model, opts.maxTokens),
      stream: true,
    });
    let final: OpenAI.Responses.Response | undefined;
    let text = ""; // accumulate from deltas — the streamed completed event lacks the output_text getter
    for await (const ev of stream) {
      if (ev.type === "response.output_text.delta") text += ev.delta;
      else if (ev.type === "response.reasoning_summary_text.delta") yield { type: "thinking", text: ev.delta };
      else if (ev.type === "response.completed") final = ev.response;
    }
    const output = final?.output ?? [];
    const fcItems = output.filter(
      (o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === "function_call",
    );
    return {
      // Echo the whole output (reasoning + calls) so a follow-up turn keeps the reasoning↔call pairing.
      assistant: output as LlmMessage[],
      text,
      toolCalls: fcItems.map((o) => ({ id: o.call_id, name: o.name, args: safeParse(o.arguments) })),
    };
  }

  const stream = anthropic().messages.stream({
    model: opts.model,
    max_tokens: opts.maxTokens,
    thinking: { type: "enabled", budget_tokens: 1536 },
    system: opts.system,
    tools: opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema as Anthropic.Tool.InputSchema })),
    messages: opts.messages as Anthropic.MessageParam[],
  });
  for await (const ev of stream) {
    if (ev.type === "content_block_delta" && ev.delta.type === "thinking_delta") {
      yield { type: "thinking", text: ev.delta.thinking };
    }
  }
  const resp = await stream.finalMessage();
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text" && b.text.trim().length > 0)
    .map((b) => b.text)
    .join("\n\n");
  const toolCalls = resp.content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
    .map((b) => ({ id: b.id, name: b.name, args: b.input }));
  return { assistant: [{ role: "assistant", content: resp.content }], text, toolCalls };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}
