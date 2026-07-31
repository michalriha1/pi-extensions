import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import { describeEntry, renderEmptyPanel, renderPanel } from "../src/panel.ts";
import type { ContextBreakdown, RowInfo } from "../src/types.ts";
import {
  assistantEntry,
  branchSummaryEntry,
  compactionEntry,
  entryLookup,
  resetIds,
  toolResultEntry,
  userEntry,
} from "./helpers.ts";

const noEntries = entryLookup([]);

beforeEach(() => resetIds());

function row(overrides: Partial<RowInfo> = {}): RowInfo {
  return { entryId: "e1", cumulative: 1000, exact: true, delta: 20, deltaExact: true, contextWindow: 200_000, ...overrides };
}

function breakdown(overrides: Partial<ContextBreakdown> = {}): ContextBreakdown {
  return {
    total: 1000,
    totalExact: true,
    systemPrompt: 100,
    toolSchemas: 50,
    toolCalls: 10,
    toolResponses: 20,
    messages: 770,
    gap: 50,
    available: 199_000,
    contextWindow: 200_000,
    ...overrides,
  };
}

test("renderEmptyPanel returns a short, self-explanatory panel", () => {
  const lines = renderEmptyPanel("No entry selected.");
  assert.ok(lines.some((l) => l.includes("No entry selected.")));
});

test("renderPanel: exact totals are shown without a tilde, estimates with one", () => {
  const lines = renderPanel({ entryKind: "user message", detail: "hello" }, row(), breakdown());
  const totalLine = lines.find((l) => l.startsWith("Total:"))!;
  assert.ok(totalLine.includes("1,000"));
  assert.ok(!totalLine.includes("~1,000"));

  const estimatedLines = renderPanel(
    { entryKind: "user message", detail: "hello" },
    row({ exact: false, deltaExact: false }),
    breakdown({ totalExact: false }),
  );
  const estimatedTotalLine = estimatedLines.find((l) => l.startsWith("Total:"))!;
  assert.ok(estimatedTotalLine.includes("~1,000"));
});

test("renderPanel: category rows are always estimated, even when the total is exact", () => {
  const lines = renderPanel({ entryKind: "user message", detail: "" }, row(), breakdown());
  const systemLine = lines.find((l) => l.includes("System prompt"))!;
  assert.ok(systemLine.includes("~100"));
});

test("renderPanel: negative deltas render with a minus sign", () => {
  const lines = renderPanel({ entryKind: "compaction", detail: "" }, row({ delta: -900, deltaExact: false }), breakdown());
  const deltaLine = lines.find((l) => l.startsWith("Row delta:"))!;
  assert.ok(deltaLine.includes("-900") || deltaLine.includes("~-900"));
});

test("renderPanel: gap row reconciles both exact and estimated totals", () => {
  const exactLines = renderPanel({ entryKind: "user message", detail: "" }, row(), breakdown({ totalExact: true }));
  const exactGap = exactLines.find((line) => line.includes("Provider/estimate gap"))!;
  assert.ok(!exactGap.includes("~50"));

  const estimatedLines = renderPanel({ entryKind: "user message", detail: "" }, row({ exact: false }), breakdown({ totalExact: false }));
  const estimatedGap = estimatedLines.find((line) => line.includes("Provider/estimate gap"))!;
  assert.ok(estimatedGap.includes("~50"));
});

test("renderPanel: a selected tool interaction gets its own explicit call/response lines", () => {
  const lines = renderPanel(
    { entryKind: "tool result", detail: "read(...) -> ...", toolInteraction: { total: 8, callArguments: 5, response: 3 } },
    row(),
    breakdown(),
  );
  assert.ok(lines.some((l) => l.includes("Selected interaction") && l.includes("~8")));
  assert.ok(lines.some((l) => l.includes("call arguments") && l.includes("~5")));
  assert.ok(lines.some((l) => l.includes("response") && l.includes("~3")));
});

test("renderPanel: no tool-interaction lines are shown for non-tool-result rows", () => {
  const lines = renderPanel({ entryKind: "user message", detail: "" }, row(), breakdown());
  assert.ok(!lines.some((l) => l.includes("Selected interaction")));
});

test("renderPanel: unknown context window is reported explicitly, not as a bogus percentage", () => {
  const lines = renderPanel({ entryKind: "user message", detail: "" }, row({ contextWindow: 0 }), breakdown({ contextWindow: 0 }));
  assert.ok(lines.some((l) => l.includes("unknown")));
});

test("describeEntry: user/assistant messages get a short content preview", () => {
  const user = userEntry(null, "  hello   world  ");
  const label = describeEntry(user, noEntries);
  assert.equal(label.entryKind, "user message");
  assert.equal(label.detail, "hello world");
});

test("describeEntry: tool result combines the matching call's arguments with the response", () => {
  const assistant = assistantEntry(null, {
    toolCalls: [{ id: "call1", name: "read", arguments: { path: "a.ts" } }],
  });
  const result = toolResultEntry(assistant.id, { toolCallId: "call1", toolName: "read", content: "file contents" });

  const label = describeEntry(result, entryLookup([assistant, result]));
  assert.equal(label.entryKind, "tool result");
  assert.ok(label.detail.includes("read"));
  assert.ok(label.detail.includes("a.ts"));
  assert.ok(label.detail.includes("file contents"));
});

test("describeEntry: tool result walks past parallel tool-result siblings to find the matching call", () => {
  const assistant = assistantEntry(null, {
    toolCalls: [
      { id: "call1", name: "read", arguments: { path: "a.ts" } },
      { id: "call2", name: "grep", arguments: { pattern: "foo" } },
    ],
  });
  const result1 = toolResultEntry(assistant.id, { toolCallId: "call1", toolName: "read", content: "aaa" });
  // result2's direct parent is result1 (a sibling tool result), not the
  // assistant message that issued call2 -- describeEntry must walk past it.
  const result2 = toolResultEntry(result1.id, { toolCallId: "call2", toolName: "grep", content: "bbb" });

  const label = describeEntry(result2, entryLookup([assistant, result1, result2]));
  assert.equal(label.entryKind, "tool result");
  assert.ok(label.detail.includes("grep"));
  assert.ok(label.detail.includes("foo"));
  assert.ok(label.detail.includes("bbb"));
  assert.ok(label.toolInteraction, "the matching call must still be found across the sibling chain");
});

test("describeEntry: tool interaction estimate separates call-argument and response contributions", () => {
  const assistant = assistantEntry(null, {
    toolCalls: [{ id: "call1", name: "read", arguments: { path: "a.ts" } }], // "read" (4) + '{"path":"a.ts"}' (16) = 20 chars -> 5 tokens
  });
  const result = toolResultEntry(assistant.id, { toolCallId: "call1", toolName: "read", content: "0123456789ab" }); // 12 chars -> 3 tokens

  const label = describeEntry(result, entryLookup([assistant, result]));
  assert.deepEqual(label.toolInteraction, { total: 8, callArguments: 5, response: 3 });
});

test("describeEntry: tool result without a resolvable call still shows the tool name and a response-only estimate", () => {
  const result = toolResultEntry(null, { toolCallId: "missing", toolName: "bash", content: "output" });
  const label = describeEntry(result, noEntries);
  assert.ok(label.detail.startsWith("bash("));
  assert.equal(label.toolInteraction?.callArguments, 0);
  assert.ok((label.toolInteraction?.response ?? 0) > 0);
});

test("describeEntry: compaction and branch-summary entries surface their key metadata", () => {
  const compaction = compactionEntry(null, { summary: "s", tokensBefore: 12_345 });
  const branch = branchSummaryEntry(null, { summary: "s", fromId: "abc123" });
  assert.equal(describeEntry(compaction, noEntries).entryKind, "compaction");
  assert.ok(describeEntry(compaction, noEntries).detail.includes("12,345"));
  assert.ok(describeEntry(branch, noEntries).detail.includes("abc123"));
});
