import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { createConfigController, type ConfigReader } from "../config.ts";
import { ASCII_ICONS, type IconSet, mergeIcons } from "../icons.ts";
import {
  createPresentationSnapshotController,
  type PresentationSnapshotDependencies,
} from "../presentation.ts";
import { renderSegment } from "../segments.ts";
import type { SegmentContext } from "../types.ts";

function countingReader(content: string | null): ConfigReader & { probes: number; reads: number } {
  return {
    probes: 0,
    reads: 0,
    exists() {
      this.probes++;
      return content !== null;
    },
    read() {
      this.reads++;
      if (content === null) throw new Error("missing");
      return content;
    },
  };
}

for (const [name, content, expectedReads] of [
  ["valid", '{"leftSegments":["model"]}', 1],
  ["missing", null, 0],
  ["invalid", "{", 1],
] as const) {
  test(`${name} config is probed and read once until explicit clear`, () => {
    const reader = countingReader(content);
    const controller = createConfigController(reader, () => "/config.json");

    for (let index = 0; index < 20; index++) {
      controller.loadUserConfig();
      controller.getEffectiveConfig();
      controller.getState();
    }
    assert.equal(reader.probes, 1);
    assert.equal(reader.reads, expectedReads);
    assert.strictEqual(controller.getEffectiveConfig(), controller.getEffectiveConfig());

    controller.clear();
    controller.getEffectiveConfig();
    assert.equal(reader.probes, 2);
    assert.equal(reader.reads, expectedReads * 2);
  });
}

test("malformed and partially invalid config falls back per field with actionable diagnostics", () => {
  const malformed = createConfigController(countingReader("{"), () => "/config.json").getState();
  assert.equal(malformed.userConfig, null);
  assert.equal(malformed.configFound, true);
  assert.match(malformed.diagnostics[0] ?? "", /could not parse \/config\.json/);
  assert.deepEqual(malformed.effectiveConfig.rightSegments, ["separator", "context_pct"]);

  const partial = createConfigController(countingReader(JSON.stringify({
    leftSegments: ["model", "text:kept"],
    rightSegments: ["unknown"],
    colors: { model: "#abcdef", path: "not-a-color", unknown: "text" },
    segmentOptions: {
      model: { showThinkingLevel: true },
      path: { mode: "invalid", maxLength: 12 },
      git: { showBranch: "yes", showStaged: false },
    },
    icons: { pi: "CUSTOM\u001b", model: 3, unknown: "x" },
  })), () => "/config.json").getState();

  assert.deepEqual(partial.effectiveConfig.leftSegments, ["model", "text:kept"]);
  assert.deepEqual(partial.effectiveConfig.rightSegments, ["separator", "context_pct"]);
  assert.equal(partial.effectiveConfig.colors.model, "#abcdef");
  assert.notEqual(partial.effectiveConfig.colors.path, "not-a-color");
  assert.equal(partial.effectiveConfig.segmentOptions.model?.showThinkingLevel, true);
  assert.equal(partial.effectiveConfig.segmentOptions.path?.mode, "basename");
  assert.equal(partial.effectiveConfig.segmentOptions.path?.maxLength, 12);
  assert.equal(partial.effectiveConfig.segmentOptions.git?.showBranch, true);
  assert.equal(partial.effectiveConfig.segmentOptions.git?.showStaged, false);
  assert.equal(partial.effectiveConfig.icons.pi, "CUSTOM\u001b", "trusted custom icons remain unchanged");
  assert.equal(partial.effectiveConfig.icons.model, undefined);
  assert.ok(partial.diagnostics.length >= 6);
  assert.match(partial.diagnostics.join("; "), /rightSegments|colors\.path|segmentOptions\.path\.mode|icons\.model/);
});

test("filesystem, repository, and branch text is sanitized while trusted custom text remains unchanged", () => {
  const ctx = modelContext(ASCII_ICONS, {}, "off");
  ctx.cwd = "/repo/tab\tline\n\u001b[31m\u0001";
  ctx.colors = { path: "text", gitDirty: "text", gitClean: "text" };
  ctx.git = {
    branch: "feature\tbad\n\u001b[2J\u007f",
    worktreeDir: "/repo",
    repoName: "repo\tname\n\u001b]0;bad\u0007",
    staged: 0,
    unstaged: 0,
    untracked: 0,
  };
  const path = renderSegment("path", ctx).content;
  const git = renderSegment("git", ctx).content;
  assert.doesNotMatch(path, /[\u0000-\u001f\u007f-\u009f]/);
  assert.doesNotMatch(git, /[\u0000-\u001f\u007f-\u009f]/);
  assert.match(path, /�/);
  assert.match(git, /�/);
  assert.equal(renderSegment("text:trusted\u001b[31m", ctx).content, "trusted\u001b[31m");
});

test("partial config keeps defaults and custom icons merge once per snapshot", () => {
  const config = createConfigController(
    countingReader('{"leftSegments":["pi"],"icons":{"pi":"P"}}'),
    () => "/config.json",
  );
  let detections = 0;
  let merges = 0;
  const dependencies: PresentationSnapshotDependencies = {
    getConfigState: () => config.getState(),
    clearConfig: () => config.clear(),
    detectNerdFonts: () => {
      detections++;
      return false;
    },
    mergeIcons: (nerdFonts, customIcons) => {
      merges++;
      return mergeIcons(nerdFonts, customIcons);
    },
  };
  const snapshots = createPresentationSnapshotController(dependencies);
  const first = snapshots.getSnapshot();

  assert.strictEqual(snapshots.getSnapshot(), first);
  assert.strictEqual(snapshots.getSnapshot(), first);
  assert.equal(detections, 1);
  assert.equal(merges, 1);
  assert.equal(first.icons.pi, "P");
  assert.equal(first.icons.model, ASCII_ICONS.model);
  assert.deepEqual(first.rightSegments, ["separator", "context_pct"]);
  assert.deepEqual(first.customIconNames, ["pi"]);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.icons), true);
});

function modelContext(
  icons: IconSet,
  thinkingLabels: Readonly<Record<string, string>>,
  level: string,
): SegmentContext {
  return {
    model: { id: "model", reasoning: true },
    thinkingLevel: level,
    sessionId: "session",
    usageStats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    contextPercent: 0,
    contextWindow: 0,
    autoCompactEnabled: true,
    usingSubscription: false,
    sessionStartTime: 0,
    cwd: "/repo",
    git: { branch: null, worktreeDir: null, repoName: null, staged: 0, unstaged: 0, untracked: 0 },
    extensionStatusText: "",
    options: { model: { showThinkingLevel: true } },
    width: 80,
    theme: { fg: (_color, text) => text } as Theme,
    colors: { model: "text" },
    icons,
    thinkingLabels,
  };
}

test("Nerd Font detection runs once per snapshot and model thinking labels retain exact output", () => {
  let nerdFonts = false;
  let detections = 0;
  const config = createConfigController(countingReader("{}"), () => "/config.json");
  const dependencies: PresentationSnapshotDependencies = {
    getConfigState: () => config.getState(),
    clearConfig: () => config.clear(),
    detectNerdFonts: () => {
      detections++;
      return nerdFonts;
    },
    mergeIcons,
  };
  const snapshots = createPresentationSnapshotController(dependencies);
  const ascii = snapshots.getSnapshot();

  assert.equal(renderSegment("model", modelContext(ascii.icons, ascii.thinkingLabels, "minimal")).content, "◈ model · [min]");
  assert.deepEqual(ascii.thinkingLabels, {
    minimal: "[min]",
    low: "[low]",
    medium: "[med]",
    high: "[high]",
    xhigh: "[xhi]",
  });
  assert.equal(detections, 1);

  nerdFonts = true;
  const nerd = snapshots.reload();
  assert.equal(renderSegment("model", modelContext(nerd.icons, nerd.thinkingLabels, "minimal")).content, "\uEC19 model · \u{F0E7} min");
  assert.deepEqual(nerd.thinkingLabels, {
    minimal: "\u{F0E7} min",
    low: "\u{F10C} low",
    medium: "\u{F192} med",
    high: "\u{F111} high",
    xhigh: "\u{F06D} xhi",
  });
  assert.equal(detections, 2);
});

test("unknown post-compaction context is rendered explicitly", () => {
  const ctx = modelContext(ASCII_ICONS, {}, "off");
  ctx.contextPercent = null;
  ctx.contextWindow = 200_000;
  ctx.options = { context_pct: { showAutoIcon: false } };

  assert.equal(renderSegment("context_pct", ctx).content, "◫ ?%/200k");
});

test("reload creates one new snapshot and picks up changed config", () => {
  let content = '{"leftSegments":["pi"]}';
  let clears = 0;
  let builds = 0;
  const reader: ConfigReader = {
    exists: () => true,
    read: () => content,
  };
  const config = createConfigController(reader, () => "/config.json");
  const dependencies: PresentationSnapshotDependencies = {
    getConfigState: () => {
      builds++;
      return config.getState();
    },
    clearConfig: () => {
      clears++;
      config.clear();
    },
    detectNerdFonts: () => false,
    mergeIcons,
  };
  const snapshots = createPresentationSnapshotController(dependencies);
  const first = snapshots.getSnapshot();
  content = '{"leftSegments":["model"]}';
  const second = snapshots.reload();

  assert.notStrictEqual(second, first);
  assert.deepEqual(second.leftSegments, ["model"]);
  assert.strictEqual(snapshots.getSnapshot(), second);
  assert.equal(clears, 1);
  assert.equal(builds, 2);
});
