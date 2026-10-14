// The Chat Completions (/v1/chat/completions) half of the OpenAI path, used when LLM_API=chat.
// This is the API most self-hosted OpenAI-compatible servers (Ollama, vLLM, LM Studio,
// llama.cpp) implement fully. provider.ts owns selection; this file only speaks the wire format.
// Conversation items in this mode are ChatCompletionMessageParam objects, built here or by
// provider.ts's userMessage(), and passed back to the server unchanged on the next turn.
import type OpenAI from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionFunctionTool,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";

export interface ChatToolSpec {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

export interface ChatCallOpts {
  /** Reasoning models take `reasoning_effort` and `max_completion_tokens`, and ignore temperature. */
  reasoning: boolean;
  /** Output token cap, already adjusted for reasoning headroom by the caller. */
  maxTokens: number;
}

/** A tool result message (role "tool"). Chat Completions has no error flag, so errors are prefixed. */
export function chatToolResultMessage(toolCallId: string, content: string, isError: boolean): ChatCompletionMessageParam {
  return { role: "tool", tool_call_id: toolCallId, content: isError ? `Error: ${content}` : content };
}

export function toChatTools(tools: ChatToolSpec[]): ChatCompletionFunctionTool[] {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } }));
}

/** Token-cap and reasoning fields, which differ between reasoning and ordinary models. */
function tuning(opts: ChatCallOpts, temperature: number | undefined) {
  return opts.reasoning
    ? { reasoning_effort: "low" as const, max_completion_tokens: opts.maxTokens }
    : { max_tokens: opts.maxTokens, ...(temperature !== undefined ? { temperature } : {}) };
}

/** The assistant turn to echo back: only the standard fields, so vendor extras never round-trip. */
function assistantMessage(text: string, calls: ChatCompletionMessageFunctionToolCall[]): ChatCompletionMessageParam {
  return { role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) };
}

/**
 * Finds the first JSON object in free text (a ```json fence or prose around it is fine). Used when a
 * model answers in text instead of honouring the forced tool call, which some local models do.
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === "\\") i++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          const parsed: unknown = JSON.parse(text.slice(start, i + 1));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
        } catch {
          // not JSON after all; try the next "{"
        }
        break;
      }
    }
  }
  return null;
}

let fallbackSeq = 0;

/** Forces one tool call; falls back to a JSON object in the reply text if the model ignored tool_choice. */
export async function forceToolChat(
  client: OpenAI,
  req: { system: string; messages: ChatCompletionMessageParam[]; tool: ChatToolSpec; model: string; temperature?: number },
  opts: ChatCallOpts,
): Promise<{ input: unknown; toolCallId: string; assistant: ChatCompletionMessageParam[] }> {
  const res = await client.chat.completions.create({
    model: req.model,
    messages: [{ role: "system", content: req.system }, ...req.messages],
    tools: toChatTools([req.tool]),
    tool_choice: { type: "function", function: { name: req.tool.name } },
    ...tuning(opts, req.temperature ?? 0),
  });
  const msg = res.choices[0]?.message;
  const text = msg?.content ?? "";
  const calls = (msg?.tool_calls ?? []).filter((c): c is ChatCompletionMessageFunctionToolCall => c.type === "function");
  const call = calls.find((c) => c.function.name === req.tool.name);
  if (call) {
    return { input: safeParse(call.function.arguments), toolCallId: call.id, assistant: [assistantMessage(text, calls)] };
  }

  const input = extractJsonObject(text);
  if (!input) throw new Error("Model did not produce a tool call.");
  // Record the recovered call in the transcript, so a later tool result references an id that exists.
  const id = `call_fallback_${++fallbackSeq}`;
  const synthetic: ChatCompletionMessageFunctionToolCall = {
    id,
    type: "function",
    function: { name: req.tool.name, arguments: JSON.stringify(input) },
  };
  return { input, toolCallId: id, assistant: [assistantMessage("", [synthetic])] };
}

/** Collects streamed deltas into the finished text and tool calls. Exported for tests. */
export class ChatStreamAccumulator {
  text = "";
  private calls = new Map<number, { id: string; name: string; args: string }>();

  /** Adds one chunk; returns any reasoning text it carried so the caller can surface it. */
  add(chunk: ChatCompletionChunk): string {
    const delta = chunk.choices[0]?.delta;
    if (!delta) return "";
    if (delta.content) this.text += delta.content;
    for (const tc of delta.tool_calls ?? []) {
      const cur = this.calls.get(tc.index) ?? { id: "", name: "", args: "" };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      this.calls.set(tc.index, cur);
    }
    // Non-standard reasoning deltas: vLLM and LM Studio send `reasoning_content`, Ollama and llama.cpp `reasoning`.
    const extra = delta as { reasoning_content?: unknown; reasoning?: unknown };
    const reasoning = extra.reasoning_content ?? extra.reasoning;
    return typeof reasoning === "string" ? reasoning : "";
  }

  toolCalls(): ChatCompletionMessageFunctionToolCall[] {
    return [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, c]) => ({ id: c.id || `call_${index}`, type: "function", function: { name: c.name, arguments: c.args } }));
  }
}

/** Runs one streamed chat turn, yielding reasoning text as `thinking` chunks when the server sends any. */
export async function* streamChatTurnChat(
  client: OpenAI,
  req: { system: string; messages: ChatCompletionMessageParam[]; tools: ChatToolSpec[]; model: string },
  opts: ChatCallOpts,
): AsyncGenerator<
  { type: "thinking"; text: string },
  { assistant: ChatCompletionMessageParam[]; text: string; toolCalls: { id: string; name: string; args: unknown }[] },
  void
> {
  const stream = await client.chat.completions.create({
    model: req.model,
    messages: [{ role: "system", content: req.system }, ...req.messages],
    ...(req.tools.length ? { tools: toChatTools(req.tools) } : {}),
    ...tuning(opts, undefined),
    stream: true,
  });
  const acc = new ChatStreamAccumulator();
  for await (const chunk of stream) {
    const thinking = acc.add(chunk);
    if (thinking) yield { type: "thinking", text: thinking };
  }
  const calls = acc.toolCalls();
  return {
    assistant: [assistantMessage(acc.text, calls)],
    text: acc.text,
    toolCalls: calls.map((c) => ({ id: c.id, name: c.function.name, args: safeParse(c.function.arguments) })),
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}
