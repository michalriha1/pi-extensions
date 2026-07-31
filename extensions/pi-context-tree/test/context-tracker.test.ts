import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import { ContextTracker } from "../src/context-tracker.ts";
import type { RequestSnapshot } from "../src/types.ts";
import {
  assistantEntry,
  branchSummaryEntry,
  compactionEntry,
  labelEntry,
  modelChangeEntry,
  nextId,
  resetIds,
  toolResultEntry,
  userEntry,
} from "./helpers.ts";

beforeEach(() => resetIds());

function snapshot(overrides: Partial<RequestSnapshot>): RequestSnapshot {
  return {
    leafEntryId: null,
    systemPromptTokens: 100,
    toolSchemaTokens: 50,
    messagesTokens: 0,
    toolCallTokens: 0,
    toolResponseTokens: 0,
    contextWindow: 200_000,
    modelKey: "anthropic/claude-test",
    timestamp: Date.now(),
    ...overrides,
  };
}

test("simple turn: parent gets exact usage.input+cache, assistant gets exact total", () => {
  const tracker = new ContextTracker(() => 200_000);
  const user1 = userEntry(null, "hello");
  const assistant1 = assistantEntry(user1.id, { text: "hi", usage: { input: 1000, output: 50, cacheRead: 20, cacheWrite: 0 } });

  tracker.sync([user1, assistant1]);

  const userRow = tracker.getRowInfo(user1.id)!;
  assert.equal(userRow.cumulative, 1020); // input + cacheRead + cacheWrite
  assert.equal(userRow.exact, true);

  const assistantRow = tracker.getRowInfo(assistant1.id)!;
  assert.equal(assistantRow.cumulative, 1070); // input+output+cache
  assert.equal(assistantRow.exact, true);
  assert.equal(assistantRow.delta, 1070 - 1020);
  assert.equal(assistantRow.deltaExact, true);
});

test("estimated points before the next assistant usage arrives", () => {
  const tracker = new ContextTracker(() => 200_000);
  const user1 = userEntry(null, "hello there"); // 11 chars -> 3 tokens
  tracker.sync([user1]);

  const row = tracker.getRowInfo(user1.id)!;
  assert.equal(row.exact, false);
  assert.equal(row.cumulative, 3);
});

test("parallel tool results: only the immediate predecessor of the next assistant call becomes exact", () => {
  const tracker = new ContextTracker(() => 200_000);
  const user1 = userEntry(null, "go");
  const assistant1 = assistantEntry(user1.id, {
    usage: { input: 500, output: 30, cacheRead: 0, cacheWrite: 0 },
    toolCalls: [
      { id: "call1", name: "read", arguments: { path: "a.ts" } },
      { id: "call2", name: "read", arguments: { path: "b.ts" } },
    ],
  });
  const result1 = toolResultEntry(assistant1.id, { toolCallId: "call1", toolName: "read", content: "AAAA" }); // 1 token
  const result2 = toolResultEntry(result1.id, { toolCallId: "call2", toolName: "read", content: "BBBB" }); // 1 token
  const assistant2 = assistantEntry(result2.id, { usage: { input: 700, output: 10, cacheRead: 0, cacheWrite: 0 } });

  tracker.sync([user1, assistant1, result1, result2, assistant2]);

  // result1 is a parallel sibling, not the immediate predecessor of assistant2:
  // it stays a plain content estimate.
  const row1 = tracker.getRowInfo(result1.id)!;
  assert.equal(row1.exact, false);

  // result2 IS the immediate predecessor of assistant2, so it gets corrected
  // to the authoritative usage.input value.
  const row2 = tracker.getRowInfo(result2.id)!;
  assert.equal(row2.exact, true);
  assert.equal(row2.cumulative, 700);

  const row3 = tracker.getRowInfo(assistant2.id)!;
  assert.equal(row3.exact, true);
  assert.equal(row3.cumulative, 710);
});

test("aborted/error assistant messages do not produce exact corrections", () => {
  const tracker = new ContextTracker(() => 200_000);
  const user1 = userEntry(null, "go");
  const assistant1 = assistantEntry(user1.id, {
    usage: { input: 500, output: 30, cacheRead: 0, cacheWrite: 0 },
    stopReason: "aborted",
  });
  tracker.sync([user1, assistant1]);

  const userRow = tracker.getRowInfo(user1.id)!;
  assert.equal(userRow.exact, false);
});

test("compaction produces a negative delta relative to its parent (content discarded)", () => {
  const tracker = new ContextTracker(() => 200_000);
  const user1 = userEntry(null, "a".repeat(4000)); // large -> ~1000 tokens
  const assistant1 = assistantEntry(user1.id, { usage: { input: 1000, output: 20, cacheRead: 0, cacheWrite: 0 } });
  const user2 = userEntry(assistant1.id, "next"); // small, kept
  const compaction = compactionEntry(user2.id, {
    summary: "a".repeat(40), // 10 tokens
    firstKeptEntryId: user2.id,
    tokensBefore: 1000,
  });
  tracker.sync([user1, assistant1, user2, compaction]);

  const user2Row = tracker.getRowInfo(user2.id)!; // compaction's direct parent
  const compactionRow = tracker.getRowInfo(compaction.id)!;
  assert.equal(compactionRow.exact, false);
  assert.ok(compactionRow.delta < 0, "compaction should shrink cumulative context");
  assert.ok(compactionRow.cumulative < user2Row.cumulative);
});

test("branch summary is naturally isolated from the abandoned branch (no special-casing needed)", () => {
  const tracker = new ContextTracker(() => 200_000);
  const a = userEntry(null, "a".repeat(4000)); // ~1000 tokens, common ancestor
  const b = userEntry(a.id, "b".repeat(4000)); // abandoned branch content
  const c = userEntry(b.id, "c".repeat(4000)); // abandoned branch content
  const branchSummary = branchSummaryEntry(a.id, { summary: "d".repeat(40), fromId: c.id }); // 10 tokens, parent = a

  tracker.sync([a, b, c, branchSummary]);

  const aRow = tracker.getRowInfo(a.id)!;
  const summaryRow = tracker.getRowInfo(branchSummary.id)!;
  // Only a's own tokens (1000) plus the summary's own tokens (10) -- b/c's
  // ~2000 tokens are never included since the tree parent skips them.
  assert.equal(summaryRow.cumulative, aRow.cumulative + 10);
});

test("bookkeeping entries (label, model_change) contribute zero and preserve exactness", () => {
  const tracker = new ContextTracker((provider, modelId) => (modelId === "big-model" ? 1_000_000 : 200_000));
  const user1 = userEntry(null, "");
  const assistant1 = assistantEntry(user1.id, { usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } });
  const modelChange = modelChangeEntry(assistant1.id, "anthropic", "big-model");
  const label = labelEntry(modelChange.id, assistant1.id, "checkpoint");

  tracker.sync([user1, assistant1, modelChange, label]);

  const modelChangeRow = tracker.getRowInfo(modelChange.id)!;
  assert.equal(modelChangeRow.exact, true); // exact carried forward, zero contribution
  assert.equal(modelChangeRow.cumulative, tracker.getRowInfo(assistant1.id)!.cumulative);
  assert.equal(modelChangeRow.contextWindow, 1_000_000);

  const labelRow = tracker.getRowInfo(label.id)!;
  assert.equal(labelRow.exact, true);
  assert.equal(labelRow.contextWindow, 1_000_000);
});

test("incremental sync only processes newly appended entries", () => {
  const tracker = new ContextTracker(() => 200_000);
  const user1 = userEntry(null, "hi");
  tracker.sync([user1]);
  const rowBefore = tracker.getRowInfo(user1.id)!;

  const assistant1 = assistantEntry(user1.id, { usage: { input: 42, output: 1, cacheRead: 0, cacheWrite: 0 } });
  tracker.sync([user1, assistant1]);

  // user1's record must have been *corrected in place*, not recomputed from
  // scratch (same object identity semantics as a real incremental pass).
  const rowAfter = tracker.getRowInfo(user1.id)!;
  assert.equal(rowBefore.entryId, rowAfter.entryId);
  assert.equal(rowAfter.cumulative, 42);
});

test("getBreakdown reconciles an exact total against a live-observed category snapshot via an explicit gap", () => {
  const tracker = new ContextTracker(() => 200_000);
  const user1 = userEntry(null, "hello"); // parent of the assistant response below
  tracker.recordSnapshot(snapshot({ leafEntryId: user1.id, messagesTokens: 900 })); // system 100 + tools 50 + messages 900 = 1050 estimate
  const assistant1 = assistantEntry(user1.id, { text: "hi", usage: { input: 1000, output: 20, cacheRead: 0, cacheWrite: 0 } });

  tracker.sync([user1, assistant1]);

  const breakdown = tracker.getBreakdown(user1.id)!;
  assert.equal(breakdown.totalExact, true);
  assert.equal(breakdown.total, 1000);
  assert.equal(breakdown.systemPrompt, 100);
  assert.equal(breakdown.toolSchemas, 50);
  assert.equal(breakdown.messages, 900);
  assert.equal(breakdown.gap, 1000 - 1050); // -50: estimate slightly overshot the real total
  assert.equal(breakdown.available, 200_000 - 1000);
});

test("getBreakdown degrades gracefully with no observed category data", () => {
  const tracker = new ContextTracker(() => 200_000);
  const user1 = userEntry(null, "hello world"); // no snapshot ever recorded
  tracker.sync([user1]);

  const breakdown = tracker.getBreakdown(user1.id)!;
  assert.equal(breakdown.totalExact, false);
  assert.equal(breakdown.systemPrompt, 0);
  assert.equal(breakdown.toolSchemas, 0);
  assert.equal(breakdown.total, breakdown.messages + breakdown.toolCalls + breakdown.toolResponses);
});

test("estimated breakdown total stays aligned with the row cumulative after an exact API anchor", () => {
  const tracker = new ContextTracker(() => 200_000);
  const user1 = userEntry(null, "hello");
  const assistant1 = assistantEntry(user1.id, {
    usage: { input: 1000, output: 20, cacheRead: 0, cacheWrite: 0 },
  });
  const result1 = toolResultEntry(assistant1.id, {
    toolCallId: "call1",
    toolName: "read",
    content: "x".repeat(400),
  });

  tracker.sync([user1, assistant1, result1]);

  const row = tracker.getRowInfo(result1.id)!;
  const breakdown = tracker.getBreakdown(result1.id)!;
  assert.equal(row.exact, false);
  assert.equal(row.cumulative, 1120);
  assert.equal(breakdown.total, row.cumulative);
  assert.equal(breakdown.toolResponses, 100);
  assert.equal(breakdown.messages, 0);
  assert.equal(breakdown.toolCalls, 0);
  assert.equal(breakdown.gap, 1020);
  assert.equal(breakdown.available, 200_000 - row.cumulative);
});

test("unmatched snapshots do not leak into unrelated branches", () => {
  const tracker = new ContextTracker(() => 200_000);
  const user1 = userEntry(null, "hello");
  const orphanLeafId = nextId(); // simulate a snapshot for a request that never completed
  tracker.recordSnapshot(snapshot({ leafEntryId: orphanLeafId }));
  const assistant1 = assistantEntry(user1.id, { usage: { input: 1000, output: 20, cacheRead: 0, cacheWrite: 0 } });

  tracker.sync([user1, assistant1]);

  const breakdown = tracker.getBreakdown(user1.id)!;
  assert.equal(breakdown.systemPrompt, 0); // the orphaned snapshot never matched user1
});
