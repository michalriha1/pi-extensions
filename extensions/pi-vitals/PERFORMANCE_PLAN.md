# Pi Vitals Performance Plan

## Goals

- Make unchanged footer redraws independent of session length.
- Never start filesystem work or subprocesses from an unchanged render.
- Preserve stale Git status without flicker while refreshes run or fail.
- Coalesce invalidations and clean up timers/processes on reload and shutdown.
- Preserve existing configuration, segment layout, colors, and icons.

## Stage 1: Git correctness and lifecycle — Complete

- Remove the invalid `--no-optional-locks` status argument; retain `GIT_OPTIONAL_LOCKS=0`.
- Run Git in the detected worktree and skip it outside repositories.
- Represent successful clean status separately from fetch failure.
- Preserve the last successful status during refresh and failure.
- Add generation-aware invalidation and one follow-up refresh when invalidated in flight.
- Prevent redraw-driven retries; retries occur only after explicit invalidation.
- Add disposal that clears debounce timers, terminates active Git work, and ignores late completions.
- Add deterministic tests for clean/dirty/failure, stale-while-revalidate, coalescing, in-flight invalidation, non-repository behavior, and cleanup.

### Acceptance

- Repeated renders launch at most one initial Git process.
- Failed fetches do not clear stale values or cause retry loops.
- One or more invalidations during a pending fetch cause exactly one follow-up fetch.
- No Git process runs outside a repository.

## Stage 2: Configuration and static presentation snapshots — Complete

- Cache effective configuration, resolved colors, icon selection, Nerd Font detection, and static thinking labels.
- Build snapshots at startup and `/footer reload`, not during render.
- Cache missing and invalid configuration results so they do not probe the filesystem per frame.
- Keep explicit reload semantics and controlled fallback behavior.
- Add tests for missing, invalid, partial, and reloaded configuration.

### Acceptance

- An unchanged render performs no configuration filesystem access, icon merging, or font detection.
- Reload replaces the snapshot exactly once.

## Stage 3: Event-derived session and branch state — Complete

- Move branch-wide usage aggregation out of `render()`.
- Build the initial session snapshot once and refresh it on assistant completion, compaction, tree navigation, model changes, and thinking-level changes.
- Use the public context-usage API for post-compaction/model-correct context percentage.
- Use Pi's footer branch provider and branch-change notification instead of reading `.git/HEAD` each frame.
- Remove unsupported context API access and broad `any` where public types exist.
- Add lifecycle and context-correctness tests.

### Acceptance

- Unchanged renders do not call `sessionManager.getBranch()` or read `.git/HEAD`.
- Compaction, navigation, model, and thinking changes refresh only the relevant snapshot.

## Stage 4: Complete footer-row cache — Complete

- Version configuration, session, Git, branch, extension-status, and theme state.
- Cache the final rendered footer line by width and state versions.
- Clear themed rows through component invalidation and lifecycle reset.
- Keep extension statuses current through a cheap stable signature or supported status notification.
- Add tests for cache hits and invalidation by every state dimension.

### Acceptance

- An unchanged render performs only key/signature checks and returns the cached line.
- Cache hits do not render segments, recalculate widths, sort statuses, or allocate a replacement line.

## Stage 5: Correctness hardening and benchmarks — Complete

- Correct linked-worktree repository naming.
- Handle terminal widths 0 and 1 without exceeding width.
- Sanitize untrusted path control characters.
- Validate user configuration with actionable fallback diagnostics.
- Bound Git output and consume stderr safely.
- Add deterministic render benchmarks for 0, 100, 1,000, and 10,000 session entries.
- Profile the fork in a real Pi TUI using unchanged and forced-redraw scenarios.

### Acceptance

- Focused tests and type checking pass.
- Unchanged render cost is effectively independent of session size.
- No Git subprocess, synchronous filesystem read, or full session scan occurs on cache-hit redraws.
