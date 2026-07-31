# pi-context-tree

Inspect cumulative context-window usage across the session tree. Registers
`/context-tree` (TUI only): reuses Pi's built-in `TreeSelectorComponent` for
navigation/search/folding/filtering, with a compact accounting panel always
rendered **above** the tree, driven by whichever row is currently
highlighted.

This is an **inspection-only** view:

- Enter never branches or navigates the real session (it's a no-op inside
  the ephemeral tree view).
- Label edits made while inspecting are never persisted.
- Escape closes the inspector and returns you to the editor.
- The initial tree filter is always `default` (so tool-result rows are
  visible), regardless of your `/tree` filter setting.
- Nothing is written to disk and nothing is retained beyond the running
  process's memory. No custom session entries, no sidecar files.

## Usage

```
/context-tree
```

Navigate with the same keys as `/tree` (arrows, page up/down, branch
fold/unfold, search, `Ctrl+O` / `Shift+Ctrl+O` to cycle filters, copy,
label). The panel above updates to show accounting for whichever row is
currently highlighted.

## What the panel shows

```
Context Tree Inspector — tool result: read({"path":"a.ts"}) -> file contents
Total: 12,345 / 200,000 (6%)  ████░░░░░░░░░░░░░░░░░░░░
Row delta: ~230  (cumulative ~12,345)

Selected interaction ~40
  call arguments ~20
  response ~20

System prompt      ~1,200    10%
Tool schemas         ~800     6%
Tool calls           ~150     1%
Tool responses      ~2,300   19%
Messages            ~7,895   64%
Provider/estimate gap  ~0     0%
Available: 187,655
```

- **Total**: the row's cumulative context size. Shown without `~` when it
  comes directly from an API-reported `usage` value; estimated otherwise.
- **Row delta**: this row's own contribution relative to its parent.
  Negative deltas are expected and correct right after a compaction entry
  (content was discarded from context). Unaffected by the tool-interaction
  breakout below -- it always reflects the plain per-row accounting.
- **Selected interaction** (tool-result rows only): a separate, explicit
  estimate for *this one* tool interaction (the matching call's arguments
  plus this result's response), broken into `call arguments` and
  `response`. Always estimated (`~`); shown in addition to, not instead of,
  the aggregate categories below. The matching call is found by walking
  ancestors past any parallel tool-result siblings until the assistant
  message that issued it is found.
- **Categories** (system prompt / tool schemas / tool calls / tool
  responses / messages): always estimated (`~`) chars/4 heuristics, since
  there is no public tokenizer. They come from the nearest live "context"
  event snapshot observed during *this* process's run, if any.
- **Provider/estimate gap**: the difference between the canonical row total
  and the sum of estimated categories. It is exact when the API total is
  exact and marked `~` otherwise. The gap is shown explicitly rather than
  scaling categories to force a match.
- **Available**: `contextWindow - total`. Shown as "context window unknown"
  when the model's context window hasn't been resolved yet.

## Context accounting semantics

Pi's `usage` on an assistant message is the authoritative source of truth.
This extension maps it onto the session tree as follows:

- `usage.input + usage.cacheRead + usage.cacheWrite` is the exact context
  size **before** that assistant response -- attributed to the response's
  *parent* entry (the preceding user message or tool result).
- `usage.input + usage.output + usage.cacheRead + usage.cacheWrite` (Pi's
  own `calculateContextTokens` formula) is the exact context size **after**
  the response is appended -- attributed to the assistant entry itself.
- Everything else -- in particular, sibling tool-result entries from
  parallel tool calls that aren't the *immediate* predecessor of the next
  assistant call -- is estimated (chars/4 heuristic) until the next
  assistant usage arrives. This is why, with several parallel tool results
  in a row, only the **last** one before the next model call becomes exact.
- A tool result is treated as one inspectable *interaction*: its matching
  call (found by walking ancestors through any parallel tool-result
  siblings back to the assistant message that issued it) plus its own
  response. The panel shows their estimated contributions separately
  (`call arguments` / `response`) so the two are never conflated, without
  changing the plain per-row cumulative/delta accounting above.
- Compaction entries intentionally produce **negative** deltas: the summary
  plus whatever was kept (`retainedTail`, or the span from
  `firstKeptEntryId` onward) replaces everything that was summarized away.
- Branch-summary entries need no special handling: their tree parent is
  already the common ancestor, so the abandoned branch's tokens are
  naturally excluded from their cumulative total.

Live category detail (system prompt / tool schema / message / tool-call /
tool-response split) is only available for provider requests **observed
during this process's run** -- captured cheaply on Pi's public `"context"`
event (`ctx.getSystemPrompt()` + `pi.getActiveTools()/getAllTools()` +
`event.messages`, converted immediately to token counts and discarded).
Older assistant turns (e.g. from a resumed session, or from before this
extension was loaded) still get an exact **total** from their persisted
`usage`, but no reliable category breakdown. Their known categories start
at 0 and the exact total is reported as `Provider/estimate gap`; later
estimated entries add only their own observable category deltas. Historical
heuristics never replace the canonical API-anchored row total.

## Known limitations

- **`TreeSelectorComponent` has no per-row extension hook.** Its row
  rendering is entirely internal to a sealed component with no
  callback/slot for appending per-row text, and this extension does not
  fork or monkey-patch installed Pi. So cumulative/delta figures are shown
  for the **highlighted row only**, in the panel above the tree, not as a
  suffix on every visible row.
- Category breakdowns (system prompt / tool schemas / etc.) are only as
  good as the live snapshots observed during the current process. Nothing
  is persisted across restarts, by design (`Runtime memory only`).
- Model/tool-schema token estimates use the same chars/4 heuristic Pi's own
  `estimateTokens` uses; they are not run through a real tokenizer.

## Requirements

- `@earendil-works/pi-coding-agent` >= 0.83.0 (uses its public
  `TreeSelectorComponent`, `sessionEntryToContextMessages`,
  `SessionTreeNode`, and the `"context"` extension event).

## Development

```bash
npm install
npm test        # node --test over test/**/*.test.ts
npm run typecheck
```

- `src/token-estimate.ts` -- pure chars/4 token estimation, split into
  categories (messages / tool calls / tool responses).
- `src/context-tracker.ts` -- the DP accounting engine: append-order,
  amortized O(1) per new entry, exact/estimate reconciliation, compaction
  and branch-summary handling.
- `src/panel.ts` -- pure panel text builder (no TUI/theme dependency), plus
  `describeEntry()` for the panel title (including the tool-result +
  matching-call combination).
- `src/index.ts` -- extension wiring: `/context-tree` command, the
  `"context"` event listener, and `ContextTreeInspectorComponent` (panel
  above a reused, unmodified `TreeSelectorComponent`).
