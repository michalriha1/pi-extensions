import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  createGitRunner,
  createGitStatusController,
  findGitRepoInfo,
  type GitProcess,
  type GitRepoInfo,
  type GitRunner,
  type GitRunnerOptions,
  type GitStatusTimers,
} from "../git-status.ts";

interface DeferredProcess extends GitProcess {
  resolve(value: string | null): void;
  killed: boolean;
}

class FakeTimers implements GitStatusTimers {
  private nextId = 1;
  readonly callbacks = new Map<number, () => void>();

  setTimeout(callback: () => void): number {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.callbacks.delete(handle as number);
  }

  runNext(): void {
    const next = this.callbacks.entries().next();
    assert.equal(next.done, false, "expected a pending timer");
    const [id, callback] = next.value;
    this.callbacks.delete(id);
    callback();
  }
}

function deferredProcess(): DeferredProcess {
  let resolveResult: (value: string | null) => void = () => {};
  const process: DeferredProcess = {
    result: new Promise((resolve) => {
      resolveResult = resolve;
    }),
    killed: false,
    kill() {
      process.killed = true;
    },
    resolve(value) {
      resolveResult(value);
    },
  };
  return process;
}

const repo: GitRepoInfo = {
  worktreeDir: "/repo/worktree",
  commonGitDir: "/repo/worktree/.git",
  headPath: "/missing/test-head",
  mainRepoRoot: "/repo/worktree",
};

function createHarness(findRepo: (cwd: string) => GitRepoInfo | null = () => repo) {
  const timers = new FakeTimers();
  const processes: DeferredProcess[] = [];
  const calls: Array<{ args: readonly string[]; options: GitRunnerOptions }> = [];
  const runner: GitRunner = (args, options) => {
    calls.push({ args, options });
    const process = deferredProcess();
    processes.push(process);
    return process;
  };
  const controller = createGitStatusController({
    cwd: () => "/repo/worktree/subdir",
    findRepo,
    runner,
    timers,
    debounceMs: 10,
  });
  return { controller, timers, processes, calls };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function completeFetch(
  harness: ReturnType<typeof createHarness>,
  output: string | null,
): Promise<void> {
  harness.timers.runNext();
  harness.processes.at(-1)?.resolve(output);
  await settle();
}

test("detects regular, linked-worktree, and bare/common repository names", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-vitals-repos-"));
  try {
    const regular = join(directory, "regular-repo");
    mkdirSync(join(regular, ".git"), { recursive: true });
    writeFileSync(join(regular, ".git", "HEAD"), "ref: refs/heads/main\n");
    const regularInfo = findGitRepoInfo(regular);
    assert.equal(regularInfo?.mainRepoRoot, regular);
    assert.equal(createHarness(() => regularInfo).controller.getRepoName(), "regular-repo");

    const main = join(directory, "main-repo");
    const linked = join(directory, "linked");
    const linkedGitDir = join(main, ".git", "worktrees", "linked");
    mkdirSync(linkedGitDir, { recursive: true });
    mkdirSync(linked, { recursive: true });
    writeFileSync(join(linked, ".git"), `gitdir: ${linkedGitDir}\n`);
    writeFileSync(join(linkedGitDir, "HEAD"), "ref: refs/heads/feature\n");
    writeFileSync(join(linkedGitDir, "commondir"), "../..\n");
    const linkedInfo = findGitRepoInfo(linked);
    assert.equal(linkedInfo?.commonGitDir, join(main, ".git"));
    assert.equal(linkedInfo?.mainRepoRoot, main);
    assert.equal(createHarness(() => linkedInfo).controller.getRepoName(), "main-repo");

    for (const commonName of ["repo.git", "shared-common"]) {
      const worktree = join(directory, `worktree-${commonName}`);
      const gitDir = join(directory, commonName, "worktrees", "edge");
      mkdirSync(worktree, { recursive: true });
      mkdirSync(gitDir, { recursive: true });
      writeFileSync(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
      writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
      writeFileSync(join(gitDir, "commondir"), "../..\n");
      const info = findGitRepoInfo(worktree);
      assert.equal(info?.mainRepoRoot, join(directory, commonName));
      assert.equal(createHarness(() => info).controller.getRepoName(), commonName);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("uses valid git arguments and wires the worktree cwd and optional-lock environment", () => {
  const harness = createHarness();
  harness.controller.getStatus("main");
  harness.timers.runNext();

  assert.equal(harness.calls.length, 1);
  assert.deepEqual(harness.calls[0]?.args, ["status", "--porcelain"]);
  assert.equal(harness.calls[0]?.options.cwd, repo.worktreeDir);
  assert.equal(harness.calls[0]?.options.env.GIT_OPTIONAL_LOCKS, "0");
  assert.equal(harness.calls[0]?.args.includes("--no-optional-locks"), false);
});

test("never starts git outside a repository", () => {
  const harness = createHarness(() => null);
  const status = harness.controller.getStatus("provider");
  harness.controller.invalidateStatus();

  assert.equal(status.worktreeDir, null);
  assert.equal(status.branch, "provider");
  assert.equal(harness.timers.callbacks.size, 0);
  assert.equal(harness.calls.length, 0);
});

test("caches successful clean and dirty results", async () => {
  const clean = createHarness();
  clean.controller.getStatus("main");
  await completeFetch(clean, "");
  assert.deepEqual(
    { ...clean.controller.getStatus("main"), branch: null, worktreeDir: null, repoName: null },
    { branch: null, worktreeDir: null, repoName: null, staged: 0, unstaged: 0, untracked: 0 },
  );
  assert.equal(clean.calls.length, 1);

  const dirty = createHarness();
  dirty.controller.getStatus("main");
  await completeFetch(dirty, "M  staged.ts\n M unstaged.ts\n?? new.ts");
  const status = dirty.controller.getStatus("main");
  assert.deepEqual(
    { staged: status.staged, unstaged: status.unstaged, untracked: status.untracked },
    { staged: 1, unstaged: 1, untracked: 1 },
  );
});

test("returns a stable status identity until visible Git data changes", async () => {
  const harness = createHarness();
  const initial = harness.controller.getStatus("main");
  assert.strictEqual(harness.controller.getStatus("main"), initial);

  await completeFetch(harness, "M  staged.ts");
  const dirty = harness.controller.getStatus("main");
  assert.notStrictEqual(dirty, initial);
  assert.strictEqual(harness.controller.getStatus("main"), dirty);

  harness.controller.invalidateStatus();
  assert.strictEqual(harness.controller.getStatus("main"), dirty);
  await completeFetch(harness, "M  staged.ts");
  assert.strictEqual(harness.controller.getStatus("main"), dirty);

  const branch = harness.controller.getStatus("feature");
  assert.notStrictEqual(branch, dirty);
  assert.strictEqual(harness.controller.getStatus("feature"), branch);
});

test("identical completion and failed refresh preserve identity without visible callbacks", async () => {
  const harness = createHarness();
  let completions = 0;
  harness.controller.setOnFetchComplete(() => completions++);
  const initial = harness.controller.getStatus("main");
  await completeFetch(harness, "");
  assert.strictEqual(harness.controller.getStatus("main"), initial);
  assert.equal(completions, 0);

  harness.controller.invalidateStatus();
  await completeFetch(harness, null);
  assert.strictEqual(harness.controller.getStatus("main"), initial);
  assert.equal(completions, 0);
});

test("keeps stale clean and dirty values while refreshing", async () => {
  for (const output of ["", "M  staged.ts\n M unstaged.ts\n?? new.ts"]) {
    const harness = createHarness();
    harness.controller.getStatus("main");
    await completeFetch(harness, output);
    const before = harness.controller.getStatus("main");

    harness.controller.invalidateStatus();
    const duringDebounce = harness.controller.getStatus("main");
    harness.timers.runNext();
    const whilePending = harness.controller.getStatus("main");

    assert.deepEqual(
      [duringDebounce.staged, duringDebounce.unstaged, duringDebounce.untracked],
      [before.staged, before.unstaged, before.untracked],
    );
    assert.deepEqual(
      [whilePending.staged, whilePending.unstaged, whilePending.untracked],
      [before.staged, before.unstaged, before.untracked],
    );
  }
});

test("failure preserves stale values and renders do not retry", async () => {
  const harness = createHarness();
  harness.controller.getStatus("main");
  await completeFetch(harness, "M  staged.ts");
  harness.controller.invalidateStatus();
  await completeFetch(harness, null);

  for (let index = 0; index < 100; index++) harness.controller.getStatus("main");
  const status = harness.controller.getStatus("main");
  assert.equal(status.staged, 1);
  assert.equal(harness.calls.length, 2);
  assert.equal(harness.timers.callbacks.size, 0);

  harness.controller.invalidateStatus();
  assert.equal(harness.timers.callbacks.size, 1);
});

test("3,600 unchanged status reads after completion launch no additional Git work", async () => {
  const harness = createHarness();
  harness.controller.getStatus("main");
  await completeFetch(harness, "M  staged.ts");
  const status = harness.controller.getStatus("main");

  for (let index = 0; index < 3_600; index++) {
    assert.strictEqual(harness.controller.getStatus("main"), status);
  }
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.timers.callbacks.size, 0);
});

test("100 renders while debouncing or pending start one process", () => {
  const harness = createHarness();
  for (let index = 0; index < 100; index++) harness.controller.getStatus("main");
  assert.equal(harness.timers.callbacks.size, 1);
  assert.equal(harness.calls.length, 0);

  harness.timers.runNext();
  for (let index = 0; index < 100; index++) harness.controller.getStatus("main");
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.timers.callbacks.size, 0);
});

test("invalidations in flight create one follow-up and obsolete completion is not final", async () => {
  const harness = createHarness();
  let completions = 0;
  harness.controller.setOnFetchComplete(() => completions++);
  harness.controller.getStatus("main");
  harness.timers.runNext();

  harness.controller.invalidateStatus();
  harness.controller.invalidateStatus();
  harness.controller.invalidateStatus();
  harness.processes[0]?.resolve("M  obsolete.ts");
  await settle();

  assert.equal(harness.calls.length, 1);
  assert.equal(harness.timers.callbacks.size, 1);
  assert.equal(harness.controller.getStatus("main").staged, 0);
  assert.equal(completions, 0);

  harness.timers.runNext();
  assert.equal(harness.calls.length, 2);
  harness.processes[1]?.resolve("?? final.ts");
  await settle();

  const final = harness.controller.getStatus("main");
  assert.deepEqual([final.staged, final.unstaged, final.untracked], [0, 0, 1]);
  assert.equal(completions, 1);
  assert.equal(harness.timers.callbacks.size, 0);
});

test("prefers provider branch changes without consulting the HEAD fallback", () => {
  const harness = createHarness();
  assert.equal(harness.controller.getCurrentBranch("main"), "main");
  assert.equal(harness.controller.getCurrentBranch("feature"), "feature");
});

test("HEAD fallback is cached until explicit branch invalidation", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-vitals-head-"));
  const headPath = join(directory, "HEAD");
  writeFileSync(headPath, "ref: refs/heads/main\n");
  const info: GitRepoInfo = { ...repo, headPath };
  const harness = createHarness(() => info);

  try {
    assert.equal(harness.controller.getCurrentBranch(null), "main");
    writeFileSync(headPath, "ref: refs/heads/feature\n");
    for (let index = 0; index < 100; index++) {
      assert.equal(harness.controller.getCurrentBranch(null), "main");
    }
    harness.controller.invalidateBranch();
    assert.equal(harness.controller.getCurrentBranch(null), "feature");
  } finally {
    harness.controller.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Git runner bounds output, discards stderr, and settles once on every termination path", async () => {
  class FakeChild extends EventEmitter {
    readonly stdout = new PassThrough();
    kills = 0;
    kill(): boolean { this.kills++; return true; }
  }
  const children: FakeChild[] = [];
  const runner = createGitRunner((_command, _args, options) => {
    assert.deepEqual(options.stdio, ["ignore", "pipe", "ignore"]);
    const child = new FakeChild();
    children.push(child);
    return child as unknown as ChildProcess;
  });
  const options = { cwd: "/repo", env: {}, timeoutMs: 50, maxOutputBytes: 4 };

  const oversized = runner(["status"], options);
  children[0]?.stdout.write("12345");
  assert.equal(await oversized.result, null);
  assert.equal(children[0]?.kills, 1);
  children[0]?.emit("close", 0);
  assert.equal(await oversized.result, null, "late close cannot replace the output-limit result");

  const noisyFailure = runner(["bad"], options);
  children[1]?.emit("close", 1);
  assert.equal(await noisyFailure.result, null);

  const timeout = runner(["status"], { ...options, timeoutMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await timeout.result, null);
  assert.equal(children[2]?.kills, 1);
  children[2]?.emit("close", 0);

  const spawnError = createGitRunner(() => { throw new Error("spawn failed"); })(["status"], options);
  assert.equal(await spawnError.result, null);

  const disposed = runner(["status"], options);
  disposed.kill();
  disposed.kill();
  assert.equal(await disposed.result, null);
  assert.equal(children[3]?.kills, 1);
  children[3]?.emit("close", 0);
});

test("dispose clears timers and callbacks, kills active work, and ignores late completion", async () => {
  const debouncing = createHarness();
  debouncing.controller.getStatus("main");
  assert.equal(debouncing.timers.callbacks.size, 1);
  debouncing.controller.dispose();
  assert.equal(debouncing.timers.callbacks.size, 0);

  const pending = createHarness();
  let completions = 0;
  pending.controller.setOnFetchComplete(() => completions++);
  pending.controller.getStatus("main");
  pending.timers.runNext();
  pending.controller.dispose();
  assert.equal(pending.processes[0]?.killed, true);
  pending.processes[0]?.resolve("M  late.ts");
  await settle();

  assert.equal(completions, 0);
  assert.equal(pending.timers.callbacks.size, 0);
  assert.equal(pending.controller.getStatus("main").staged, 0);
});
