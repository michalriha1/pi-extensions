import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const indexSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

test("session shutdown disposes snapshot, timers, references, and git work", () => {
  assert.match(
    indexSource,
    /pi\.on\("session_shutdown"[\s\S]*?clearRenderTimers\(\);[\s\S]*?tuiRef = null;[\s\S]*?sessionSnapshots\.dispose\(\);[\s\S]*?disposeGitStatus\(\);[\s\S]*?\}\);/,
  );
});

test("footer replacement and reload remove subscriptions and callbacks", () => {
  assert.match(
    indexSource,
    /dispose:\s*\(\)\s*=>\s*\{[\s\S]*?unsubscribeBranch\(\);[\s\S]*?clearRenderTimers\(\);[\s\S]*?setOnFetchComplete\(null\);[\s\S]*?renderCache\.dispose\(\);[\s\S]*?disposeGitStatus\(\);[\s\S]*?\}/,
  );
  assert.match(indexSource, /registerCommand\("footer"[\s\S]*?setupFooter\(ctx, presentation\);/);
});

test("configuration diagnostics notify only at startup or explicit reload, never during redraw", () => {
  const renderBody = indexSource.match(/render\(width: number\): string\[\] \{([\s\S]*?)\n        \},/)?.[1] ?? "";
  assert.doesNotMatch(renderBody, /notify|configDiagnostics/);
  assert.match(indexSource, /session_start[\s\S]*?notifyConfigDiagnostics\(ctx, presentation\)/);
  assert.match(indexSource, /presentationSnapshots\.reload\(\)[\s\S]*?notifyConfigDiagnostics\(ctx, presentation\)/);
});

test("directory changes perform one root invalidation", () => {
  const body = indexSource.match(/const invalidateForDirectoryChange = \(\): void => \{([\s\S]*?)\n  \};/)?.[1] ?? "";
  assert.match(body, /invalidateGitRoot\(\)/);
  assert.doesNotMatch(body, /invalidateGitBranch|invalidateGitStatus/);
});

test("delayed renders are coalesced by delay", () => {
  assert.match(indexSource, /if \(renderTimers\.has\(delayMs\)\) return;/);
  assert.match(indexSource, /renderTimers\.delete\(delayMs\);/);
});
