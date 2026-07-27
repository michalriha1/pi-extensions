import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import piSubdirContext, { extractPath } from "../src/index.ts";
import { tempProject } from "./helpers.ts";

type Handler = (event: any, context: ExtensionContext) => any;

class ExtensionHarness {
  readonly handlers = new Map<string, Handler>();

  on(event: string, handler: Handler): void {
    this.handlers.set(event, handler);
  }
}

function setup(root: string): { harness: ExtensionHarness; context: ExtensionContext } {
  const harness = new ExtensionHarness();
  const context = {
    cwd: root,
    hasUI: false,
    isProjectTrusted: () => true,
    ui: { notify: () => undefined },
  } as unknown as ExtensionContext;
  piSubdirContext(harness as unknown as ExtensionAPI);
  return { harness, context };
}

test("successful read results receive full applicable context and preserve the original result", async (t) => {
  const project = await tempProject();
  t.after(project.cleanup);
  await project.write(".pi/AGENTS.md", "Read instructions");
  await project.write(
    ".pi/skills/source/SKILL.md",
    "---\nname: source\ndescription: Source skill\npaths: src/**\n---\nFULL SKILL BODY",
  );
  const target = await project.write("src/file.ts", "export {};");
  const { harness, context } = setup(project.root);
  await harness.handlers.get("session_start")?.({ reason: "startup" }, context);

  const original = { type: "text", text: "export {};" };
  const result = await harness.handlers.get("tool_result")?.(
    { toolName: "read", input: { path: target }, content: [original], details: { ok: true }, isError: false },
    context,
  );

  assert.equal(result.content[0], original);
  assert.deepEqual(result.details, { ok: true });
  assert.match(result.content[1].text, /Source: \.pi\/AGENTS\.md/);
  assert.match(result.content[1].text, /Read instructions/);
  assert.match(result.content[1].text, /Skill name: source/);
  assert.match(result.content[1].text, /FULL SKILL BODY/);
  assert.match(result.content[1].text, /---\nname: source/);

  assert.equal(
    await harness.handlers.get("tool_result")?.(
      { toolName: "read", input: { path: target }, content: [original], isError: false },
      context,
    ),
    undefined,
  );
  assert.equal(
    await harness.handlers.get("tool_result")?.(
      { toolName: "read", input: { path: target }, content: [original], isError: true },
      context,
    ),
    undefined,
  );
});

test("edit and write preflights block with context and allow retry on the next turn", async (t) => {
  const project = await tempProject();
  t.after(project.cleanup);
  await project.write(".claude/CLAUDE.md", "MUTATION RULES");
  const target = await project.write("src/file.ts", "old");
  const contextFile = await project.write("src/.cursor/AGENTS.md", "self context");
  const { harness, context } = setup(project.root);
  const start = harness.handlers.get("session_start")!;
  const turnStart = harness.handlers.get("turn_start")!;
  const preflight = harness.handlers.get("tool_call")!;
  await start({ reason: "startup" }, context);
  await turnStart({ turnIndex: 0, timestamp: Date.now() }, context);

  const editInput = { path: target, edits: [{ oldText: "old", newText: "new" }] };
  const firstEdit = await preflight({ toolName: "edit", input: editInput }, context);
  assert.equal(firstEdit.block, true);
  assert.match(firstEdit.reason, /MUTATION RULES/);
  assert.match(firstEdit.reason, /retry the same edit call in a subsequent model turn/);
  assert.equal((await preflight({ toolName: "edit", input: editInput }, context)).block, true);
  await turnStart({ turnIndex: 1, timestamp: Date.now() }, context);
  assert.equal(await preflight({ toolName: "edit", input: editInput }, context), undefined);

  await start({ reason: "new" }, context);
  await turnStart({ turnIndex: 0, timestamp: Date.now() }, context);
  const firstWrite = await preflight({ toolName: "write", input: { path: target, content: "new" } }, context);
  assert.equal(firstWrite.block, true);
  assert.match(firstWrite.reason, /retry the same write call in a subsequent model turn/);
  assert.equal((await preflight({ toolName: "write", input: { path: target, content: "new" } }, context)).block, true);
  await turnStart({ turnIndex: 1, timestamp: Date.now() }, context);
  assert.equal(await preflight({ toolName: "write", input: { path: target, content: "new" } }, context), undefined);

  assert.equal(await preflight({ toolName: "write", input: { path: contextFile, content: "changed" } }, context), undefined);
  assert.equal(await preflight({ toolName: "edit", input: { path: "../outside.ts", edits: [] } }, context), undefined);
});

test("sibling mutations sharing newly applicable context are all blocked until the next model turn", async (t) => {
  const project = await tempProject();
  t.after(project.cleanup);
  await project.write(".pi/AGENTS.md", "SIBLING RULES");
  const firstTarget = await project.write("src/first.ts", "first");
  const secondTarget = await project.write("src/second.ts", "second");
  const { harness, context } = setup(project.root);
  const start = harness.handlers.get("session_start")!;
  const turnStart = harness.handlers.get("turn_start")!;
  const preflight = harness.handlers.get("tool_call")!;

  await start({ reason: "startup" }, context);
  await turnStart({ turnIndex: 0, timestamp: Date.now() }, context);

  const first = await preflight(
    { toolName: "edit", input: { path: firstTarget, edits: [{ oldText: "first", newText: "changed" }] } },
    context,
  );
  const sibling = await preflight(
    { toolName: "write", input: { path: secondTarget, content: "changed" } },
    context,
  );

  assert.equal(first.block, true);
  assert.equal(sibling.block, true);
  assert.match(sibling.reason, /SIBLING RULES/);

  await turnStart({ turnIndex: 1, timestamp: Date.now() }, context);
  assert.equal(
    await preflight(
      { toolName: "edit", input: { path: firstTarget, edits: [{ oldText: "first", newText: "changed" }] } },
      context,
    ),
    undefined,
  );
});

test("context seen in a read satisfies mutation preflight until session reset", async (t) => {
  const project = await tempProject();
  t.after(project.cleanup);
  await project.write(".pi/AGENTS.md", "SESSION RULES");
  const target = await project.write("src/file.ts");
  const { harness, context } = setup(project.root);
  const start = harness.handlers.get("session_start")!;
  const result = harness.handlers.get("tool_result")!;
  const preflight = harness.handlers.get("tool_call")!;

  await start({ reason: "startup" }, context);
  const injected = await result(
    { toolName: "read", input: { path: target }, content: [{ type: "text", text: "target" }], isError: false },
    context,
  );
  assert.match(injected.content[1].text, /SESSION RULES/);
  assert.equal(await preflight({ toolName: "edit", input: { path: target, edits: [] } }, context), undefined);

  await start({ reason: "resume" }, context);
  assert.equal((await preflight({ toolName: "edit", input: { path: target, edits: [] } }, context)).block, true);
});

test("built-in and wrapper path shapes are extracted defensively", () => {
  assert.equal(extractPath({ path: "a.ts", edits: [] }), "a.ts");
  assert.equal(extractPath({ path: "a.ts", content: "x" }), "a.ts");
  assert.equal(extractPath({ args: { path: "wrapped.ts" } }), "wrapped.ts");
  assert.equal(extractPath({ path: 42 }), undefined);
  assert.equal(extractPath(undefined), undefined);
});
