import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";
import {
  ChatStreamAccumulator,
  chatToolResultMessage,
  extractJsonObject,
  forceToolChat,
  streamChatTurnChat,
  toChatTools,
} from "./chat-completions.js";

const tool = { name: "emit_plan", description: "Emit a plan.", schema: { type: "object", properties: {} } };

/** A stand-in for the OpenAI client that records the request body and returns a canned reply. */
function fakeClient(reply: unknown) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    chat: {
      completions: {
        create: async (body: Record<string, unknown>) => {
          calls.push(body);
          return reply;
        },
      },
    },
  } as unknown as OpenAI;
  /** The first request body sent. */
  const sent = (): Record<string, unknown> => {
    if (!calls[0]) throw new Error("no request sent");
    return calls[0];
  };
  return { client, sent };
}

function chunk(delta: Record<string, unknown>): ChatCompletionChunk {
  return { id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: null }] } as ChatCompletionChunk;
}

async function* streamOf(chunks: ChatCompletionChunk[]) {
  for (const c of chunks) yield c;
}

describe("message helpers", () => {
  it("toChatTools wraps each spec as a function tool", () => {
    expect(toChatTools([tool])).toEqual([
      { type: "function", function: { name: "emit_plan", description: "Emit a plan.", parameters: tool.schema } },
    ]);
  });

  it("chatToolResultMessage builds a role:tool message and prefixes errors", () => {
    expect(chatToolResultMessage("id1", "ok", false)).toEqual({ role: "tool", tool_call_id: "id1", content: "ok" });
    expect(chatToolResultMessage("id1", "bad field", true)).toEqual({ role: "tool", tool_call_id: "id1", content: "Error: bad field" });
  });
});

describe("extractJsonObject", () => {
  it("reads a fenced block", () => {
    expect(extractJsonObject('Here:\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
  });
  it("reads an object inside prose, with nested braces and braces in strings", () => {
    expect(extractJsonObject('Sure, {"q": {"x": "}{"}, "n": [1]} hope that helps')).toEqual({ q: { x: "}{" }, n: [1] });
  });
  it("skips a brace that is not JSON and finds the next object", () => {
    expect(extractJsonObject('use {curly} then {"ok": true}')).toEqual({ ok: true });
  });
  it("returns null when there is no object", () => {
    expect(extractJsonObject("no json here")).toBeNull();
    expect(extractJsonObject("[1, 2]")).toBeNull();
  });
});

describe("forceToolChat", () => {
  const toolReply = {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          reasoning_content: "vendor extra that must not round-trip",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "emit_plan", arguments: '{"limit":5}' } }],
        },
      },
    ],
  };

  it("forces the tool and returns its parsed input", async () => {
    const { client, sent } = fakeClient(toolReply);
    const prior = [{ role: "user" as const, content: "q" }];
    const r = await forceToolChat(client, { system: "sys", messages: prior, tool, model: "m" }, { reasoning: false, maxTokens: 100 });
    expect(r.input).toEqual({ limit: 5 });
    expect(r.toolCallId).toBe("call_1");
    expect(r.assistant).toEqual([
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "emit_plan", arguments: '{"limit":5}' } }] },
    ]);
    const body = sent();
    expect(body.messages).toEqual([{ role: "system", content: "sys" }, ...prior]);
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "emit_plan" } });
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(100);
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("passes prior tool calls and tool results through unchanged (the retry loop)", async () => {
    const { client, sent } = fakeClient(toolReply);
    const prior = [
      { role: "user" as const, content: "q" },
      { role: "assistant" as const, content: null, tool_calls: [{ id: "call_0", type: "function" as const, function: { name: "emit_plan", arguments: "{}" } }] },
      chatToolResultMessage("call_0", "limit is required", true),
    ];
    await forceToolChat(client, { system: "sys", messages: prior, tool, model: "m" }, { reasoning: false, maxTokens: 100 });
    expect((sent().messages as unknown[]).slice(1)).toEqual(prior);
  });

  it("uses reasoning_effort and max_completion_tokens, without temperature, for reasoning models", async () => {
    const { client, sent } = fakeClient(toolReply);
    await forceToolChat(client, { system: "s", messages: [], tool, model: "m", temperature: 0.3 }, { reasoning: true, maxTokens: 4096 });
    expect(sent().reasoning_effort).toBe("low");
    expect(sent().max_completion_tokens).toBe(4096);
    expect(sent()).not.toHaveProperty("temperature");
    expect(sent()).not.toHaveProperty("max_tokens");
  });

  it("falls back to JSON in the reply text and records a matching synthetic call", async () => {
    const { client } = fakeClient({ choices: [{ message: { role: "assistant", content: 'Plan: ```json\n{"limit": 3}\n```' } }] });
    const r = await forceToolChat(client, { system: "s", messages: [], tool, model: "m" }, { reasoning: false, maxTokens: 10 });
    expect(r.input).toEqual({ limit: 3 });
    const msg = r.assistant[0] as { tool_calls: { id: string; function: { name: string; arguments: string } }[] };
    expect(msg.tool_calls[0]?.id).toBe(r.toolCallId);
    expect(msg.tool_calls[0]?.function).toEqual({ name: "emit_plan", arguments: '{"limit":3}' });
  });

  it("throws when there is neither a tool call nor JSON", async () => {
    const { client } = fakeClient({ choices: [{ message: { role: "assistant", content: "I cannot help." } }] });
    await expect(
      forceToolChat(client, { system: "s", messages: [], tool, model: "m" }, { reasoning: false, maxTokens: 10 }),
    ).rejects.toThrow("Model did not produce a tool call.");
  });
});

describe("ChatStreamAccumulator", () => {
  it("joins text, surfaces reasoning, and assembles split parallel tool calls", () => {
    const acc = new ChatStreamAccumulator();
    const thinking = [
      acc.add(chunk({ reasoning_content: "think " })),
      acc.add(chunk({ reasoning: "more" })),
      acc.add(chunk({ content: "Hel" })),
      acc.add(chunk({ content: "lo" })),
      acc.add(chunk({ tool_calls: [{ index: 0, id: "a", type: "function", function: { name: "query", arguments: "" } }] })),
      acc.add(chunk({ tool_calls: [{ index: 1, id: "b", type: "function", function: { name: "query", arguments: '{"q":' } }] })),
      acc.add(chunk({ tool_calls: [{ index: 0, function: { arguments: '{"q":"x"' } }] })),
      acc.add(chunk({ tool_calls: [{ index: 0, function: { arguments: "}" } }, { index: 1, function: { arguments: '"y"}' } }] })),
    ].join("");
    expect(thinking).toBe("think more");
    expect(acc.text).toBe("Hello");
    expect(acc.toolCalls()).toEqual([
      { id: "a", type: "function", function: { name: "query", arguments: '{"q":"x"}' } },
      { id: "b", type: "function", function: { name: "query", arguments: '{"q":"y"}' } },
    ]);
  });

  it("gives an id-less call a stable synthetic id", () => {
    const acc = new ChatStreamAccumulator();
    acc.add(chunk({ tool_calls: [{ index: 2, function: { name: "query", arguments: "{}" } }] }));
    expect(acc.toolCalls()[0]?.id).toBe("call_2");
  });
});

describe("streamChatTurnChat", () => {
  it("streams thinking, then returns the turn with tool calls", async () => {
    const { client, sent } = fakeClient(
      streamOf([
        chunk({ reasoning_content: "hmm" }),
        chunk({ content: "Looking." }),
        chunk({ tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "query", arguments: '{"q":"open"}' } }] }),
      ]),
    );
    const gen = streamChatTurnChat(client, { system: "sys", messages: [{ role: "user", content: "hi" }], tools: [tool], model: "m" }, { reasoning: false, maxTokens: 50 });
    const thinking: string[] = [];
    let r = await gen.next();
    while (!r.done) {
      thinking.push(r.value.text);
      r = await gen.next();
    }
    expect(thinking).toEqual(["hmm"]);
    expect(r.value.text).toBe("Looking.");
    expect(r.value.toolCalls).toEqual([{ id: "t1", name: "query", args: { q: "open" } }]);
    expect(r.value.assistant).toEqual([
      { role: "assistant", content: "Looking.", tool_calls: [{ id: "t1", type: "function", function: { name: "query", arguments: '{"q":"open"}' } }] },
    ]);
    expect(sent().stream).toBe(true);
    expect(sent().max_tokens).toBe(50);
    expect(sent()).not.toHaveProperty("tool_choice");
  });
});
