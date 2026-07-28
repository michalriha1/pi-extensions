import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const indexSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

function renderBody(): string {
  const body = indexSource.match(/render\(width: number\): string\[\] \{([\s\S]*?)\n        \},/)?.[1];
  assert.ok(body, "render body not found");
  return body;
}

test("normal footer render delegates stable visible state to the complete-row cache", () => {
  const body = renderBody();
  assert.match(body, /sessionSnapshots\.getSnapshot\(\)/);
  assert.match(body, /renderCache\.render\(\{/);
  assert.match(body, /presentation,/);
  assert.match(body, /session: snapshot,/);
  assert.match(body, /git: getGitStatus\(footerData\.getGitBranch\(\)\)/);
  assert.match(body, /extensionStatuses: footerData\.getExtensionStatuses\(\)/);
  assert.doesNotMatch(body, /getContextUsage|getThinkingLevel|isUsingOAuth|getCompactionSettings/);
});

test("index has no redraw-path config, icon, session scan, or HEAD calls", () => {
  const body = renderBody();
  assert.doesNotMatch(body, /getEffectiveConfig|getIcons|hasNerdFonts|mergeIcons|loadUserConfig/);
  assert.doesNotMatch(body, /sessionManager|getCurrentBranch|readFileSync/);
  assert.match(indexSource, /const presentation = presentationSnapshots\.getSnapshot\(\);[\s\S]*?setupFooter\(ctx, presentation\);/);
  assert.match(indexSource, /const presentation = presentationSnapshots\.reload\(\);[\s\S]*?setupFooter\(ctx, presentation\);/);
});

test("session snapshots are refreshed on documented post-transition events", () => {
  for (const event of [
    "session_start",
    "message_end",
    "session_compact",
    "session_tree",
    "model_select",
    "thinking_level_select",
  ]) {
    assert.match(indexSource, new RegExp(`pi\\.on\\("${event}"`));
  }
  assert.doesNotMatch(indexSource, /pi\.on\("(?:session_fork|session_switch|model_change|thinking_level_change)"/);
  assert.match(indexSource, /createSessionSnapshotController\(pi,/);
  assert.doesNotMatch(indexSource, /ctx\.getThinkingLevel/);
});

test("component invalidation clears theme-dependent cached rows", () => {
  assert.match(indexSource, /invalidate\(\) \{[\s\S]*?renderCache\.invalidateTheme\(\);[\s\S]*?\}/);
});

test("branch provider changes invalidate the cached fallback and request render", () => {
  assert.match(
    indexSource,
    /footerData\.onBranchChange\(\(\) => \{[\s\S]*?invalidateGitBranch\(\);[\s\S]*?tui\.requestRender\(\);[\s\S]*?\}\)/,
  );
});
