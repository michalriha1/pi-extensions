import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { ExtensionAPI, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { discoverySkills, parsePolicy, PolicyReader, skillCommandName, stateFor } from "../policy.ts";

const installed = process.env.PI_TEST_RUNTIME ?? "/Users/michalriha/.pi/agent/install/releases/1.2.0/node_modules/@earendil-works/pi-coding-agent";
const require = createRequire(join(installed, "package.json"));
const { formatSkillsForPrompt } = await import(require.resolve("./dist/core/skills.js"));
const skill = (name: string, manual = false): Skill => ({ name, description: "secret description", filePath: `/skills/${name}/SKILL.md`, baseDir: `/skills/${name}`, disableModelInvocation: manual, sourceInfo: { source: "user", scope: "user", origin: "top-level" } } as Skill);

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const global = join(root, "global");
  const cwd = join(root, "project");
  mkdirSync(global); mkdirSync(join(cwd, ".claude"), { recursive: true });
  const write = (path: string, entries: Record<string, string>) => writeFileSync(path, JSON.stringify({ skillOverrides: entries }));
  return { root, global, cwd, write, g: join(global, "settings.json"), p: join(cwd, ".claude/settings.json"), l: join(cwd, ".claude/settings.local.json") };
}

test("schema validates only skillOverrides, rejects invalid maps atomically", () => {
  assert.equal(parsePolicy('{"other":false}').size, 0);
  for (const value of [null, [], "off", { a: false }, { a: "invalid" }, { "": "off" }]) {
    assert.throws(() => parsePolicy(JSON.stringify({ skillOverrides: value })));
  }
  assert.throws(() => parsePolicy("[]"));
  assert.equal(parsePolicy('{"skillOverrides":{"__proto__":"off"}}').get("__proto__"), "off");
});

test("all discovery states, default, native manual restriction and installed renderer", () => {
  const skills = [skill("on"), skill("name"), skill("manual"), skill("off"), skill("default"), skill("native", true)];
  const policy = parsePolicy(JSON.stringify({ skillOverrides: { on: "on", name: "name-only", manual: "user-invocable-only", off: "off", native: "on" } }));
  const output = discoverySkills(skills, policy);
  assert.deepEqual(output.map(s => s.name), ["on", "name", "default"]);
  assert.equal(output[1].description, "");
  assert.equal(skills[1].description, "secret description");
  const rendered = formatSkillsForPrompt([output[1]]);
  assert.match(rendered, /\/skills\/name\/SKILL.md/);
  assert.doesNotMatch(rendered, /secret description/);
  for (const state of ["on", "name-only", "user-invocable-only", "off"]) {
    assert.deepEqual(discoverySkills([skill("native", true)], parsePolicy(JSON.stringify({ skillOverrides: { native: state } }))), []);
  }
});

test("merge, live edits, malformed retention/recovery/deletion, trust and cwd-only root", t => {
  const f = fixture(t); const warnings: string[] = []; const reader = new PolicyReader(s => warnings.push(s));
  f.write(f.g, { a: "off", b: "name-only", c: "off" });
  f.write(f.p, { a: "on", b: "off" }); f.write(f.l, { b: "on" });
  assert.deepEqual([...reader.refresh(f.cwd, true, f.global)], [["a", "on"], ["b", "on"], ["c", "off"]]);
  assert.equal(reader.refresh(f.cwd, false, f.global).get("a"), "off");
  f.write(f.l, { a: "name-only" });
  assert.equal(reader.refresh(f.cwd, true, f.global).get("a"), "name-only");
  writeFileSync(f.l, '{broken-secret');
  assert.equal(reader.refresh(f.cwd, true, f.global).get("a"), "name-only");
  reader.refresh(f.cwd, true, f.global); assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes("broken-secret"));
  f.write(f.l, { a: "off" }); assert.equal(reader.refresh(f.cwd, true, f.global).get("a"), "off");
  rmSync(f.l); assert.equal(reader.refresh(f.cwd, true, f.global).get("a"), "on");
  const child = join(f.cwd, "child"); mkdirSync(child);
  assert.equal(reader.refresh(child, true, f.global).get("a"), "off");
  writeFileSync(f.g, '{'); assert.equal(reader.refresh(f.cwd, false, f.global).get("a"), "off");
  assert.equal(new PolicyReader(() => {}).refresh(child, false, f.global).size, 0);
});

test("matches Claude directory and plugin-qualified keys", () => {
  const policy = parsePolicy(JSON.stringify({ skillOverrides: {
    "anthropic-skills:docx": "off",
    "_cursor__teamcity": "name-only",
    exact: "on", "plugin:exact": "off",
  } }));
  const dirSkill = { ...skill("teamcity"), filePath: "/s/_cursor__teamcity/SKILL.md" } as Skill;
  assert.equal(stateFor(policy, "docx"), "off");
  assert.equal(stateFor(policy, "teamcity", dirSkill.filePath), "name-only");
  assert.equal(stateFor(policy, "exact"), "on");
  assert.equal(stateFor(policy, "other", "/s/other/SKILL.md"), "on");
  assert.deepEqual(discoverySkills([skill("docx"), dirSkill], policy).map(s => [s.name, s.description]), [["teamcity", ""]]);
});

test("command boundaries match installed Pi literal-space parser", () => {
  for (const text of ["/skill:x", "/skill:x args", "/skill:x \nargs"]) assert.equal(skillCommandName(text), "x");
  for (const text of [" /skill:x", "hello /skill:x", "/skills:x", "/Skill:x"]) assert.equal(skillCommandName(text), undefined);
  assert.equal(skillCommandName("/skill:xyz"), "xyz");
  assert.equal(skillCommandName("/skill:x\targs"), "x\targs");
  assert.equal(skillCommandName("/skill:x\nargs"), "x\nargs");
});

test("mock host events refresh before expansion, preserve prompt fields, fail closed on absent trust API", t => {
  const f = fixture(t); const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = f.global;
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; });
  const handlers = new Map<string, Function>();
  extension({ on: (name: string, handler: Function) => { handlers.set(name, handler); } } as unknown as ExtensionAPI);
  const ctx = { cwd: f.cwd, isProjectTrusted: () => false } as ExtensionContext;
  f.write(f.g, { x: "off" }); f.write(f.p, { x: "on" });
  const input = (text: string, source = "interactive") => handlers.get("input")!({ text, source }, ctx);
  for (const source of ["interactive", "rpc", "extension"]) assert.equal(input("/skill:x args", source).action, "handled");
  for (const text of ["/skill:xyz", " /skill:x", "/skill:x\targs"]) assert.equal(input(text).action, "continue");
  for (const state of ["on", "name-only", "user-invocable-only", "off"]) {
    f.write(f.g, { x: state });
    assert.equal(input("/skill:x").action, state === "off" ? "handled" : "continue");
    const options = { skills: [skill("x")], sections: { custom: "keep" }, selectedTools: ["read"] };
    assert.equal(handlers.get("before_agent_start")!({ systemPromptOptions: options }, ctx), undefined);
    assert.equal(options.skills.length, ["off", "user-invocable-only"].includes(state) ? 0 : 1);
    assert.deepEqual(options.sections, { custom: "keep" });
    assert.ok(!("forceSystemPrompt" in options));
  }
  ctx.isProjectTrusted = () => true; assert.equal(input("/skill:x").action, "continue");
  delete (ctx as Partial<ExtensionContext>).isProjectTrusted;
  assert.equal(input("/skill:x").action, "handled");
});
