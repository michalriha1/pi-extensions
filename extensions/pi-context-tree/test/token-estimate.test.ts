import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import {
  categorizeEntry,
  categorizeMessage,
  categorizeMessages,
  estimateCharsToTokens,
  estimateSystemPromptTokens,
  estimateToolSchemaTokens,
} from "../src/token-estimate.ts";
import { branchSummaryEntry, compactionEntry, labelEntry, modelChangeEntry, resetIds, toolResultEntry, userEntry } from "./helpers.ts";

beforeEach(() => resetIds());

test("estimateCharsToTokens rounds up chars/4", () => {
  assert.equal(estimateCharsToTokens(0), 0);
  assert.equal(estimateCharsToTokens(1), 1);
  assert.equal(estimateCharsToTokens(4), 1);
  assert.equal(estimateCharsToTokens(5), 2);
  assert.equal(estimateCharsToTokens(-5), 0);
});

test("categorizeMessage: user content goes to messages only", () => {
  const result = categorizeMessage({ role: "user", content: "hello world" }); // 11 chars
  assert.deepEqual(result, { messages: 3, toolCalls: 0, toolResponses: 0 });
});

test("categorizeMessage: assistant text/thinking vs tool calls are split", () => {
  const result = categorizeMessage({
    role: "assistant",
    content: [
      { type: "text", text: "abcd" }, // 4 chars -> 1 token
      { type: "thinking", thinking: "abcdefgh" }, // 8 chars -> 2 tokens
      { type: "toolCall", id: "1", name: "read", arguments: { path: "a.ts" } },
    ],
  });
  assert.equal(result.messages, 3); // 1 + 2
  assert.equal(result.toolResponses, 0);
  assert.ok(result.toolCalls > 0);
});

test("categorizeMessage: toolResult content goes to toolResponses only", () => {
  const result = categorizeMessage({ role: "toolResult", content: [{ type: "text", text: "0123456789ab" }] }); // 12 chars -> 3
  assert.deepEqual(result, { messages: 0, toolCalls: 0, toolResponses: 3 });
});

test("categorizeMessage: unknown role contributes nothing", () => {
  assert.deepEqual(categorizeMessage({ role: "session" }), { messages: 0, toolCalls: 0, toolResponses: 0 });
});

test("categorizeMessages sums across a list", () => {
  const result = categorizeMessages([
    { role: "user", content: "aaaa" }, // 1 token messages
    { role: "toolResult", content: [{ type: "text", text: "aaaa" }] }, // 1 token toolResponses
  ]);
  assert.deepEqual(result, { messages: 1, toolCalls: 0, toolResponses: 1 });
});

test("categorizeEntry: message entries project through sessionEntryToContextMessages", () => {
  const entry = userEntry(null, "aaaa"); // 4 chars -> 1 token
  const cats = categorizeEntry(entry);
  assert.equal(cats.messages, 1);
  assert.equal(cats.total, 1);
});

test("categorizeEntry: bookkeeping entries that never enter context contribute zero", () => {
  const label = labelEntry(null, "target", "checkpoint");
  const modelChange = modelChangeEntry(null, "anthropic", "claude-test");
  assert.deepEqual(categorizeEntry(label), { messages: 0, toolCalls: 0, toolResponses: 0, total: 0 });
  assert.deepEqual(categorizeEntry(modelChange), { messages: 0, toolCalls: 0, toolResponses: 0, total: 0 });
});

test("categorizeEntry: compaction and branch-summary entries count their summary text as messages", () => {
  const compaction = compactionEntry(null, { summary: "a".repeat(8), tokensBefore: 1000 });
  const branch = branchSummaryEntry(null, { summary: "a".repeat(4), fromId: "x" });
  assert.equal(categorizeEntry(compaction).total, 2);
  assert.equal(categorizeEntry(branch).total, 1);
});

test("categorizeEntry: tool result entry only counts response content, not the call", () => {
  const result = toolResultEntry(null, { toolCallId: "1", toolName: "read", content: "0123456789ab" });
  assert.equal(categorizeEntry(result).toolResponses, 3);
  assert.equal(categorizeEntry(result).toolCalls, 0);
});

test("estimateToolSchemaTokens sums name+description+parameters+guidelines", () => {
  const tools = [
    { name: "read", description: "Read a file", parameters: { type: "object" }, promptGuidelines: ["Use absolute paths."] },
  ];
  const tokens = estimateToolSchemaTokens(tools);
  assert.ok(tokens > 0);
  // Larger schema -> more tokens (monotonic sanity check).
  const biggerTokens = estimateToolSchemaTokens([
    { ...tools[0]!, description: "Read a file".repeat(20) },
  ]);
  assert.ok(biggerTokens > tokens);
});

test("estimateSystemPromptTokens scales with prompt length", () => {
  assert.equal(estimateSystemPromptTokens(""), 0);
  assert.equal(estimateSystemPromptTokens("a".repeat(400)), 100);
});
