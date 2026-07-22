# AGENTS.md — Pi Vitals

## Overview

Pi Vitals is a customizable powerline-style footer extension for the [pi coding agent](https://github.com/mariozechner/pi-coding-agent). It replaces pi's built-in footer with a rich, configurable status bar showing git status, model info, token usage, context window percentage, and more.

## Architecture

### Entry Point: `index.ts`

Registers the extension with pi's `ExtensionAPI`. Handles lifecycle events (`session_start`, `session_shutdown`, `message_end`, `agent_end`, `tool_result`, `user_bash`) and wires up git status invalidation on relevant events. Contains the `setupFooter()` factory that provides a `render()` callback to pi's TUI layer.

### Segment Rendering: `segments.ts`

Each piece of footer content is a "segment" with an `id` and a `render()` function. Segments receive a `SegmentContext` and return a `RenderedSegment`. The segment registry maps IDs to implementations. Custom text segments (`text:Hello`) are handled inline.

### Git Status: `git-status.ts`

Provides synchronous repo detection (walking up from `cwd` to find `.git`) and branch reading (from the `HEAD` file). Git file status (staged/unstaged/untracked) is fetched asynchronously via `git status --porcelain` and cached. A `staleStatus` mechanism keeps previous values visible during refetches (see **Known Pitfalls** below).

### Configuration: `config.ts`

Loads user config from `~/.pi/agent/powerline.json` with defaults. Cached until explicitly reloaded via `/footer reload`.

### Theming & Icons: `theme.ts`, `icons.ts`

`theme.ts` maps semantic color names (e.g., `gitDirty`, `contextWarn`) to pi theme colors or hex values. `icons.ts` selects icon sets based on Nerd Font detection.

### Types: `types.ts`

Shared TypeScript interfaces: `GitStatus`, `SegmentContext`, `UsageStats`, `RenderedSegment`, user config types, etc.

## Key Design Decisions

- **No build step**: The extension runs TypeScript directly via pi's extension loader. No compilation needed.
- **Synchronous-first for repo/branch**: Repo root detection and branch reading are purely filesystem-based (reading `.git` and `HEAD` files). No subprocesses, no timeouts, instant results.
- **Async-only for file status**: `git status --porcelain` requires a subprocess. It runs asynchronously and triggers a re-render via `onFetchComplete` → `tuiRef.requestRender()`.
- **Stale-while-revalidate for git status**: When the cache is invalidated (e.g., on `tool_result`), previous values are kept visible until the new async fetch completes. This avoids visual flicker — see the pitfall below.
- **Segment-based layout**: Left and right segments are rendered independently, then composed with padding. Truncation favors the right side (keeps context % visible).

## Known Pitfalls

### ⚠️ Git status must never flash to zero during invalidation

**Problem**: When `invalidateGitStatus()` is called (fires on every `tool_result`, `message_end`, and `agent_end`), the git status cache is cleared. If `getGitStatus()` returns zeros while the async `git status --porcelain` fetch is in progress, the UI briefly shows no staged/unstaged/untracked files before the real values arrive. This causes a visible flicker — the git indicators disappear then reappear on every agent turn.

**Root cause**: Tying cache invalidation to "clear the data" rather than "mark as stale, fetch new data, then replace." The render callback is synchronous but the fetch is async, creating a gap where no data is available.

**Correct pattern**: Keep the old cached values visible as "stale" data when invalidating. Only replace them once the new fetch completes:

```ts
// ✅ Correct: preserve old values during refetch
let cachedStatus: CachedGitStatus | null = null;
let staleStatus: CachedGitStatus | null = null;

function invalidateGitStatus(): void {
  if (cachedStatus) {
    staleStatus = cachedStatus; // keep old values visible
  }
  cachedStatus = null;
}

function getGitStatus(): GitStatus {
  if (cachedStatus) return buildFrom(cachedStatus);

  // Start async refetch...
  if (!pendingFetch) {
    pendingFetch = fetchGitStatus().then((result) => {
      cachedStatus = result ?? { staged: 0, unstaged: 0, untracked: 0 };
      staleStatus = null; // new data available, clear stale
      pendingFetch = null;
      onFetchComplete?.();   // trigger re-render with fresh data
    });
  }

  // Show stale values (not zeros!) while fetch is in flight
  const fallback = staleStatus ?? { staged: 0, unstaged: 0, untracked: 0 };
  return buildFrom(fallback);
}
```

```ts
// ❌ Wrong: returning zeros during async gap causes flicker
function invalidateGitStatus(): void {
  cachedStatus = null; // data gone!
}

function getGitStatus(): GitStatus {
  if (!cachedStatus) {
    // Returns zeros while fetch is pending — flicker!
    return { ..., staged: 0, unstaged: 0, untracked: 0 };
  }
}
```

**This bug has recurred at least once.** Any future change to the git status caching or invalidation logic must preserve the stale-while-revalidate pattern. The `staleStatus` variable is not optional — it exists specifically to prevent this flicker.

### ⚠️ Failed fetches must NOT poison staleStatus

**Problem**: If `fetchGitStatus()` fails (timeout, git not installed), a naive implementation caches `{staged: 0, unstaged: 0, untracked: 0}` as the "result." On the next invalidation, this all-zeros object gets promoted to `staleStatus`, so the stale-while-revalidate guard shows zeros anyway — defeating its purpose.

**Correct pattern**: On fetch failure, do NOT cache zeros. Leave `cachedStatus` as `null` so the next render will retry the fetch. Only cache real data from a successful `git status --porcelain` result.

```ts
// ✅ Correct: don't cache zeros on failure
pendingFetch = fetchGitStatus().then((result) => {
  if (result) {
    cachedStatus = result;
  }
  // If failed, cachedStatus stays null → next render retries
  staleStatus = null;
  pendingFetch = null;
  onFetchComplete?.();
});
```

```ts
// ❌ Wrong: caching zeros on failure poisons staleStatus
pendingFetch = fetchGitStatus().then((result) => {
  cachedStatus = result ?? { staged: 0, unstaged: 0, untracked: 0 };
  // …later, invalidateGitStatus() copies these zeros into staleStatus
});
```

Additionally, `invalidateGitStatus()` must only promote cached values to `staleStatus` if they contain real data (at least one non-zero counter). All-zeros from a failed fetch should never overwrite `staleStatus`.

### ⚠️ First-ever fetch is a unavoidable zeros fallback

On the very first render, there is no `cachedStatus` and no `staleStatus`, so the fallback is `{staged: 0, unstaged: 0, untracked: 0}`. This is acceptable because (a) it only happens once, (b) the branch name is still shown (read synchronously), and (c) the git segment rendering logic hides indicators when counts are zero. There is no good alternative — we can't show data we don't have yet.
