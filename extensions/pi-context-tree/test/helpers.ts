import type { SessionEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";

let counter = 0;

export function resetIds(): void {
  counter = 0;
}

export function nextId(): string {
  counter += 1;
  return `e${counter}`;
}

export interface UsageInput {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

function usage(u: UsageInput) {
  return {
    input: u.input,
    output: u.output,
    cacheRead: u.cacheRead ?? 0,
    cacheWrite: u.cacheWrite ?? 0,
    totalTokens: u.totalTokens ?? 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function userEntry(parentId: string | null, text: string, id = nextId()): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: text, timestamp: Date.now() },
  } as unknown as SessionEntry;
}

export function assistantEntry(
  parentId: string | null,
  opts: {
    text?: string;
    usage?: UsageInput;
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    stopReason?: string;
    provider?: string;
    model?: string;
  },
  id = nextId(),
): SessionEntry {
  const content: Array<Record<string, unknown>> = [];
  if (opts.text) content.push({ type: "text", text: opts.text });
  for (const call of opts.toolCalls ?? []) content.push({ type: "toolCall", ...call });
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content,
      provider: opts.provider ?? "anthropic",
      model: opts.model ?? "claude-test",
      usage: opts.usage ? usage(opts.usage) : undefined,
      stopReason: opts.stopReason ?? "stop",
      timestamp: Date.now(),
    },
  } as unknown as SessionEntry;
}

export function toolResultEntry(
  parentId: string | null,
  opts: { toolCallId: string; toolName: string; content: string; isError?: boolean },
  id = nextId(),
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: {
      role: "toolResult",
      toolCallId: opts.toolCallId,
      toolName: opts.toolName,
      content: [{ type: "text", text: opts.content }],
      isError: opts.isError ?? false,
      timestamp: Date.now(),
    },
  } as unknown as SessionEntry;
}

export function compactionEntry(
  parentId: string | null,
  opts: { summary: string; firstKeptEntryId?: string; tokensBefore: number; retainedTail?: unknown[] },
  id = nextId(),
): SessionEntry {
  return {
    type: "compaction",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    summary: opts.summary,
    firstKeptEntryId: opts.firstKeptEntryId,
    tokensBefore: opts.tokensBefore,
    ...(opts.retainedTail ? { retainedTail: opts.retainedTail } : {}),
  } as unknown as SessionEntry;
}

export function branchSummaryEntry(
  parentId: string | null,
  opts: { summary: string; fromId: string },
  id = nextId(),
): SessionEntry {
  return {
    type: "branch_summary",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    summary: opts.summary,
    fromId: opts.fromId,
  } as unknown as SessionEntry;
}

export function modelChangeEntry(parentId: string | null, provider: string, modelId: string, id = nextId()): SessionEntry {
  return {
    type: "model_change",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    provider,
    modelId,
  } as unknown as SessionEntry;
}

export function labelEntry(parentId: string | null, targetId: string, label: string | undefined, id = nextId()): SessionEntry {
  return {
    type: "label",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    targetId,
    label,
  } as unknown as SessionEntry;
}

/** Build an entry lookup function from a flat entry list, mirroring
 * `sessionManager.getEntry(id)`. */
export function entryLookup(entries: readonly SessionEntry[]): (id: string) => SessionEntry | undefined {
  const byId = new Map(entries.map((e) => [e.id, e]));
  return (id: string) => byId.get(id);
}

/** Build a SessionTreeNode[] forest from a flat, append-ordered entry list
 * (mirrors what `sessionManager.getTree()` would return). */
export function buildTree(entries: readonly SessionEntry[]): SessionTreeNode[] {
  const nodesById = new Map<string, SessionTreeNode>();
  const roots: SessionTreeNode[] = [];
  for (const entry of entries) {
    const node: SessionTreeNode = { entry, children: [] };
    nodesById.set(entry.id, node);
    if (entry.parentId && nodesById.has(entry.parentId)) {
      nodesById.get(entry.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}
