import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { ContextDiscovery } from "../src/discovery.ts";
import { neverIgnored, tempProject } from "./helpers.ts";

test("config-root precedence is existence-based and independent at every ancestor", async (t) => {
  const project = await tempProject();
  t.after(project.cleanup);
  await project.directory(".pi");
  await project.write(".claude/AGENTS.md", "lower priority root context");
  await project.write("src/.claude/AGENTS.md", "nested context");
  const target = await project.write("src/deep/file.ts");

  const discovery = new ContextDiscovery(project.root, neverIgnored);
  const sources = await discovery.discover(target);

  assert.deepEqual(sources.map((source) => path.relative(project.root, source.path)), ["src/.claude/AGENTS.md"]);
});

test("override wins over AGENTS while CLAUDE, cursor rules, and skills retain deterministic hierarchy order", async (t) => {
  const project = await tempProject();
  t.after(project.cleanup);
  await project.write(".pi/AGENTS.md", "superseded");
  await project.write(".pi/AGENTS.override.md", "root override");
  await project.write(".pi/CLAUDE.md", "root claude");
  await project.write("src/.cursor/AGENTS.md", "nested agents");
  await project.write("src/.cursor/rules/z-last.mdc", "z rule");
  await project.write("src/.cursor/rules/group/a-first.md", "a rule");
  await project.write(
    "src/.cursor/skills/testing/SKILL.md",
    "---\nname: testing\ndescription: Test rules\n---\nSkill body",
  );
  const target = await project.write("src/components/file.ts");

  const sources = await new ContextDiscovery(project.root, neverIgnored).discover(target);

  assert.deepEqual(sources.map((source) => path.relative(project.root, source.path)), [
    ".pi/AGENTS.override.md",
    ".pi/CLAUDE.md",
    "src/.cursor/AGENTS.md",
    "src/.cursor/rules/group/a-first.md",
    "src/.cursor/rules/z-last.mdc",
    "src/.cursor/skills/testing/SKILL.md",
  ]);
  assert.equal(sources.at(-1)?.skill?.name, "testing");
  assert.equal(sources.at(-1)?.skill?.description, "Test rules");
});

test("skill paths use gitignore matching relative to the selected root's containing directory", async (t) => {
  const project = await tempProject();
  t.after(project.cleanup);
  await project.write(
    ".claude/skills/all/SKILL.md",
    "---\nname: all\ndescription: Every file\n---\nAlways",
  );
  await project.write(
    ".claude/skills/typescript/SKILL.md",
    "---\nname: typescript\ndescription: TS only\npaths:\n  - src/**/*.ts\n  - '!src/generated/*.ts'\n---\nTS",
  );
  await project.write(
    ".claude/skills/docs/SKILL.md",
    "---\nname: docs\ndescription: Docs only\npaths: docs/**/*.md\n---\nDocs",
  );
  const sourceTarget = await project.write("src/app.ts");
  const generatedTarget = await project.write("src/generated/app.ts");
  const docsTarget = await project.write("docs/guide/start.md");
  const discovery = new ContextDiscovery(project.root, neverIgnored);

  assert.deepEqual((await discovery.discover(sourceTarget)).map((source) => source.skill?.name), ["all", "typescript"]);
  assert.deepEqual((await discovery.discover(generatedTarget)).map((source) => source.skill?.name), ["all"]);
  assert.deepEqual((await discovery.discover(docsTarget)).map((source) => source.skill?.name), ["all", "docs"]);
});

test("an ignored winning config root is skipped without inspecting fallback roots", async (t) => {
  const project = await tempProject();
  t.after(project.cleanup);
  const piRoot = await project.directory(".pi");
  await project.write(".pi/AGENTS.md", "ignored");
  await project.write(".claude/AGENTS.md", "must not fall back");
  const target = await project.write("src/file.ts");
  const checked: string[] = [];
  const discovery = new ContextDiscovery(project.root, async (candidate) => {
    checked.push(candidate);
    return candidate === piRoot;
  });

  assert.deepEqual(await discovery.discover(target), []);
  assert.deepEqual(checked, [piRoot]);
});
