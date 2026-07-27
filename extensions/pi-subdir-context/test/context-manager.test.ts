import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MAX_CONTEXT_BYTES, SubdirContextManager } from "../src/context-manager.ts";
import { neverIgnored, tempProject } from "./helpers.ts";

test("context batches load root-to-leaf, label sources/scopes, deduplicate, and reset per session", async (t) => {
  const project = await tempProject();
  t.after(project.cleanup);
  await project.write(".pi/AGENTS.md", "ROOT INSTRUCTIONS");
  await project.write("src/.claude/CLAUDE.md", "LEAF INSTRUCTIONS");
  const target = await project.write("src/deep/file.ts");
  const manager = await SubdirContextManager.create(project.root, neverIgnored);

  const first = await manager.contextForTarget(target);
  assert.equal(first.contexts.length, 2);
  assert.ok(first.text.indexOf("ROOT INSTRUCTIONS") < first.text.indexOf("LEAF INSTRUCTIONS"));
  assert.match(first.text, /Source: \.pi\/AGENTS\.md/);
  assert.match(first.text, /Scope: \.\/\*\*/);
  assert.match(first.text, /Scope: src\/\*\*/);
  assert.equal((await manager.contextForTarget(target)).contexts.length, 0);

  manager.resetSession();
  assert.equal((await manager.contextForTarget(target)).contexts.length, 2);
});

test("explicit context-file operations do not recursively discover context", async (t) => {
  const project = await tempProject();
  t.after(project.cleanup);
  const contextFile = await project.write(".pi/AGENTS.md", "instructions");
  const manager = await SubdirContextManager.create(project.root, neverIgnored);

  assert.equal((await manager.contextForTarget(contextFile)).contexts.length, 0);
  await manager.noteSuccessfulContextRead(contextFile, false);
  assert.equal(manager.loadedSources.size, 1);
});

test("project boundaries reject traversal, absolute outside paths, symlink escapes, and skipped trees", async (t) => {
  const project = await tempProject();
  const outside = await mkdtemp(path.join(tmpdir(), "pi-subdir-outside-"));
  t.after(async () => {
    await project.cleanup();
    await rm(outside, { recursive: true, force: true });
  });
  await writeFile(path.join(outside, "outside.ts"), "outside", "utf8");
  await project.symlink(outside, "linked-outside");
  await project.write("node_modules/pkg/index.ts");
  await project.write(".git/config");
  const manager = await SubdirContextManager.create(project.root, neverIgnored);

  assert.equal(await manager.resolveTarget("../outside.ts"), undefined);
  assert.equal(await manager.resolveTarget(path.join(outside, "outside.ts")), undefined);
  assert.equal(await manager.resolveTarget("linked-outside/new.ts"), undefined);
  assert.equal(await manager.resolveTarget("node_modules/pkg/index.ts"), undefined);
  assert.equal(await manager.resolveTarget(".git/config"), undefined);
  assert.equal(await manager.resolveTarget("new/deep/file.ts"), path.join(project.root, "new/deep/file.ts"));
});

test("a single oversized source is truncated to Pi-comparable output limits", async (t) => {
  const project = await tempProject();
  t.after(project.cleanup);
  await project.write(".pi/AGENTS.md", "x".repeat(MAX_CONTEXT_BYTES * 2));
  const target = await project.write("src/file.ts");
  const manager = await SubdirContextManager.create(project.root, neverIgnored);

  const batch = await manager.contextForTarget(target);
  assert.equal(batch.contexts.length, 1);
  assert.equal(batch.contexts[0]?.truncated, true);
  assert.equal(batch.truncated, true);
  assert.ok(Buffer.byteLength(batch.text) <= MAX_CONTEXT_BYTES);
  assert.match(batch.text, /source truncated at the safety limit/);
});
