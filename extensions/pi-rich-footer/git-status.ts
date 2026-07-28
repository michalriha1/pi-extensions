import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { GitStatus } from "./types.js";

export interface GitRepoInfo {
  worktreeDir: string;
  commonGitDir: string;
  headPath: string;
  mainRepoRoot: string;
}

export interface GitProcess {
  result: Promise<string | null>;
  kill(): void;
}

export interface GitRunnerOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
}

export type GitRunner = (args: readonly string[], options: GitRunnerOptions) => GitProcess;

export interface GitStatusTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface GitStatusControllerOptions {
  cwd?: () => string;
  findRepo?: (cwd: string) => GitRepoInfo | null;
  runner?: GitRunner;
  timers?: GitStatusTimers;
  debounceMs?: number;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

interface CachedGitStatus {
  staged: number;
  unstaged: number;
  untracked: number;
}

const EMPTY_STATUS: CachedGitStatus = { staged: 0, unstaged: 0, untracked: 0 };
const FETCH_DEBOUNCE_MS = 150;
const FETCH_TIMEOUT_MS = 2000;
export const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;

export function findGitRepoInfo(cwd: string): GitRepoInfo | null {
  let dir = resolve(cwd);
  while (true) {
    const gitPath = join(dir, ".git");
    if (existsSync(gitPath)) {
      try {
        const stat = statSync(gitPath);
        if (stat.isFile()) {
          const content = readFileSync(gitPath, "utf8").trim();
          if (content.startsWith("gitdir: ")) {
            const gitDir = resolve(dir, content.slice(8).trim());
            const headPath = join(gitDir, "HEAD");
            if (!existsSync(headPath)) return null;
            const commonDirPath = join(gitDir, "commondir");
            const commonGitDir = existsSync(commonDirPath)
              ? resolve(gitDir, readFileSync(commonDirPath, "utf8").trim())
              : gitDir;
            const mainRepoRoot = basename(commonGitDir) === ".git" ? dirname(commonGitDir) : commonGitDir;
            return { worktreeDir: dir, commonGitDir, headPath, mainRepoRoot };
          }
        } else if (stat.isDirectory()) {
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

function readBranchFromHead(headPath: string): string | null {
  try {
    const content = readFileSync(headPath, "utf8").trim();
    return content.startsWith("ref: refs/heads/") ? content.slice(16) : "detached";
  } catch {
    return null;
  }
}

export function parseGitStatusOutput(output: string): CachedGitStatus {
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
    if (x && x !== " " && x !== "?") staged++;
    if (y && y !== " ") unstaged++;
  }

  return { staged, unstaged, untracked };
}

export type SpawnGit = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export function createGitRunner(spawnGit: SpawnGit = spawn): GitRunner {
  return (args, options) => {
  let proc: ChildProcess | null = null;
  let stdout = "";
  let stdoutBytes = 0;
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let resolveResult: (result: string | null) => void = () => {};
  const result = new Promise<string | null>((resolvePromise) => {
    resolveResult = resolvePromise;
  });
  const finish = (value: string | null): void => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    resolveResult(value);
  };
  const terminate = (): void => {
    if (settled) return;
    proc?.kill();
    finish(null);
  };

  try {
    proc = spawnGit("git", [...args], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "ignore"],
      env: options.env,
    });
    timeout = setTimeout(terminate, options.timeoutMs);
    proc.stdout?.on("data", (data: Buffer | string) => {
      if (settled) return;
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > options.maxOutputBytes) {
        terminate();
        return;
      }
      stdout += chunk.toString();
    });
    proc.on("close", (code) => finish(code === 0 ? stdout.trim() : null));
    proc.on("error", terminate);
  } catch {
    finish(null);
  }

    return { result, kill: terminate };
  };
}

export const runGit = createGitRunner();

export interface GitStatusController {
  getStatus(providerBranch: string | null): GitStatus;
  getRoot(): string | null;
  getRepoName(): string | null;
  getCurrentBranch(providerBranch: string | null): string | null;
  invalidateStatus(): void;
  invalidateBranch(): void;
  invalidateRoot(): void;
  setOnFetchComplete(callback: (() => void) | null): void;
  dispose(): void;
}

export function createGitStatusController(options: GitStatusControllerOptions = {}): GitStatusController {
  const cwd = options.cwd ?? (() => process.cwd());
  const detectRepo = options.findRepo ?? findGitRepoInfo;
  const runner = options.runner ?? runGit;
  const timers = options.timers ?? {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const debounceMs = options.debounceMs ?? FETCH_DEBOUNCE_MS;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? MAX_GIT_OUTPUT_BYTES;

  let repoInfo: GitRepoInfo | null | undefined;
  let cachedStatus: CachedGitStatus | null = null;
  let staleStatus: CachedGitStatus | null = null;
  let cachedFallbackBranch: string | null | undefined;
  let refreshRequested = true;
  let generation = 0;
  let debounceTimer: unknown | null = null;
  let activeProcess: GitProcess | null = null;
  let onFetchComplete: (() => void) | null = null;
  let currentView: GitStatus | null = null;
  let lastProviderBranch: string | null = null;
  let disposed = false;

  const getRepo = (): GitRepoInfo | null => {
    if (repoInfo === undefined) repoInfo = detectRepo(cwd());
    return repoInfo;
  };

  const scheduleRefresh = (): void => {
    if (disposed || !refreshRequested || debounceTimer !== null || activeProcess) return;
    if (!getRepo()) {
      refreshRequested = false;
      return;
    }
    debounceTimer = timers.setTimeout(startRefresh, debounceMs);
  };

  const startRefresh = (): void => {
    debounceTimer = null;
    if (disposed || activeProcess || !refreshRequested) return;
    const repo = getRepo();
    if (!repo) {
      refreshRequested = false;
      return;
    }

    refreshRequested = false;
    const requestGeneration = generation;
    const process = runner(["status", "--porcelain"], {
      cwd: repo.worktreeDir,
      env: { ...globalThis.process.env, GIT_OPTIONAL_LOCKS: "0" },
      timeoutMs,
      maxOutputBytes,
    });
    activeProcess = process;
    void process.result.then((output) => {
      if (disposed || activeProcess !== process) return;
      activeProcess = null;

      if (requestGeneration === generation) {
        if (output !== null) {
          cachedStatus = parseGitStatusOutput(output);
          staleStatus = null;
          const previousView = currentView;
          if (updateVisibleView(lastProviderBranch) !== previousView) {
            onFetchComplete?.();
          }
        }
      } else {
        refreshRequested = true;
      }
      scheduleRefresh();
    });
  };

  const getRoot = (): string | null => getRepo()?.worktreeDir ?? null;
  const repoName = (info: GitRepoInfo | null): string | null => info ? basename(info.mainRepoRoot) : null;
  const getRepoName = (): string | null => repoName(getRepo());
  const getCurrentBranch = (providerBranch: string | null): string | null => {
    if (providerBranch !== null) return providerBranch;
    if (cachedFallbackBranch !== undefined) return cachedFallbackBranch;
    const info = getRepo();
    cachedFallbackBranch = info ? readBranchFromHead(info.headPath) : null;
    return cachedFallbackBranch;
  };
  const updateVisibleView = (providerBranch: string | null): GitStatus => {
    const info = getRepo();
    const status = cachedStatus ?? staleStatus ?? EMPTY_STATUS;
    const branch = getCurrentBranch(providerBranch);
    const name = repoName(info);
    if (currentView
      && currentView.branch === branch
      && currentView.worktreeDir === (info?.worktreeDir ?? null)
      && currentView.repoName === name
      && currentView.staged === status.staged
      && currentView.unstaged === status.unstaged
      && currentView.untracked === status.untracked) {
      return currentView;
    }
    currentView = {
      branch,
      worktreeDir: info?.worktreeDir ?? null,
      repoName: name,
      staged: status.staged,
      unstaged: status.unstaged,
      untracked: status.untracked,
    };
    return currentView;
  };

  return {
    getStatus(providerBranch) {
      lastProviderBranch = providerBranch;
      const info = getRepo();
      if (info) scheduleRefresh();
      return updateVisibleView(providerBranch);
    },
    getRoot,
    getRepoName,
    getCurrentBranch,
    invalidateStatus() {
      if (disposed) return;
      if (cachedStatus) staleStatus = cachedStatus;
      cachedStatus = null;
      refreshRequested = true;
      generation++;
      scheduleRefresh();
    },
    invalidateBranch() {
      if (disposed) return;
      cachedFallbackBranch = undefined;
    },
    invalidateRoot() {
      if (disposed) return;
      repoInfo = undefined;
      cachedFallbackBranch = undefined;
      this.invalidateStatus();
    },
    setOnFetchComplete(callback) {
      if (!disposed) onFetchComplete = callback;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation++;
      refreshRequested = false;
      onFetchComplete = null;
      if (debounceTimer !== null) {
        timers.clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      activeProcess?.kill();
      activeProcess = null;
    },
  };
}

let defaultController = createGitStatusController();

export function getGitRoot(): string | null {
  return defaultController.getRoot();
}
export function getGitRepoName(): string | null {
  return defaultController.getRepoName();
}
export function getCurrentBranch(providerBranch: string | null): string | null {
  return defaultController.getCurrentBranch(providerBranch);
}
export function getGitStatus(providerBranch: string | null): GitStatus {
  return defaultController.getStatus(providerBranch);
}
export function invalidateGitStatus(): void {
  defaultController.invalidateStatus();
}
export function invalidateGitBranch(): void {
  defaultController.invalidateBranch();
}
export function invalidateGitRoot(): void {
  defaultController.invalidateRoot();
}
export function setOnFetchComplete(callback: (() => void) | null): void {
  defaultController.setOnFetchComplete(callback);
}
export function disposeGitStatus(): void {
  defaultController.dispose();
  defaultController = createGitStatusController();
}
