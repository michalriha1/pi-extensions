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
Context Tree Inspector — assistant message: answer
Total: 101,000 / 200,000 (51%)  ████████████░░░░░░░░░░░░
Total delta: 1,000
  request 100
  response 900
```

- **Total**: the row's cumulative context size. Shown without `~` when it
  comes directly from an API-reported `usage` value; estimated otherwise.
- **Total delta** (assistant rows): context growth since the previous
  assistant response, split into **request** (new user/tool input added
  before this provider call) and **response** (the assistant output). For
  example, a 100-token question plus a 900-token answer displays a 1,000
  total delta, with both contributions visible separately.
- **Interaction delta** (tool rows): the complete visible interaction—the
  matching call plus its result—broken into `call + arguments` and
  `response`. Pi stores these in separate session entries but its tree hides
  tool-only assistant entries and renders one combined row, so the panel
  likewise presents one combined delta. Always estimated (`~`).
- **Row delta** (other rows): this row's own contribution relative to its
  parent. Negative deltas are expected after compaction because content was
  discarded from context.

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
  response. Because Pi displays those entries as one tool row, the panel
  shows one interaction delta with separate `call + arguments` / `response`
  contributions.
- Compaction entries intentionally produce **negative** deltas: the summary
  plus whatever was kept (`retainedTail`, or the span from
  `firstKeptEntryId` onward) replaces everything that was summarized away.
- Branch-summary entries need no special handling: their tree parent is
  already the common ancestor, so the abandoned branch's tokens are
  naturally excluded from their cumulative total.

## Known limitations

- **`TreeSelectorComponent` has no per-row extension hook.** Its row
  rendering is entirely internal to a sealed component with no
  callback/slot for appending per-row text, and this extension does not
  fork or monkey-patch installed Pi. So cumulative/delta figures are shown
  for the **highlighted row only**, in the panel above the tree, not as a
  suffix on every visible row.
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
