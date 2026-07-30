/**
 * Shared, framework-independent types for the context tracker and panel.
 *
 * Nothing here imports TUI or extension-runtime code, so this module can be
 * unit tested without a live Pi session.
 */

/** Token counts captured live from a "context" extension event, before the
 * next provider request. Only numbers are retained -- never message content. */
export interface RequestSnapshot {
  /** Session leaf entry id at capture time (the entry the upcoming request is "about"). */
  leafEntryId: string | null;
  systemPromptTokens: number;
  toolSchemaTokens: number;
  messagesTokens: number;
  toolCallTokens: number;
  toolResponseTokens: number;
  contextWindow: number;
  modelKey: string | undefined;
  timestamp: number;
}

/** A fully-resolved category breakdown anchored to a specific entry, either
 * because it was directly observed (RequestSnapshot) or composed from one. */
export interface CategoryAnchor {
  systemPrompt: number;
  toolSchemas: number;
  toolCalls: number;
  toolResponses: number;
  messages: number;
  contextWindow: number;
  modelKey: string | undefined;
  /** Exact total tokens for this anchor point, from API usage. */
  exactTotal: number;
}

/** Per-entry token category deltas (this entry's own contribution only). */
export interface CategoryDelta {
  messages: number;
  toolCalls: number;
  toolResponses: number;
}

/** Dynamic-programming record maintained per session entry. */
export interface DPRecord {
  entryId: string;
  parentId: string | null;
  cumulative: number;
  exact: boolean;
  delta: number;
  deltaExact: boolean;
  contextWindow: number;
  modelKey: string | undefined;
  categoryDelta: CategoryDelta;
  anchor?: CategoryAnchor;
}

/** Cumulative-context info for a single tree row, as shown in the panel. */
export interface RowInfo {
  entryId: string;
  cumulative: number;
  exact: boolean;
  delta: number;
  deltaExact: boolean;
  contextWindow: number;
}

/** Full category breakdown for the panel, resolved for a specific row. */
export interface ContextBreakdown {
  total: number;
  totalExact: boolean;
  systemPrompt: number;
  toolSchemas: number;
  toolCalls: number;
  toolResponses: number;
  messages: number;
  /** Reconciliation term: exact total minus the sum of estimated categories. */
  gap: number;
  available: number;
  contextWindow: number;
}

/** Resolves a model's context window size from provider + model id. Injected
 * so the tracker stays decoupled from Pi's live model registry. */
export type ContextWindowResolver = (provider: string, modelId: string) => number | undefined;
