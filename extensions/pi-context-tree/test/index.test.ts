import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import { initTheme, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type SessionEntry, type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

import { ContextTracker } from "../src/context-tracker.ts";
import piContextTreeExtension, { ContextTreeInspectorComponent } from "../src/index.ts";
import { assistantEntry, buildTree, resetIds, toolResultEntry, userEntry } from "./helpers.ts";

initTheme("dark");
beforeEach(() => resetIds());

type Handler = (event: unknown, ctx: unknown) => unknown;
type CommandHandler = (args: unknown, ctx: unknown) => unknown;

class ExtensionHarness {
  readonly handlers = new Map<string, Handler>();
  readonly commands = new Map<string, { description: string; handler: CommandHandler }>();
  activeToolNames: string[] = [];
  allTools: Array<{ name: string; description: string; parameters: unknown; promptGuidelines?: string[] }> = [];

  on(event: string, handler: Handler): void {
    this.handlers.set(event, handler);
  }

  registerCommand(name: string, options: { description: string; handler: CommandHandler }): void {
    this.commands.set(name, options);
  }

  getActiveTools(): string[] {
    return this.activeToolNames;
  }

  getAllTools(): typeof this.allTools {
    return this.allTools;
  }
}

function fakeTui(): TUI {
  return { terminal: { rows: 40, cols: 100 }, requestRender: () => {} } as unknown as TUI;
}

function fakeTheme(): Theme {
  const identity = (_color: string, text: string) => text;
  return {
    fg: identity,
    bg: identity,
    bold: (text: string) => text,
    italic: (text: string) => text,
  } as unknown as Theme;
}

test("/context-tree notifies instead of opening UI outside the TUI", async () => {
  const harness = new ExtensionHarness();
  piContextTreeExtension(harness as unknown as ExtensionAPI);
  const command = harness.commands.get("context-tree")!;

  const notifications: Array<[string, string | undefined]> = [];
  const ctx = {
    mode: "print",
    ui: { notify: (message: string, type?: string) => notifications.push([message, type]) },
  } as unknown as ExtensionCommandContext;

  await command.handler({}, ctx);

  assert.equal(notifications.length, 1);
  assert.match(notifications[0]![0], /interactive TUI/);
});

test("/context-tree notifies when the session has no entries yet", async () => {
  const harness = new ExtensionHarness();
  piContextTreeExtension(harness as unknown as ExtensionAPI);
  const command = harness.commands.get("context-tree")!;

  const notifications: string[] = [];
  const ctx = {
    mode: "tui",
    ui: { notify: (message: string) => notifications.push(message) },
    sessionManager: { getTree: () => [] },
  } as unknown as ExtensionCommandContext;

  await command.handler({}, ctx);

  assert.equal(notifications.length, 1);
  assert.match(notifications[0]!, /No entries/);
});

test('"context" event category details remain hidden from the panel', async () => {
  const harness = new ExtensionHarness();
  harness.activeToolNames = ["read"];
  harness.allTools = [{ name: "read", description: "Read a file", parameters: { type: "object" } }];
  piContextTreeExtension(harness as unknown as ExtensionAPI);

  const modelRegistry = { find: () => ({ contextWindow: 200_000 }) };
  const sessionStart = harness.handlers.get("session_start")!;
  sessionStart({ reason: "startup" }, { modelRegistry } as unknown as ExtensionContext);

  const user1 = userEntry(null, "hello");

  const contextHandler = harness.handlers.get("context")!;
  contextHandler(
    { messages: [{ role: "user", content: "hello" }] },
    {
      sessionManager: { getLeafId: () => user1.id },
      getSystemPrompt: () => "a".repeat(400), // 100 tokens
      model: { provider: "anthropic", id: "claude-test", contextWindow: 200_000 },
      modelRegistry,
    } as unknown as ExtensionContext,
  );

  const assistant1 = assistantEntry(user1.id, { usage: { input: 1000, output: 20, cacheRead: 0, cacheWrite: 0 } });
  const entries = [user1, assistant1];

  let capturedComponent: ContextTreeInspectorComponent | undefined;
  const command = harness.commands.get("context-tree")!;
  await command.handler(
    {},
    {
      mode: "tui",
      ui: {
        notify: () => {},
        custom: async (factory: (tui: TUI, theme: Theme, kb: unknown, done: (v: unknown) => void) => unknown) => {
          capturedComponent = (await factory(fakeTui(), fakeTheme(), {}, () => {})) as ContextTreeInspectorComponent;
          return undefined;
        },
      },
      sessionManager: {
        getTree: () => buildTree(entries),
        getLeafId: () => assistant1.id,
        getEntries: () => entries,
        getEntry: (id: string) => entries.find((e) => e.id === id),
      },
    } as unknown as ExtensionCommandContext,
  );

  assert.ok(capturedComponent, "the command must open the inspector component");
  // The live "context" snapshot was captured against user1 (the entry right
  // before assistant1's request); move selection up to see it reflected.
  capturedComponent!.handleInput("\x1b[A");
  const panel = capturedComponent!.render(100).join("\n");
  assert.ok(panel.includes("Total: 1,000"), "the selected point should retain its exact context total");
  assert.ok(!panel.includes("System prompt"), "captured category details should not clutter the panel");
});

test("ContextTreeInspectorComponent: Enter never navigates/closes; Escape closes", () => {
  const user1 = userEntry(null, "hello");
  const assistant1 = assistantEntry(user1.id, { text: "hi", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } });
  const entries = [user1, assistant1];
  const tree = buildTree(entries);
  const tracker = new ContextTracker(() => 200_000);
  tracker.sync(entries);

  let closed = false;
  const component = new ContextTreeInspectorComponent({
    tui: fakeTui(),
    theme: fakeTheme(),
    tree,
    leafId: assistant1.id,
    tracker,
    getEntries: () => entries,
    getEntry: (id) => entries.find((e) => e.id === id),
    onClose: () => {
      closed = true;
    },
  });

  const initialLines = component.render(100);
  assert.ok(initialLines.some((l) => l.includes("Context Tree Inspector")));

  component.handleInput("\r"); // Enter
  assert.equal(closed, false, "Enter must not close or navigate the inspector");

  component.handleInput("\x1b"); // Escape
  assert.equal(closed, true, "Escape must close the inspector");
});

test("ContextTreeInspectorComponent: selecting a tool result shows one combined interaction delta", () => {
  const user1 = userEntry(null, "go");
  const assistant1 = assistantEntry(user1.id, {
    usage: { input: 500, output: 30, cacheRead: 0, cacheWrite: 0 },
    toolCalls: [
      { id: "call1", name: "read", arguments: { path: "a.ts" } },
      { id: "call2", name: "grep", arguments: { pattern: "foo" } },
    ],
  });
  const result1 = toolResultEntry(assistant1.id, { toolCallId: "call1", toolName: "read", content: "aaaa" });
  // result2's direct parent is result1 (a sibling), not assistant1.
  const result2 = toolResultEntry(result1.id, { toolCallId: "call2", toolName: "grep", content: "bbbb" });
  const entries = [user1, assistant1, result1, result2];
  const tree = buildTree(entries);
  const tracker = new ContextTracker(() => 200_000);
  tracker.sync(entries);

  const component = new ContextTreeInspectorComponent({
    tui: fakeTui(),
    theme: fakeTheme(),
    tree,
    leafId: result2.id,
    tracker,
    getEntries: () => entries,
    getEntry: (id) => entries.find((e) => e.id === id),
    onClose: () => {},
  });

  const panel = component.render(100).join("\n");
  assert.ok(panel.includes("grep"), "the panel title should resolve call2's name across the sibling chain");
  assert.ok(panel.includes("foo"), "the panel title should resolve call2's arguments across the sibling chain");
  assert.ok(panel.includes("Interaction delta"));
  assert.ok(panel.includes("call + arguments"));
  assert.ok(panel.includes("response"));
  assert.ok(!panel.includes("Row delta"));
});

test("ContextTreeInspectorComponent: keeps the insights panel inside the terminal viewport", () => {
  const entries: SessionEntry[] = [];
  let parentId: string | null = null;
  for (let i = 0; i < 78; i++) {
    const entry = userEntry(parentId, `message ${i}`);
    entries.push(entry);
    parentId = entry.id;
  }
  const assistant = assistantEntry(parentId, {
    toolCalls: [{ id: "call1", name: "read", arguments: { path: "large.ts" } }],
  });
  const result = toolResultEntry(assistant.id, {
    toolCallId: "call1",
    toolName: "read",
    content: "large response",
  });
  entries.push(assistant, result);
  parentId = result.id;

  const tracker = new ContextTracker(() => 200_000);
  tracker.sync(entries);
  const component = new ContextTreeInspectorComponent({
    tui: fakeTui(),
    theme: fakeTheme(),
    tree: buildTree(entries),
    leafId: parentId,
    tracker,
    getEntries: () => entries,
    getEntry: (id) => entries.find((entry) => entry.id === id),
    onClose: () => {},
  });

  const lines = component.render(100);
  assert.equal(lines[0]?.includes("Context Tree Inspector"), true);
  assert.ok(lines.length <= 40, `rendered ${lines.length} lines into a 40-row terminal`);
});

test("ContextTreeInspectorComponent: assistant exchange derives request, response, and total growth", () => {
  const user1 = userEntry(null, "initial");
  const assistant1 = assistantEntry(user1.id, {
    text: "previous response",
    usage: { input: 99_000, output: 1000, totalTokens: 100_000 },
  });
  const user2 = userEntry(assistant1.id, "small question");
  const assistant2 = assistantEntry(user2.id, {
    text: "large response",
    usage: { input: 100_100, output: 900, totalTokens: 101_000 },
  });
  const entries = [user1, assistant1, user2, assistant2];
  const tracker = new ContextTracker(() => 200_000);
  tracker.sync(entries);

  const component = new ContextTreeInspectorComponent({
    tui: fakeTui(),
    theme: fakeTheme(),
    tree: buildTree(entries),
    leafId: assistant2.id,
    tracker,
    getEntries: () => entries,
    getEntry: (id) => entries.find((entry) => entry.id === id),
    onClose: () => {},
  });

  const panel = component.render(100).join("\n");
  assert.ok(panel.includes("Total delta: 1,000"));
  assert.ok(panel.includes("request 100"));
  assert.ok(panel.includes("response 900"));
});

test("ContextTreeInspectorComponent: panel reflects the highlighted row, not a fixed one", () => {
  const user1 = userEntry(null, "hello");
  const assistant1 = assistantEntry(user1.id, { text: "hi", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } });
  const entries = [user1, assistant1];
  const tree = buildTree(entries);
  const tracker = new ContextTracker(() => 200_000);
  tracker.sync(entries);

  const component = new ContextTreeInspectorComponent({
    tui: fakeTui(),
    theme: fakeTheme(),
    tree,
    leafId: assistant1.id,
    tracker,
    getEntries: () => entries,
    getEntry: (id) => entries.find((e) => e.id === id),
    onClose: () => {},
  });

  const atAssistant = component.render(100).join("\n");
  assert.ok(atAssistant.includes("assistant message"));

  component.handleInput("\x1b[A"); // up arrow: move selection to the user message
  const atUser = component.render(100).join("\n");
  assert.ok(atUser.includes("user message"));
});
