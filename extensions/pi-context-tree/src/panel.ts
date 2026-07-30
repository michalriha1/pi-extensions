/**
 * Pure panel text builder. Returns plain (unstyled) lines; the TUI layer is
 * responsible for coloring/truncating them to the terminal width. Keeping
 * this pure and string-based makes it easy to unit test without a terminal.
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { estimateContentTokens, estimateToolCallTokens, type ContentLike } from "./token-estimate.ts";
import type { ContextBreakdown, RowInfo } from "./types.ts";

/** Separate estimated contributions for a selected tool interaction (a tool
 * result combined with its matching call), shown as its own compact block
 * in the panel rather than folded into the aggregate categories. */
export interface ToolInteractionEstimate {
  total: number;
  callArguments: number;
  response: number;
}

export interface PanelLabel {
  entryKind: string;
  detail: string;
  toolInteraction?: ToolInteractionEstimate;
}

/** Looks up entries by id without retaining anything beyond the reference
 * the session already owns (mirrors `sessionManager.getEntry`). */
export type EntryLookup = (id: string) => SessionEntry | undefined;

function preview(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function contentPreview(content: unknown): string {
  if (typeof content === "string") return preview(content);
  if (Array.isArray(content)) {
    const text = content
      .filter((b): b is { type: string; text: string } => !!b && typeof b === "object" && b.type === "text")
      .map((b) => b.text)
      .join(" ");
    return preview(text);
  }
  return "";
}

function findToolCallInMessage(
  message: { role: string; content?: unknown },
  toolCallId: string,
): { name: string; arguments: Record<string, unknown> } | undefined {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
  for (const block of message.content as Array<Record<string, unknown>>) {
    if (block && block.type === "toolCall" && block.id === toolCallId) {
      return { name: String(block.name ?? "tool"), arguments: (block.arguments as Record<string, unknown>) ?? {} };
    }
  }
  return undefined;
}

/** Find the tool-call block matching a tool-result's `toolCallId`, walking
 * ancestors via `getEntry`. Parallel tool calls produce a chain of sibling
 * tool-result entries between the assistant call and the next assistant
 * message, so a later result's *direct* parent is another tool result, not
 * the assistant message that issued the call -- walk up through that chain
 * until the assistant message is found (or the chain is broken by a
 * non-tool-result message, meaning no match exists). Used to combine call
 * args + response for the "tool interaction" inspection view. */
function findMatchingToolCall(
  toolCallId: string | undefined,
  startParentId: string | null,
  getEntry: EntryLookup,
): { name: string; arguments: Record<string, unknown> } | undefined {
  if (!toolCallId) return undefined;
  let currentId = startParentId;
  while (currentId) {
    const current = getEntry(currentId);
    if (!current) return undefined;
    if (current.type === "message") {
      const message = current.message as unknown as { role: string; content?: unknown };
      if (message.role === "assistant") return findToolCallInMessage(message, toolCallId);
      if (message.role !== "toolResult") return undefined; // crossed a turn boundary; no match
    }
    // Non-message bookkeeping entries (label, model_change, etc.) and
    // parallel tool-result siblings are transparent: keep walking up.
    currentId = current.parentId;
  }
  return undefined;
}

/** Describe the currently-selected tree entry for the panel title, combining
 * a tool result with its matching call arguments when applicable. `getEntry`
 * is used to walk ancestors (through parallel tool-result siblings) to find
 * the assistant message that issued the matching call; it only returns
 * references the session already owns, nothing is copied or retained. */
export function describeEntry(entry: SessionEntry, getEntry: EntryLookup): PanelLabel {
  switch (entry.type) {
    case "message": {
      const message = entry.message as unknown as { role: string } & Record<string, unknown>;
      switch (message.role) {
        case "user":
          return { entryKind: "user message", detail: contentPreview(message.content) };
        case "assistant":
          return { entryKind: "assistant message", detail: contentPreview(message.content) };
        case "toolResult": {
          const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
          const call = findMatchingToolCall(toolCallId, entry.parentId, getEntry);
          const isError = message.isError ? " [error]" : "";
          const argsPreview = call ? preview(JSON.stringify(call.arguments), 40) : undefined;
          const name = call?.name ?? (typeof message.toolName === "string" ? message.toolName : "tool");
          const responseTokens = estimateContentTokens(message.content as ContentLike);
          const callArgumentTokens = call ? estimateToolCallTokens(call.name, call.arguments) : 0;
          return {
            entryKind: "tool result",
            detail: `${name}(${argsPreview ?? ""}) -> ${contentPreview(message.content)}${isError}`,
            toolInteraction: { total: callArgumentTokens + responseTokens, callArguments: callArgumentTokens, response: responseTokens },
          };
        }
        case "bashExecution":
          return { entryKind: "bash execution", detail: preview(String(message.command ?? "")) };
        default:
          return { entryKind: `${message.role} message`, detail: "" };
      }
    }
    case "compaction":
      return { entryKind: "compaction", detail: `${entry.tokensBefore.toLocaleString("en-US")} tokens before` };
    case "branch_summary":
      return { entryKind: "branch summary", detail: `from ${entry.fromId}` };
    case "custom_message":
      return { entryKind: `custom message (${entry.customType})`, detail: contentPreview(entry.content) };
    case "model_change":
      return { entryKind: "model change", detail: `${entry.provider}/${entry.modelId}` };
    case "thinking_level_change":
      return { entryKind: "thinking level change", detail: entry.thinkingLevel };
    case "label":
      return { entryKind: "label", detail: entry.label ?? "(cleared)" };
    case "session_info":
      return { entryKind: "session info", detail: entry.name ?? "" };
    case "custom":
      return { entryKind: `custom (${entry.customType})`, detail: "" };
    default:
      return { entryKind: String((entry as { type?: string }).type ?? "unknown"), detail: "" };
  }
}

const BAR_WIDTH = 24;

function formatTokens(value: number, exact: boolean): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(Math.round(value));
  const formatted = abs.toLocaleString("en-US");
  return `${exact ? "" : "~"}${sign}${formatted}`;
}

function formatPercent(part: number, whole: number): string {
  if (whole <= 0) return "n/a";
  return `${Math.round((part / whole) * 100)}%`;
}

function bar(part: number, whole: number, width = BAR_WIDTH): string {
  if (whole <= 0) return "░".repeat(width);
  const filled = Math.max(0, Math.min(width, Math.round((part / whole) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** Build panel lines for "no selection" / "no data yet" states. */
export function renderEmptyPanel(reason: string): string[] {
  return ["Context Tree Inspector", reason];
}

/** Build the panel lines for a selected row, given its RowInfo and full breakdown. */
export function renderPanel(label: PanelLabel, row: RowInfo, breakdown: ContextBreakdown): string[] {
  const lines: string[] = [];
  lines.push(`Context Tree Inspector — ${label.entryKind}${label.detail ? `: ${label.detail}` : ""}`);

  const totalStr = formatTokens(breakdown.total, breakdown.totalExact);
  const windowStr = breakdown.contextWindow > 0 ? breakdown.contextWindow.toLocaleString("en-US") : "unknown";
  lines.push(
    `Total: ${totalStr} / ${windowStr} (${formatPercent(breakdown.total, breakdown.contextWindow)})  ` +
      `${bar(breakdown.total, breakdown.contextWindow)}`,
  );

  const deltaStr = formatTokens(row.delta, row.deltaExact);
  lines.push(`Row delta: ${deltaStr}  (cumulative ${formatTokens(row.cumulative, row.exact)})`);

  if (label.toolInteraction) {
    const { total, callArguments, response } = label.toolInteraction;
    lines.push("");
    // Separate, explicit estimated contributions for this one tool
    // interaction (call + response), distinct from the aggregate
    // categories below -- these are never exact (chars/4 heuristics).
    lines.push(`Selected interaction ${formatTokens(total, false)}`);
    lines.push(`  call arguments ${formatTokens(callArguments, false)}`);
    lines.push(`  response ${formatTokens(response, false)}`);
  }

  lines.push("");
  // Category token counts are always chars/4 heuristics -- never exact --
  // even when the row's overall total is API-exact.
  lines.push(categoryLine("System prompt", breakdown.systemPrompt, breakdown.total, false));
  lines.push(categoryLine("Tool schemas", breakdown.toolSchemas, breakdown.total, false));
  lines.push(categoryLine("Tool calls", breakdown.toolCalls, breakdown.total, false));
  lines.push(categoryLine("Tool responses", breakdown.toolResponses, breakdown.total, false));
  lines.push(categoryLine("Messages", breakdown.messages, breakdown.total, false));
  if (breakdown.totalExact) {
    // The gap itself is a deterministic reconciliation of an exact total
    // against estimated categories, so it is reported without "~".
    lines.push(categoryLine("Provider/estimate gap", breakdown.gap, breakdown.total, true));
  }
  lines.push(
    `Available: ${formatTokens(breakdown.available, breakdown.totalExact)}${breakdown.contextWindow > 0 ? "" : " (context window unknown)"}`,
  );

  return lines;
}

function categoryLine(label: string, value: number, total: number, exact: boolean): string {
  const padded = label.padEnd(18, " ");
  return `${padded} ${formatTokens(value, exact).padStart(9, " ")}  ${formatPercent(value, total).padStart(4, " ")}`;
}
