import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { GitStatus } from "./types.js";

// ═══════════════════════════════════════════════════════════════════════════
// Synchronous git repo detection (no subprocesses, no timeouts)
// Based on pi's FooterDataProvider: read .git files/dirs directly
// ═══════════════════════════════════════════════════════════════════════════

interface GitRepoInfo {
  /** The directory containing .git (worktree dir for worktrees, repo root for regular repos) */
  worktreeDir: string;
  /** The main repo's .git directory (shared across worktrees) */
  commonGitDir: string;
  /** Path to the HEAD file for this worktree */
  headPath: string;
  /** The main repo root directory (parent of .git for regular repos, derived from commonGitDir for worktrees) */
  mainRepoRoot: string;
}

/**
 * Walk up from cwd to find git metadata.
 * Handles both regular git repos and worktrees.
 * Returns null if not in a git repo.
 */
function findGitRepoInfo(cwd: string): GitRepoInfo | null {
  let dir = cwd;
  while (true) {
    const gitPath = join(dir, ".git");
    if (existsSync(gitPath)) {
      try {
        const stat = statSync(gitPath);
        if (stat.isFile()) {
          // Worktree: .git is a file pointing to the git directory
          const content = readFileSync(gitPath, "utf8").trim();
          if (content.startsWith("gitdir: ")) {
            const gitDir = resolve(dir, content.slice(8).trim());
            const headPath = join(gitDir, "HEAD");
            if (!existsSync(headPath)) return null;
            const commonDirPath = join(gitDir, "commondir");
            const commonGitDir = existsSync(commonDirPath)
              ? resolve(gitDir, readFileSync(commonDirPath, "utf8").trim())
              : gitDir;
            // Main repo root is the parent of the common .git directory
            const mainRepoRoot = dirname(commonGitDir);
            return { worktreeDir: dir, commonGitDir, headPath, mainRepoRoot };
          }
        } else if (stat.isDirectory()) {
          // Regular repo: .git is a directory
          const headPath = join(gitPath, "HEAD");
          if (!existsSync(headPath)) return null;
          return { worktreeDir: dir, commonGitDir: gitPath, headPath, mainRepoRoot: dir };
        }
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Read the current branch from the HEAD file synchronously.
 * Returns the branch name, "detached", or null if not readable.
 */
function readBranchFromHead(headPath: string): string | null {
  try {
    const content = readFileSync(headPath, "utf8").trim();
    if (content.startsWith("ref: refs/heads/")) {
      return content.slice(16);
    }
    return "detached";
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Git status cache — fetch once, re-fetch only on explicit invalidation
// ═══════════════════════════════════════════════════════════════════════════

interface CachedGitStatus {
  staged: number;
  unstaged: number;
  untracked: number;
}

// Callback to trigger a re-render after async fetches complete
let onFetchComplete: (() => void) | null = null;

export function setOnFetchComplete(cb: (() => void) | null): void {
  onFetchComplete = cb;
}

// After invalidation, we debounce the fetch briefly so that multiple
// invalidation events in quick succession (tool_result + message_end + agent_end)
// result in a single git status call instead of N overlapping processes.
const FETCH_DEBOUNCE_MS = 150;
let fetchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let cachedStatus: CachedGitStatus | null = null;
let staleStatus: CachedGitStatus | null = null; // Previous values kept visible during refetch
let pendingFetch: Promise<void> | null = null;

// Cached repo info (synchronous, no TTL — only changes on cd)
let cachedRepoInfo: GitRepoInfo | null | undefined = undefined;

function parseGitStatusOutput(output: string): { staged: number; unstaged: number; untracked: number } {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;

  for (const line of output.split("\n")) {
    if (!line) continue;
    const x = line[0];
    const y = line[1];

    if (x === "?" && y === "?") {
      untracked++;
      continue;
    }

    if (x && x !== " " && x !== "?") {
      staged++;
    }

    if (y && y !== " ") {
      unstaged++;
    }
  }

  return { staged, unstaged, untracked };
}

function runGit(args: string[], timeoutMs = 2000): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn("git", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });

    let stdout = "";
    let resolved = false;

    const finish = (result: string | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      resolve(result);
    };

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.on("close", (code) => {
      finish(code === 0 ? stdout.trim() : null);
    });

    proc.on("error", () => {
      finish(null);
    });

    const timeoutId = setTimeout(() => {
      proc.kill();
      finish(null);
    }, timeoutMs);
  });
}

async function fetchGitStatus(): Promise<{ staged: number; unstaged: number; untracked: number } | null> {
  const output = await runGit(["status", "--no-optional-locks", "--porcelain"], 2000);
  if (output === null) return null;
  return parseGitStatusOutput(output);
}

/**
 * Get the git repo info for the current working directory.
 * Synchronous, filesystem-based — no git subprocess needed.
 */
function getGitRepoInfo(): GitRepoInfo | null {
  if (cachedRepoInfo !== undefined) return cachedRepoInfo;
  cachedRepoInfo = findGitRepoInfo(process.cwd());
  return cachedRepoInfo;
}

/**
 * Get the main repo root directory.
 * For regular repos, same as the worktree dir.
 * For worktrees, the parent repo that contains .git.
 */
export function getGitRoot(): string | null {
  const info = getGitRepoInfo();
  if (!info) return null;
  return info.worktreeDir;
}

/**
 * Get the display name of the repo.
 * For regular repos: basename of the repo directory.
 * For worktrees: basename of the common git directory (the bare repo name).
 */
export function getGitRepoName(): string | null {
  const info = getGitRepoInfo();
  if (!info) return null;
  // Regular repo: worktreeDir == mainRepoRoot, name is the directory name
  if (info.worktreeDir === info.mainRepoRoot) {
    return basename(info.worktreeDir);
  }
  // Worktree: name comes from the bare repo directory
  return basename(info.commonGitDir);
}

/**
 * Get the current branch by reading HEAD file directly.
 * Falls back to providerBranch if not in a git repo.
 */
export function getCurrentBranch(providerBranch: string | null): string | null {
  const info = getGitRepoInfo();
  if (!info) return providerBranch;
  return readBranchFromHead(info.headPath) ?? providerBranch;
}

export function getGitStatus(providerBranch: string | null): GitStatus {
  const branch = getCurrentBranch(providerBranch);
  const worktreeDir = getGitRoot();
  const repoName = getGitRepoName();

  // If we have cached status, return it — no TTL expiry
  if (cachedStatus) {
    return {
      branch,
      worktreeDir,
      repoName,
      staged: cachedStatus.staged,
      unstaged: cachedStatus.unstaged,
      untracked: cachedStatus.untracked,
    };
  }

  // No current cache — start a fetch if one isn't already in progress
  if (!pendingFetch && !fetchDebounceTimer) {
    fetchDebounceTimer = setTimeout(() => {
      fetchDebounceTimer = null;
      if (pendingFetch) return; // shouldn't happen, but guard
      pendingFetch = fetchGitStatus().then((result) => {
        if (result) {
          cachedStatus = { staged: result.staged, unstaged: result.unstaged, untracked: result.untracked };
        }
        // If fetch failed, do NOT cache zeros — leave cachedStatus null so we retry
        // on the next render, and keep staleStatus available as a fallback.
        staleStatus = null; // New data available (or we're retrying), clear stale
        pendingFetch = null;
        onFetchComplete?.();
      });
    }, FETCH_DEBOUNCE_MS);
  }

  // While fetching, return stale values (from before invalidation) so the UI
  // doesn't flash to zero. Fall back to zeros only on the very first fetch
  // when no stale data exists yet.
  const fallback = staleStatus ?? { staged: 0, unstaged: 0, untracked: 0 };
  return { branch, worktreeDir, repoName, staged: fallback.staged, unstaged: fallback.unstaged, untracked: fallback.untracked };
}

export function invalidateGitStatus(): void {
  // Keep the old values visible as stale data until the async refetch completes.
  // Only promote real data (with at least one non-zero value) to stale —
  // all-zeros from a failed fetch would poison staleStatus and defeat the guard.
  if (cachedStatus && (cachedStatus.staged > 0 || cachedStatus.unstaged > 0 || cachedStatus.untracked > 0)) {
    staleStatus = cachedStatus;
  } else if (cachedStatus) {
    // Cached was zeros (likely from a failed fetch) — don't poison staleStatus.
    // Keep whatever staleStatus already has; it's better than zeros.
  }
  cachedStatus = null;
}

export function invalidateGitBranch(): void {
  // Branch is read synchronously from HEAD file — no cache to invalidate
}

export function invalidateGitRoot(): void {
  cachedRepoInfo = undefined;
}
