import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { ASCII_ICONS } from "./icons.ts";
import {
  createFooterRenderCache,
  type FooterRenderInput,
  type FooterRenderInstrumentation,
} from "./footer-render-cache.ts";
import type { PresentationSnapshot } from "./presentation.ts";
import { createSessionSnapshotController } from "./session-snapshot.ts";

const SIZES = [0, 100, 1_000, 10_000] as const;
const RENDERS = 3_600;
const theme = { fg: (_color: string, text: string) => text } as Theme;
const presentation: PresentationSnapshot = Object.freeze({
  leftSegments: Object.freeze(["model", "path", "git", "token_total"] as const),
  rightSegments: Object.freeze(["context_pct"] as const),
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

function assistant(index: number): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "benchmark",
    model: "benchmark",
    usage: {
      input: index + 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: index + 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: index,
  };
}

function makeBranch(size: number): SessionEntry[] {
  return Array.from({ length: size }, (_, index) => ({
    type: "message" as const,
    id: String(index),
    parentId: index === 0 ? null : String(index - 1),
    timestamp: "2025-01-01T00:00:00.000Z",
    message: assistant(index),
  }));
}

function metrics(): FooterRenderInstrumentation {
  return { segmentRenders: 0, layoutPasses: 0, widthPasses: 0, truncationPasses: 0, statusSorts: 0, finalRowAllocations: 0 };
}

console.log(`pi-vitals benchmark (${RENDERS.toLocaleString()} unchanged renders)`);
console.log("entries\tcold snapshot ms\tcache-hit renders ms\tbranch scans\tlayouts\trow allocations");
for (const size of SIZES) {
  const branch = makeBranch(size);
  let scans = 0;
  const ctx = {
    sessionManager: {
      getBranch: () => { scans++; return branch; },
      getSessionId: () => "benchmark",
      getHeader: () => ({ timestamp: "2025-01-01T00:00:00.000Z" }),
    },
    modelRegistry: { isUsingOAuth: () => false },
    model: undefined,
    getContextUsage: () => ({ tokens: 0, percent: 0, contextWindow: 200_000 }),
  } as unknown as ExtensionContext;
  const snapshots = createSessionSnapshotController({ getThinkingLevel: () => "off" }, () => {});
  const coldStart = performance.now();
  snapshots.start(ctx);
  const snapshot = snapshots.getSnapshot();
  const coldMs = performance.now() - coldStart;
  assert.ok(snapshot);
  assert.equal(scans, 1);

  const instrumentation = metrics();
  const cache = createFooterRenderCache(instrumentation);
  const input: FooterRenderInput = {
    width: 120,
    cwd: "/benchmark/repo",
    theme,
    presentation,
    session: snapshot,
    git: { branch: "main", worktreeDir: "/benchmark/repo", repoName: "repo", staged: 0, unstaged: 0, untracked: 0 },
    extensionStatuses: new Map(),
  };
  const first = cache.render(input);
  const renderStart = performance.now();
  for (let index = 0; index < RENDERS; index++) assert.strictEqual(cache.render(input), first);
  const renderMs = performance.now() - renderStart;

  assert.equal(scans, 1, "cache-hit renders must not scan session entries");
  assert.equal(instrumentation.layoutPasses, 1);
  assert.equal(instrumentation.finalRowAllocations, 1);
  console.log(`${size.toLocaleString()}\t${coldMs.toFixed(3)}\t\t${renderMs.toFixed(3)}\t\t${scans}\t\t${instrumentation.layoutPasses}\t${instrumentation.finalRowAllocations}`);
}
