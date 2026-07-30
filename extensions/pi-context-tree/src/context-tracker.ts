/**
 * ContextTracker: pure, framework-independent accounting engine.
 *
 * It maintains a per-entry dynamic-programming (DP) record over the
 * session's entries (as returned by `sessionManager.getEntries()`, which is
 * append-only and always lists a parent before its children). Each new
 * entry is processed exactly once (O(1) amortized), so repeated calls to
 * `sync()` as the session grows never redo work already done -- overall
 * cost across a whole session is O(n), not O(n^2).
 *
 * Two related but distinct numbers are produced:
 *
 * - RowInfo.cumulative: a cheap, always-available number for a tree row.
 *   It is exact (usage-derived) at points immediately before/after an
 *   observed assistant response, and a content-only estimate (messages +
 *   tool calls + tool responses; no system prompt / tool schema slice)
 *   everywhere else, since there is no public tokenizer to size those
 *   without a live request.
 *
 * - ContextBreakdown (from getBreakdown): a richer, panel-oriented view
 *   that additionally attributes system-prompt and tool-schema tokens
 *   using the nearest live "context" event snapshot on the path to the
 *   node (if any). When the row's total is exact, the difference between
 *   the exact total and the sum of estimated categories is reported as an
 *   explicit `gap` rather than scaling the categories to fit.
 *
 * Context semantics (see project brief):
 * - `usage.input + usage.cacheRead + usage.cacheWrite` is the exact
 *   context size *before* an assistant response -- attributed to that
 *   response's parent entry (the preceding user message or tool result).
 * - `calculateContextTokens(usage)` (input+output+cache) is the exact
 *   context size *after* the response is appended -- attributed to the
 *   assistant entry itself.
 * - Everything else (in particular, additional tool-result siblings from
 *   parallel tool calls) is estimated until the next assistant usage
 *   arrives.
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { categorizeEntry, categorizeMessages, type CategorizableMessage } from "./token-estimate.ts";
import type { CategoryAnchor, CategoryDelta, ContextBreakdown, ContextWindowResolver, DPRecord, RequestSnapshot, RowInfo } from "./types.ts";

interface UsageLike {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

/** Maximum number of unmatched request snapshots to retain. Bounds memory
 * if requests fail before producing an assistant message (retries, aborts). */
const MAX_PENDING_SNAPSHOTS = 20;

/** Mirrors `calculateContextTokens()` from `@earendil-works/pi-coding-agent`
 * (native `totalTokens` when present, else input+output+cache). Reimplemented
 * locally against a loose `UsageLike` shape so we don't need the package's
 * internal `Usage` type (not part of its public export surface). */
function calcContextTokens(usage: UsageLike): number {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function getValidAssistantUsage(message: Record<string, unknown>): UsageLike | undefined {
  if (message.stopReason === "aborted" || message.stopReason === "error") return undefined;
  const usage = message.usage as UsageLike | undefined;
  if (!usage) return undefined;
  return calcContextTokens(usage) > 0 ? usage : undefined;
}

export class ContextTracker {
  private readonly dpRecords = new Map<string, DPRecord>();
  private processedCount = 0;
  private pendingSnapshots: RequestSnapshot[] = [];
  private readonly resolveContextWindow: ContextWindowResolver;

  constructor(resolveContextWindow: ContextWindowResolver) {
    this.resolveContextWindow = resolveContextWindow;
  }

  /** Record a live snapshot captured from a "context" extension event.
   * Only numeric aggregates are kept -- never message content. */
  recordSnapshot(snapshot: RequestSnapshot): void {
    this.pendingSnapshots.push(snapshot);
    while (this.pendingSnapshots.length > MAX_PENDING_SNAPSHOTS) this.pendingSnapshots.shift();
  }

  /** Process any entries appended since the last call. Safe to call on
   * every render; already-processed entries are skipped in O(1). */
  sync(entries: readonly SessionEntry[]): void {
    for (let i = this.processedCount; i < entries.length; i++) {
      this.processEntry(entries[i] as SessionEntry);
    }
    this.processedCount = entries.length;
  }

  /** Cheap, always-available cumulative/delta info for one entry. */
  getRowInfo(entryId: string): RowInfo | undefined {
    const record = this.dpRecords.get(entryId);
    if (!record) return undefined;
    return {
      entryId: record.entryId,
      cumulative: record.cumulative,
      exact: record.exact,
      delta: record.delta,
      deltaExact: record.deltaExact,
      contextWindow: record.contextWindow,
    };
  }

  /** Full category breakdown for the panel. Falls back gracefully when no
   * live snapshot was ever observed on the path to this entry. */
  getBreakdown(entryId: string): ContextBreakdown | undefined {
    const record = this.dpRecords.get(entryId);
    if (!record) return undefined;

    const chain: DPRecord[] = [];
    let current: DPRecord | undefined = record;
    while (current && !current.anchor) {
      chain.push(current);
      current = current.parentId ? this.dpRecords.get(current.parentId) : undefined;
    }
    const anchor = current?.anchor;

    let messages = anchor?.messages ?? 0;
    let toolCalls = anchor?.toolCalls ?? 0;
    let toolResponses = anchor?.toolResponses ?? 0;
    // chain holds nodes strictly after the anchor (or the whole root..record
    // path when no anchor exists); order doesn't matter for a plain sum.
    for (const node of chain) {
      messages += node.categoryDelta.messages;
      toolCalls += node.categoryDelta.toolCalls;
      toolResponses += node.categoryDelta.toolResponses;
    }
    const systemPrompt = anchor?.systemPrompt ?? 0;
    const toolSchemas = anchor?.toolSchemas ?? 0;
    const estimatedTotal = systemPrompt + toolSchemas + messages + toolCalls + toolResponses;

    const totalExact = record.exact;
    const total = totalExact ? record.cumulative : estimatedTotal;
    const gap = totalExact ? record.cumulative - estimatedTotal : 0;
    const contextWindow = record.contextWindow;
    const available = contextWindow > 0 ? contextWindow - total : 0;

    return { total, totalExact, systemPrompt, toolSchemas, toolCalls, toolResponses, messages, gap, available, contextWindow };
  }

  /** Tokens still counted as "kept" (not summarized away) by a compaction
   * entry: either the materialized `retainedTail`, or -- for older-format
   * compactions -- the token span from `firstKeptEntryId` through the
   * compaction's parent, derived via DP-cumulative subtraction. */
  private keptTokensForCompaction(
    entry: Extract<SessionEntry, { type: "compaction" }>,
    parentCumulative: number,
  ): number {
    // `retainedTail` (materialized post-compaction context) isn't part of
    // the public `CompactionEntry` type as of pi 0.83.0, but newer
    // harness-generated compactions may still carry it on disk. Feature-detect
    // defensively instead of depending on an undeclared field.
    const retainedTail = (entry as unknown as { retainedTail?: unknown }).retainedTail;
    if (Array.isArray(retainedTail) && retainedTail.length > 0) {
      const cats = categorizeMessages(retainedTail as unknown as CategorizableMessage[]);
      return cats.messages + cats.toolCalls + cats.toolResponses;
    }
    if (entry.firstKeptEntryId) {
      const firstKept = this.dpRecords.get(entry.firstKeptEntryId);
      const beforeFirstKept = firstKept?.parentId ? this.dpRecords.get(firstKept.parentId) : undefined;
      const baseline = beforeFirstKept?.cumulative ?? 0;
      return Math.max(0, parentCumulative - baseline);
    }
    return 0;
  }

  private matchSnapshot(leafEntryId: string): RequestSnapshot | undefined {
    const index = this.pendingSnapshots.findIndex((s) => s.leafEntryId === leafEntryId);
    if (index === -1) return undefined;
    const [snapshot] = this.pendingSnapshots.splice(index, 1);
    return snapshot;
  }

  private processEntry(entry: SessionEntry): void {
    const parentId: string | null = entry.parentId;
    const parent = parentId ? this.dpRecords.get(parentId) : undefined;
    const parentCumulative = parent?.cumulative ?? 0;
    const parentExact = parent?.exact ?? true;
    let contextWindow = parent?.contextWindow ?? 0;
    let modelKey = parent?.modelKey;

    const cats = categorizeEntry(entry);
    const categoryDelta: CategoryDelta = { messages: cats.messages, toolCalls: cats.toolCalls, toolResponses: cats.toolResponses };

    let cumulative = parentCumulative + cats.total;
    let exact = parentExact && cats.total === 0;
    let delta = cats.total;
    let deltaExact = exact;
    let ownAnchor: CategoryAnchor | undefined;

    if (entry.type === "model_change") {
      modelKey = `${entry.provider}/${entry.modelId}`;
      const resolved = this.resolveContextWindow(entry.provider, entry.modelId);
      if (resolved !== undefined) contextWindow = resolved;
    } else if (entry.type === "compaction") {
      // Compaction discards the summarized range from context: cumulative
      // drops to the summary itself plus whatever was kept. Negative deltas
      // relative to the parent are expected and correct here.
      const kept = this.keptTokensForCompaction(entry, parentCumulative);
      cumulative = cats.total + kept;
      exact = false;
      delta = cumulative - parentCumulative;
      deltaExact = false;
    } else if (entry.type === "message") {
      const message = entry.message as unknown as Record<string, unknown>;
      if (typeof message.provider === "string" && typeof message.model === "string") {
        modelKey = `${message.provider}/${message.model}`;
        const resolved = this.resolveContextWindow(message.provider, message.model);
        if (resolved !== undefined) contextWindow = resolved;
      }
      if (message.role === "assistant") {
        const usage = getValidAssistantUsage(message);
        if (usage) {
          const exactBefore = usage.input + usage.cacheRead + usage.cacheWrite;
          const exactAfter = calcContextTokens(usage);
          const snapshot = parentId ? this.matchSnapshot(parentId) : undefined;

          if (parent) {
            const grandparent = parent.parentId ? this.dpRecords.get(parent.parentId) : undefined;
            const grandparentCumulative = grandparent?.cumulative ?? 0;
            const grandparentExact = grandparent?.exact ?? true;
            parent.cumulative = exactBefore;
            parent.exact = true;
            parent.delta = exactBefore - grandparentCumulative;
            parent.deltaExact = grandparentExact;
            if (snapshot) {
              parent.anchor = {
                systemPrompt: snapshot.systemPromptTokens,
                toolSchemas: snapshot.toolSchemaTokens,
                toolCalls: snapshot.toolCallTokens,
                toolResponses: snapshot.toolResponseTokens,
                messages: snapshot.messagesTokens,
                contextWindow: snapshot.contextWindow,
                modelKey: snapshot.modelKey,
                exactTotal: exactBefore,
              };
              if (snapshot.contextWindow > 0) parent.contextWindow = snapshot.contextWindow;
              if (snapshot.modelKey) parent.modelKey = snapshot.modelKey;
            }
          }

          cumulative = exactAfter;
          exact = true;
          delta = exactAfter - (parent?.cumulative ?? 0);
          deltaExact = true;

          const parentAnchor = parent?.anchor;
          if (parentAnchor) {
            const composed: CategoryAnchor = {
              systemPrompt: parentAnchor.systemPrompt,
              toolSchemas: parentAnchor.toolSchemas,
              messages: parentAnchor.messages + categoryDelta.messages,
              toolCalls: parentAnchor.toolCalls + categoryDelta.toolCalls,
              toolResponses: parentAnchor.toolResponses + categoryDelta.toolResponses,
              contextWindow,
              modelKey,
              exactTotal: exactAfter,
            };
            ownAnchor = composed;
          }
        }
      }
    }

    this.dpRecords.set(entry.id, {
      entryId: entry.id,
      parentId,
      cumulative,
      exact,
      delta,
      deltaExact,
      contextWindow,
      modelKey,
      categoryDelta,
      anchor: ownAnchor,
    });
  }
}
