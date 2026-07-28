import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, visibleWidth } from "@earendil-works/pi-tui";
import { ASCII_ICONS } from "../icons.ts";
import {
  createFooterRenderCache,
  type FooterRenderInput,
  type FooterRenderInstrumentation,
} from "../footer-render-cache.ts";
import type { PresentationSnapshot } from "../presentation.ts";
import type { SessionSnapshot } from "../session-snapshot.ts";
import type { GitStatus, StatusLineSegmentId } from "../types.ts";

function instrumentation(): FooterRenderInstrumentation {
  return {
    segmentRenders: 0,
    layoutPasses: 0,
    widthPasses: 0,
    truncationPasses: 0,
    statusSorts: 0,
    finalRowAllocations: 0,
  };
}

const theme = { fg: (_color: string, text: string) => text } as Theme;
const presentation: PresentationSnapshot = Object.freeze({
  leftSegments: Object.freeze(["model", "ext_status", "git"] satisfies StatusLineSegmentId[]),
  rightSegments: Object.freeze(["context_pct"] satisfies StatusLineSegmentId[]),
  colors: Object.freeze({}),
  segmentOptions: Object.freeze({}),
  icons: Object.freeze({ ...ASCII_ICONS }),
  nerdFonts: false,
  thinkingLabels: Object.freeze({}),
  customIconNames: Object.freeze([]),
  hasUserConfig: false,
  configFound: false,
  configDiagnostics: Object.freeze([]),
});
const session: SessionSnapshot = Object.freeze({
  usageStats: Object.freeze({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0 }),
  contextTokens: 20,
  contextPercent: 10,
  contextWindow: 200,
  thinkingLevel: "off",
  model: undefined,
  sessionId: "session",
  usingSubscription: false,
  autoCompactEnabled: true,
  sessionStartTime: 1,
});
const git: GitStatus = Object.freeze({
  branch: "main",
  worktreeDir: "/repo",
  repoName: "repo",
  staged: 0,
  unstaged: 0,
  untracked: 0,
});

function input(statuses = new Map<string, string>()): FooterRenderInput {
  return {
    width: 80,
    cwd: "/repo",
    theme,
    presentation,
    session,
    git,
    extensionStatuses: statuses,
  };
}

function renderWork(metrics: FooterRenderInstrumentation): readonly number[] {
  return [
    metrics.segmentRenders,
    metrics.layoutPasses,
    metrics.widthPasses,
    metrics.truncationPasses,
    metrics.statusSorts,
    metrics.finalRowAllocations,
  ];
}

test("3,600 unchanged renders compute the complete row once and return the same array", () => {
  const metrics = instrumentation();
  const cache = createFooterRenderCache(metrics);
  const current = input(new Map([["z", "Z"], ["a", "A"]]));
  const first = cache.render(current);

  for (let index = 1; index < 3_600; index++) {
    assert.strictEqual(cache.render(current), first);
  }

  assert.equal(metrics.layoutPasses, 1);
  assert.equal(metrics.segmentRenders, 4);
  assert.equal(metrics.statusSorts, 1);
  assert.equal(metrics.finalRowAllocations, 1);
});

test("rows obey zero, one, narrow, exact, and wide visible widths with ANSI and wide Unicode", () => {
  const ansiTheme = { fg: (_color: string, text: string) => `\x1b[31m${text}\x1b[0m` } as Theme;
  const unicodePresentation: PresentationSnapshot = {
    ...presentation,
    leftSegments: ["text:界🙂", "model"],
    rightSegments: ["context_pct"],
  };
  const cache = createFooterRenderCache();
  for (const width of [0, 1, 2, 3, 8, 20, 80]) {
    const rows = cache.render({ ...input(), width, theme: ansiTheme, presentation: unicodePresentation });
    assert.equal(rows.length, 1);
    assert.equal(visibleWidth(rows[0] ?? ""), width, `width ${width}`);
  }
});

test("widths cache independently", () => {
  const metrics = instrumentation();
  const cache = createFooterRenderCache(metrics);
  const current = input();
  const eighty = cache.render(current);
  const narrow = cache.render({ ...current, width: 40 });

  assert.notStrictEqual(narrow, eighty);
  assert.strictEqual(cache.render(current), eighty);
  assert.strictEqual(cache.render({ ...current, width: 40 }), narrow);
  assert.equal(metrics.layoutPasses, 2);
  assert.equal(metrics.finalRowAllocations, 2);
});

test("every visible state dimension causes exactly one recompute", () => {
  const metrics = instrumentation();
  const cache = createFooterRenderCache(metrics);
  const statuses = new Map<string, string>([["b", "B"], ["a", "A"]]);
  let current = input(statuses);
  cache.render(current);

  const changes: Array<() => void> = [
    () => { current = { ...current, session: { ...session, thinkingLevel: "low" } }; },
    () => { current = { ...current, git: { ...git, staged: 1 } }; },
    () => { current = { ...current, git: { ...current.git, branch: "feature" } }; },
    () => { statuses.set("a", "changed"); },
    () => { current = { ...current, presentation: { ...presentation } }; },
    () => { cache.invalidateTheme(); },
  ];

  for (const change of changes) {
    const before = metrics.layoutPasses;
    change();
    const rows = cache.render(current);
    assert.equal(metrics.layoutPasses, before + 1);
    assert.strictEqual(cache.render(current), rows);
    assert.equal(metrics.layoutPasses, before + 1);
  }
  assert.equal(metrics.statusSorts, 2, "statuses sort only initially and after content mutation");
});

test("cache hits perform no rendering, sorting, width work, truncation, or row allocation", () => {
  const metrics = instrumentation();
  const cache = createFooterRenderCache(metrics);
  const statuses = new Map([["extension", "ready"]]);
  const current = input(statuses);
  cache.render(current);
  const before = renderWork(metrics);

  for (let index = 0; index < 100; index++) cache.render(current);

  assert.deepEqual(renderWork(metrics), before);
});

test("status map checks preserve ordering and avoid sorting until content changes", () => {
  const metrics = instrumentation();
  const cache = createFooterRenderCache(metrics);
  const statuses = new Map([["z", "last"], ["a", "first"]]);
  const current = input(statuses);
  const first = cache.render(current);
  assert.match(first[0] ?? "", /first last/);

  statuses.delete("z");
  statuses.set("z", "last");
  assert.strictEqual(cache.render(current), first, "insertion-order-only changes are not visible");
  assert.equal(metrics.statusSorts, 1);

  statuses.set("z", "changed");
  const changed = cache.render(current);
  assert.notStrictEqual(changed, first);
  assert.match(changed[0] ?? "", /first changed/);
  assert.equal(metrics.statusSorts, 2);
});

test("clear and dispose release rows and prevent later computation", () => {
  const metrics = instrumentation();
  const cache = createFooterRenderCache(metrics);
  const current = input();
  const first = cache.render(current);
  cache.clear();
  assert.notStrictEqual(cache.render(current), first);
  assert.equal(metrics.finalRowAllocations, 2);

  cache.dispose();
  assert.deepEqual(cache.render(current), []);
  assert.equal(metrics.finalRowAllocations, 2);
});

test("TUI containers copy component rows instead of mutating render output", () => {
  const rows = ["cached"];
  const container = new Container();
  container.addChild({ render: () => rows, invalidate() {} });

  const rendered = container.render(80);
  assert.notStrictEqual(rendered, rows);
  assert.deepEqual(rows, ["cached"]);
  rendered[0] = "changed";
  assert.deepEqual(rows, ["cached"]);
});
