/**
 * pi-context-tree: inspect cumulative context-window usage across the
 * session tree, reusing Pi's built-in `TreeSelectorComponent` for
 * navigation/search/folding/filtering and rendering a compact accounting
 * panel above it. TUI inspection-only: no session mutation, no navigation.
 */
import {
  TreeSelectorComponent,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
  type SessionTreeNode,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { ContextTracker } from "./context-tracker.ts";
import { describeEntry, renderEmptyPanel, renderPanel } from "./panel.ts";
import { categorizeMessages, estimateSystemPromptTokens, estimateToolSchemaTokens, type CategorizableMessage } from "./token-estimate.ts";
import type { ContextWindowResolver, RequestSnapshot } from "./types.ts";

/** Worst-case panel height (exact tool interaction) and fixed chrome
 * rendered around TreeSelectorComponent's visible entry list. */
const MAX_PANEL_LINES = 15;
const TREE_CHROME_LINES = 10;
const MIN_TREE_ENTRY_LINES = 5;

export default function piContextTreeExtension(pi: ExtensionAPI): void {
  let tracker: ContextTracker | undefined;
  let modelRegistry: ExtensionContext["modelRegistry"] | undefined;

  const resolveContextWindow: ContextWindowResolver = (provider, modelId) => {
    try {
      return modelRegistry?.find(provider, modelId)?.contextWindow;
    } catch {
      return undefined;
    }
  };

  const ensureTracker = (): ContextTracker => {
    if (!tracker) tracker = new ContextTracker(resolveContextWindow);
    return tracker;
  };

  pi.on("session_start", (_event, ctx) => {
    modelRegistry = ctx.modelRegistry;
    // A fresh tracker per session: entries, branches, and model/context
    // history all reset when the underlying session changes.
    tracker = new ContextTracker(resolveContextWindow);
  });

  // Capture live, per-request token accounting. Only numeric aggregates are
  // kept -- `event.messages` itself is never retained beyond this handler.
  pi.on("context", (event, ctx) => {
    modelRegistry = ctx.modelRegistry;
    const activeTracker = ensureTracker();
    const categorized = categorizeMessages(event.messages as unknown as CategorizableMessage[]);
    const activeToolNames = new Set(pi.getActiveTools());
    const activeToolDefs = pi.getAllTools().filter((tool) => activeToolNames.has(tool.name));
    const snapshot: RequestSnapshot = {
      leafEntryId: ctx.sessionManager.getLeafId(),
      systemPromptTokens: estimateSystemPromptTokens(ctx.getSystemPrompt()),
      toolSchemaTokens: estimateToolSchemaTokens(activeToolDefs),
      messagesTokens: categorized.messages,
      toolCallTokens: categorized.toolCalls,
      toolResponseTokens: categorized.toolResponses,
      contextWindow: ctx.model?.contextWindow ?? 0,
      modelKey: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
      timestamp: Date.now(),
    };
    activeTracker.recordSnapshot(snapshot);
  });

  pi.registerCommand("context-tree", {
    description: "Inspect cumulative context-window usage across the session tree",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("The context tree inspector requires the interactive TUI.", "info");
        return;
      }
      const tree = ctx.sessionManager.getTree();
      if (tree.length === 0) {
        ctx.ui.notify("No entries in this session yet.", "info");
        return;
      }

      const activeTracker = ensureTracker();
      const leafId = ctx.sessionManager.getLeafId();

      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        return new ContextTreeInspectorComponent({
          tui,
          theme,
          tree,
          leafId,
          tracker: activeTracker,
          getEntries: () => ctx.sessionManager.getEntries(),
          getEntry: (id: string) => ctx.sessionManager.getEntry(id),
          onClose: () => done(undefined),
        });
      });
    },
  });
}

export interface ContextTreeInspectorOptions {
  tui: TUI;
  theme: Theme;
  tree: SessionTreeNode[];
  leafId: string | null;
  tracker: ContextTracker;
  getEntries: () => readonly SessionEntry[];
  getEntry: (id: string) => SessionEntry | undefined;
  onClose: () => void;
}

/** Combines the accounting panel (always above) with a reused, unmodified
 * `TreeSelectorComponent` (always below). Inspection-only: `onSelect` is a
 * no-op so Enter never branches/navigates the real session, and label
 * edits made in the ephemeral tree view are never persisted. */
export class ContextTreeInspectorComponent implements Component, Focusable {
  private readonly tree: TreeSelectorComponent;
  private readonly theme: Theme;
  private readonly tracker: ContextTracker;
  private readonly getEntries: () => readonly SessionEntry[];
  private readonly getEntry: (id: string) => SessionEntry | undefined;
  private readonly terminalRows: number;
  private _focused = false;

  constructor(opts: ContextTreeInspectorOptions) {
    this.theme = opts.theme;
    this.tracker = opts.tracker;
    this.getEntries = opts.getEntries;
    this.getEntry = opts.getEntry;
    this.terminalRows = opts.tui.terminal.rows;

    // TreeSelectorComponent derives its entry-list height as half the
    // terminalHeight argument, then adds ten lines of borders, title, help,
    // search, and spacing. Budget both that chrome and the largest panel so
    // terminal clipping cannot hide the panel at the top.
    const treeEntryLines = Math.max(
      MIN_TREE_ENTRY_LINES,
      this.terminalRows - MAX_PANEL_LINES - TREE_CHROME_LINES,
    );
    this.tree = new TreeSelectorComponent(
      opts.tree,
      opts.leafId,
      treeEntryLines * 2,
      () => {
        /* inspection only: never branch/navigate the real session */
      },
      opts.onClose,
      undefined, // no label persistence: never mutate the real session
      opts.leafId ?? undefined,
      "default", // always start unfiltered enough to show tool-result rows
    );
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.tree.focused = value;
  }

  invalidate(): void {
    this.tree.invalidate();
  }

  handleInput(data: string): void {
    this.tree.handleInput(data);
  }

  render(width: number): string[] {
    this.tracker.sync(this.getEntries());
    const panelLines = this.buildPanelLines();
    const styledPanel = panelLines.map((line, i) =>
      truncateToWidth(i === 0 ? this.theme.bold(this.theme.fg("accent", line)) : this.theme.fg("text", line), width),
    );
    const remainingRows = Math.max(0, this.terminalRows - styledPanel.length);
    return [...styledPanel, ...this.tree.render(width).slice(0, remainingRows)].slice(0, this.terminalRows);
  }

  private buildPanelLines(): string[] {
    const node = this.tree.getTreeList().getSelectedNode();
    if (!node) return renderEmptyPanel("No entry selected.");

    const entryId = node.entry.id;
    const row = this.tracker.getRowInfo(entryId);
    const breakdown = this.tracker.getBreakdown(entryId);
    if (!row || !breakdown) return renderEmptyPanel("No context data for this entry yet.");

    const label = describeEntry(node.entry, this.getEntry);
    return renderPanel(label, row, breakdown);
  }
}
