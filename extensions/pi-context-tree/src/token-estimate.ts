/**
 * Pure token-estimation helpers. Everything here uses the same chars/4
 * heuristic Pi itself uses in `estimateTokens` (see
 * `@earendil-works/pi-coding-agent`'s compaction module), but splits the
 * result into categories (messages / tool calls / tool responses) so the
 * panel can show a breakdown instead of a single number.
 *
 * These estimates are never authoritative -- only API-reported `usage` is.
 */
import { sessionEntryToContextMessages, type SessionEntry, type ToolInfo } from "@earendil-works/pi-coding-agent";

export interface MessageCategoryTokens {
  messages: number;
  toolCalls: number;
  toolResponses: number;
}

const EMPTY_CATEGORY: MessageCategoryTokens = { messages: 0, toolCalls: 0, toolResponses: 0 };

/** Generic content shape shared by user/assistant/toolResult/custom messages. */
export type ContentLike = string | ReadonlyArray<Record<string, unknown>> | undefined | null;

/** Loosely-typed message shape: enough to categorize without importing pi-ai types. */
export type CategorizableMessage = { role: string } & Record<string, unknown>;

export function estimateCharsToTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

export function contentChars(content: ContentLike): number {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    let chars = 0;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string") chars += block.text.length;
      // Images aren't tokenized via chars/4; use the same rough constant Pi's
      // own estimator uses internally for image content.
      else if (block.type === "image") chars += 4800;
    }
    return chars;
  }
  return 0;
}

function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value ?? {}).length;
  } catch {
    return 0;
  }
}

/** Categorize a single loosely-typed AgentMessage into token buckets. */
export function categorizeMessage(message: CategorizableMessage): MessageCategoryTokens {
  switch (message.role) {
    case "user": {
      return { ...EMPTY_CATEGORY, messages: estimateCharsToTokens(contentChars(message.content as ContentLike)) };
    }
    case "assistant": {
      const content = message.content;
      let textChars = 0;
      let toolChars = 0;
      if (Array.isArray(content)) {
        for (const block of content as Array<Record<string, unknown>>) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "text" && typeof block.text === "string") textChars += block.text.length;
          else if (block.type === "thinking" && typeof block.thinking === "string") textChars += block.thinking.length;
          else if (block.type === "toolCall") {
            const name = typeof block.name === "string" ? block.name : "";
            toolChars += name.length + jsonLength(block.arguments);
          }
        }
      }
      return {
        messages: estimateCharsToTokens(textChars),
        toolCalls: estimateCharsToTokens(toolChars),
        toolResponses: 0,
      };
    }
    case "toolResult": {
      return { ...EMPTY_CATEGORY, toolResponses: estimateCharsToTokens(contentChars(message.content as ContentLike)) };
    }
    case "bashExecution": {
      const command = typeof message.command === "string" ? message.command : "";
      const output = typeof message.output === "string" ? message.output : "";
      return { ...EMPTY_CATEGORY, messages: estimateCharsToTokens(command.length + output.length) };
    }
    case "branchSummary":
    case "compactionSummary": {
      const summary = typeof message.summary === "string" ? message.summary : "";
      return { ...EMPTY_CATEGORY, messages: estimateCharsToTokens(summary.length) };
    }
    case "custom": {
      return { ...EMPTY_CATEGORY, messages: estimateCharsToTokens(contentChars(message.content as ContentLike)) };
    }
    default:
      return EMPTY_CATEGORY;
  }
}

export function sumCategories(a: MessageCategoryTokens, b: MessageCategoryTokens): MessageCategoryTokens {
  return {
    messages: a.messages + b.messages,
    toolCalls: a.toolCalls + b.toolCalls,
    toolResponses: a.toolResponses + b.toolResponses,
  };
}

/** Categorize a full message list, e.g. the "context" event's `event.messages`. */
export function categorizeMessages(messages: readonly CategorizableMessage[]): MessageCategoryTokens {
  let total = EMPTY_CATEGORY;
  for (const message of messages) total = sumCategories(total, categorizeMessage(message));
  return total;
}

/** Categorize one session entry (message, or synthetic compaction/branch-summary/custom_message
 * entry) into token buckets, via Pi's own entry -> context-message projection. */
export function categorizeEntry(entry: SessionEntry): MessageCategoryTokens & { total: number } {
  const messages = sessionEntryToContextMessages(entry) as unknown as CategorizableMessage[];
  const cats = categorizeMessages(messages);
  return { ...cats, total: cats.messages + cats.toolCalls + cats.toolResponses };
}

/** Estimate tokens used by a set of tool schemas (name + description + parameters + guidelines). */
export function estimateToolSchemaTokens(tools: readonly Pick<ToolInfo, "name" | "description" | "parameters" | "promptGuidelines">[]): number {
  let chars = 0;
  for (const tool of tools) {
    chars += tool.name.length;
    chars += tool.description?.length ?? 0;
    chars += jsonLength(tool.parameters);
    if (tool.promptGuidelines) chars += tool.promptGuidelines.join("").length;
  }
  return estimateCharsToTokens(chars);
}

export function estimateSystemPromptTokens(systemPrompt: string): number {
  return estimateCharsToTokens(systemPrompt.length);
}

/** Estimate tokens for a single tool call's own contribution (name + JSON
 * arguments), independent of any sibling text/toolCall blocks on the same
 * assistant message. Used to show a selected tool interaction's separate
 * call-argument contribution in the panel. */
export function estimateToolCallTokens(name: string, args: unknown): number {
  return estimateCharsToTokens(name.length + jsonLength(args));
}

/** Estimate tokens for arbitrary message content (text/image blocks or a
 * plain string). Used to show a selected tool result's own response
 * contribution in the panel. */
export function estimateContentTokens(content: ContentLike): number {
  return estimateCharsToTokens(contentChars(content));
}
