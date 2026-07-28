import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type {
  ContextUsage,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  createSessionSnapshotController,
  type ThinkingLevel,
} from "../session-snapshot.ts";

function model(id: string, contextWindow: number): Model<Api> {
  return {
    id,
    name: id,
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://example.test",
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
    contextWindow,
    maxTokens: 4096,
  };
}

function assistant(
  input: number,
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    usage: {
      input,
      output: input + 1,
      cacheRead: input + 2,
      cacheWrite: input + 3,
      totalTokens: input * 4 + 6,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: input / 100,
      },
    },
    stopReason,
    timestamp: 1,
  };
}

function entry(message: AssistantMessage, id: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2025-01-02T03:04:05.000Z",
    message,
  };
}

interface Harness {
  ctx: ExtensionContext;
  branch: SessionEntry[];
  scans: number;
  contextUsage: ContextUsage | undefined;
  currentModel: Model<Api>;
  thinking: ThinkingLevel;
  subscription: boolean;
  autoCompact: boolean;
}

function createHarness(): Harness {
  const harness = {
    branch: [] as SessionEntry[],
    scans: 0,
    contextUsage: { tokens: 20, percent: 10, contextWindow: 200 } as ContextUsage | undefined,
    currentModel: model("initial", 200),
    thinking: "low" as ThinkingLevel,
    subscription: false,
    autoCompact: true,
  };
  const context = {
    sessionManager: {
      getBranch: () => {
        harness.scans++;
        return [...harness.branch];
      },
      getSessionId: () => "session-id",
      getHeader: () => ({
        type: "session" as const,
        id: "session-id",
        cwd: "/repo",
        timestamp: "2025-01-02T03:04:05.000Z",
      }),
    },
    modelRegistry: {
      isUsingOAuth: () => harness.subscription,
    },
    get model() {
      return harness.currentModel;
    },
    getContextUsage: () => harness.contextUsage,
    settingsManager: {
      getCompactionSettings: () => ({ enabled: harness.autoCompact }),
    },
  };
  return Object.assign(harness, { ctx: context as unknown as ExtensionContext });
}

function createController(harness: Harness, onChange: () => void = () => {}) {
  return createSessionSnapshotController(
    { getThinkingLevel: () => harness.thinking },
    onChange,
    () => 123,
  );
}

test("initializes with one branch scan and snapshot reads do not rescan over 100 renders", () => {
  const harness = createHarness();
  harness.branch.push(entry(assistant(1), "a"));
  const controller = createController(harness);
  controller.start(harness.ctx);

  for (let index = 0; index < 100; index++) controller.getSnapshot();

  assert.equal(harness.scans, 1);
  assert.equal(controller.getSnapshot()?.usageStats.input, 1);
  assert.equal(controller.getSnapshot()?.sessionStartTime, Date.parse("2025-01-02T03:04:05.000Z"));
});

test("assistant completion increments totals once without rescanning", () => {
  const harness = createHarness();
  harness.branch.push(entry(assistant(2), "a"));
  let renders = 0;
  const controller = createController(harness, () => renders++);
  controller.start(harness.ctx);
  controller.completeAssistant(assistant(5), harness.ctx);

  assert.equal(harness.scans, 1);
  assert.deepEqual(controller.getSnapshot()?.usageStats, {
    input: 7,
    output: 9,
    cacheRead: 11,
    cacheWrite: 13,
    cost: 0.07,
  });
  assert.equal(renders, 1);
});

test("error and aborted assistants are excluded during scans and completion", () => {
  const harness = createHarness();
  harness.branch.push(
    entry(assistant(1), "ok"),
    entry(assistant(50, "error"), "error"),
    entry(assistant(60, "aborted"), "aborted"),
  );
  const controller = createController(harness);
  controller.start(harness.ctx);
  controller.completeAssistant(assistant(70, "error"), harness.ctx);
  controller.completeAssistant(assistant(80, "aborted"), harness.ctx);

  assert.deepEqual(controller.getSnapshot()?.usageStats, {
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    cost: 0.01,
  });
});

test("compaction preserves explicitly unknown public context usage", () => {
  const harness = createHarness();
  const controller = createController(harness);
  controller.start(harness.ctx);
  harness.contextUsage = { tokens: null, percent: null, contextWindow: 200 };
  controller.rebuild(harness.ctx);

  assert.equal(controller.getSnapshot()?.contextTokens, null);
  assert.equal(controller.getSnapshot()?.contextPercent, null);
  assert.equal(controller.getSnapshot()?.contextWindow, 200);
});

test("first successful assistant completion resolves post-compaction context", () => {
  const harness = createHarness();
  const controller = createController(harness);
  controller.start(harness.ctx);
  harness.contextUsage = { tokens: null, percent: null, contextWindow: 200 };
  controller.completeAssistant(assistant(10), harness.ctx);

  assert.equal(controller.getSnapshot()?.contextTokens, 46);
  assert.equal(controller.getSnapshot()?.contextPercent, 23);
});

test("model changes use public context semantics instead of deriving the model window", () => {
  const harness = createHarness();
  const controller = createController(harness);
  controller.start(harness.ctx);
  const selected = model("selected", 500);
  harness.currentModel = selected;
  harness.contextUsage = { tokens: 150, percent: 25, contextWindow: 600 };
  controller.selectModel(selected, harness.ctx);

  assert.equal(controller.getSnapshot()?.model?.id, "selected");
  assert.deepEqual(
    {
      tokens: controller.getSnapshot()?.contextTokens,
      percent: controller.getSnapshot()?.contextPercent,
      window: controller.getSnapshot()?.contextWindow,
    },
    { tokens: 150, percent: 25, window: 600 },
  );
});

test("tree navigation rebuilds totals from the active branch", () => {
  const harness = createHarness();
  harness.branch.push(entry(assistant(2), "old"));
  const controller = createController(harness);
  controller.start(harness.ctx);
  harness.branch = [entry(assistant(9), "new")];
  controller.rebuild(harness.ctx);

  assert.equal(harness.scans, 2);
  assert.equal(controller.getSnapshot()?.usageStats.input, 9);
});

test("supported model and thinking refreshes update subscription and auto-compact state", () => {
  const harness = createHarness();
  const controller = createController(harness);
  controller.start(harness.ctx);
  harness.subscription = true;
  harness.autoCompact = false;
  harness.currentModel = model("oauth", 300);
  controller.selectModel(harness.currentModel, harness.ctx);
  controller.selectThinkingLevel("xhigh", harness.ctx);

  assert.equal(controller.getSnapshot()?.usingSubscription, true);
  assert.equal(controller.getSnapshot()?.autoCompactEnabled, false);
  assert.equal(controller.getSnapshot()?.thinkingLevel, "xhigh");
});

test("dispose ignores later refreshes and start supports a clean reload", () => {
  const harness = createHarness();
  let renders = 0;
  const controller = createController(harness, () => renders++);
  controller.start(harness.ctx);
  controller.dispose();
  controller.completeAssistant(assistant(5), harness.ctx);
  assert.equal(controller.getSnapshot(), null);
  assert.equal(renders, 0);

  controller.start(harness.ctx);
  assert.equal(harness.scans, 2);
  assert.notEqual(controller.getSnapshot(), null);
});

test("production snapshot and footer paths contain no broad any", () => {
  for (const file of ["../index.ts", "../session-snapshot.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\bany\b/);
  }
});
