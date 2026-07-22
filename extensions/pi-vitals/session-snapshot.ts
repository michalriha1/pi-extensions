import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ContextUsage,
} from "@earendil-works/pi-coding-agent";
import type { UsageStats } from "./types.js";

export type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

export interface SessionSnapshot {
  readonly usageStats: UsageStats;
  readonly contextTokens: number | null;
  readonly contextPercent: number | null;
  readonly contextWindow: number;
  readonly thinkingLevel: ThinkingLevel;
  readonly model: Model<Api> | undefined;
  readonly sessionId: string;
  readonly usingSubscription: boolean;
  readonly autoCompactEnabled: boolean;
  readonly sessionStartTime: number;
}

export interface SessionSnapshotController {
  getSnapshot(): SessionSnapshot | null;
  start(ctx: ExtensionContext): void;
  completeAssistant(message: AssistantMessage, ctx: ExtensionContext): void;
  rebuild(ctx: ExtensionContext): void;
  selectModel(model: Model<Api>, ctx: ExtensionContext): void;
  selectThinkingLevel(level: ThinkingLevel, ctx: ExtensionContext): void;
  dispose(): void;
}

interface InternalCompactionSettingsContext {
  settingsManager?: {
    getCompactionSettings?(): { enabled: boolean };
  };
}

const EMPTY_USAGE: UsageStats = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
};

function isCountedAssistant(message: AssistantMessage): boolean {
  return message.stopReason !== "error" && message.stopReason !== "aborted";
}

function addAssistantUsage(usage: UsageStats, message: AssistantMessage): UsageStats {
  if (!isCountedAssistant(message)) return usage;
  return {
    input: usage.input + message.usage.input,
    output: usage.output + message.usage.output,
    cacheRead: usage.cacheRead + message.usage.cacheRead,
    cacheWrite: usage.cacheWrite + message.usage.cacheWrite,
    cost: usage.cost + message.usage.cost.total,
  };
}

function aggregateBranchUsage(ctx: ExtensionContext): UsageStats {
  let usage = EMPTY_USAGE;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      usage = addAssistantUsage(usage, entry.message);
    }
  }
  return usage;
}

/** Pi does not expose compaction settings on ExtensionContext in 0.73.1. */
function getAutoCompactEnabled(ctx: ExtensionContext): boolean {
  const internal = ctx as ExtensionContext & InternalCompactionSettingsContext;
  return internal.settingsManager?.getCompactionSettings?.().enabled ?? true;
}

function getSessionStartTime(ctx: ExtensionContext, now: () => number): number {
  const timestamp = ctx.sessionManager.getHeader()?.timestamp;
  if (!timestamp) return now();
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? now() : parsed;
}

function getContextState(
  ctx: ExtensionContext,
  model: Model<Api> | undefined,
  completedAssistant?: AssistantMessage,
): ContextUsage {
  const usage = ctx.getContextUsage() ?? {
    tokens: null,
    percent: null,
    contextWindow: model?.contextWindow ?? 0,
  };
  if (usage.tokens !== null || !completedAssistant || !isCountedAssistant(completedAssistant)) {
    return usage;
  }

  // message_end is emitted just before SessionManager persists the assistant. Public context
  // usage therefore remains unknown immediately after compaction until that handler returns.
  const tokens = completedAssistant.usage.totalTokens
    || completedAssistant.usage.input
      + completedAssistant.usage.output
      + completedAssistant.usage.cacheRead
      + completedAssistant.usage.cacheWrite;
  return tokens > 0 && usage.contextWindow > 0
    ? { tokens, contextWindow: usage.contextWindow, percent: (tokens / usage.contextWindow) * 100 }
    : usage;
}

function snapshotsEqual(left: SessionSnapshot, right: SessionSnapshot): boolean {
  return left.model === right.model
    && left.thinkingLevel === right.thinkingLevel
    && left.sessionId === right.sessionId
    && left.usingSubscription === right.usingSubscription
    && left.autoCompactEnabled === right.autoCompactEnabled
    && left.sessionStartTime === right.sessionStartTime
    && left.contextTokens === right.contextTokens
    && left.contextPercent === right.contextPercent
    && left.contextWindow === right.contextWindow
    && left.usageStats.input === right.usageStats.input
    && left.usageStats.output === right.usageStats.output
    && left.usageStats.cacheRead === right.usageStats.cacheRead
    && left.usageStats.cacheWrite === right.usageStats.cacheWrite
    && left.usageStats.cost === right.usageStats.cost;
}

export function createSessionSnapshotController(
  pi: Pick<ExtensionAPI, "getThinkingLevel">,
  onVisibleChange: () => void,
  now: () => number = Date.now,
): SessionSnapshotController {
  let snapshot: SessionSnapshot | null = null;
  let disposed = false;

  const replace = (next: SessionSnapshot): void => {
    if (disposed) return;
    const changed = snapshot !== null && !snapshotsEqual(snapshot, next);
    snapshot = next;
    if (changed) onVisibleChange();
  };

  const build = (
    ctx: ExtensionContext,
    usageStats: UsageStats,
    model: Model<Api> | undefined,
    thinkingLevel: ThinkingLevel,
    sessionStartTime: number,
    completedAssistant?: AssistantMessage,
  ): SessionSnapshot => {
    const context = getContextState(ctx, model, completedAssistant);
    return {
      usageStats,
      contextTokens: context.tokens,
      contextPercent: context.percent,
      contextWindow: context.contextWindow,
      thinkingLevel,
      model,
      sessionId: ctx.sessionManager.getSessionId(),
      usingSubscription: model ? ctx.modelRegistry.isUsingOAuth(model) : false,
      autoCompactEnabled: getAutoCompactEnabled(ctx),
      sessionStartTime,
    };
  };

  const rebuild = (ctx: ExtensionContext): void => {
    const sessionStartTime = snapshot?.sessionStartTime ?? getSessionStartTime(ctx, now);
    replace(build(ctx, aggregateBranchUsage(ctx), ctx.model, pi.getThinkingLevel(), sessionStartTime));
  };

  return {
    getSnapshot: () => snapshot,
    start(ctx) {
      snapshot = null;
      disposed = false;
      replace(build(
        ctx,
        aggregateBranchUsage(ctx),
        ctx.model,
        pi.getThinkingLevel(),
        getSessionStartTime(ctx, now),
      ));
    },
    completeAssistant(message, ctx) {
      if (!snapshot || disposed) return;
      replace(build(
        ctx,
        addAssistantUsage(snapshot.usageStats, message),
        ctx.model,
        pi.getThinkingLevel(),
        snapshot.sessionStartTime,
        message,
      ));
    },
    rebuild,
    selectModel(model, ctx) {
      if (!snapshot || disposed) return;
      replace(build(ctx, snapshot.usageStats, model, pi.getThinkingLevel(), snapshot.sessionStartTime));
    },
    selectThinkingLevel(level, ctx) {
      if (!snapshot || disposed) return;
      replace(build(ctx, snapshot.usageStats, ctx.model, level, snapshot.sessionStartTime));
    },
    dispose() {
      disposed = true;
      snapshot = null;
    },
  };
}
