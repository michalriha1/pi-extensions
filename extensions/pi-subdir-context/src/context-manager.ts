import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { ContextDiscovery, type ConfigIgnoreChecker } from "./discovery.ts";
import { hasSkippedProjectSegment, resolveProjectPath, toPosixPath } from "./path-utils.ts";
import type { ContextBatch, ContextSource, LoadedContext } from "./types.ts";

export const MAX_CONTEXT_BYTES = 50 * 1024;
export const MAX_CONTEXT_LINES = 2_000;

export class SubdirContextManager {
  readonly projectRoot: string;
  readonly discovery: ContextDiscovery;
  private readonly loadedRealPaths = new Set<string>();
  private readonly contentCache = new Map<string, Promise<string | undefined>>();

  private constructor(projectRoot: string, ignoreChecker?: ConfigIgnoreChecker) {
    this.projectRoot = projectRoot;
    this.discovery = new ContextDiscovery(projectRoot, ignoreChecker);
  }

  static async create(cwd: string, ignoreChecker?: ConfigIgnoreChecker): Promise<SubdirContextManager> {
    return new SubdirContextManager(await realpath(cwd), ignoreChecker);
  }

  resetSession(): void {
    this.loadedRealPaths.clear();
    this.contentCache.clear();
    this.discovery.resetCaches();
  }

  get loadedSources(): ReadonlySet<string> {
    return this.loadedRealPaths;
  }

  async resolveTarget(inputPath: unknown): Promise<string | undefined> {
    if (typeof inputPath !== "string") return undefined;
    const target = await resolveProjectPath(this.projectRoot, inputPath);
    if (!target || hasSkippedProjectSegment(this.projectRoot, target)) return undefined;
    return target;
  }

  async contextForTarget(targetFile: string): Promise<ContextBatch> {
    if (this.discovery.isPotentialContextFile(targetFile)) return emptyBatch();
    return this.collect(await this.discovery.discover(targetFile));
  }

  async noteSuccessfulContextRead(targetFile: string, wasPartial: boolean): Promise<void> {
    if (!this.discovery.isPotentialContextFile(targetFile) || wasPartial) return;
    try {
      this.loadedRealPaths.add(await realpath(targetFile));
    } catch {
      // A successful read should exist, but races with deletion are harmless.
    }
  }

  async noteSuccessfulMutation(targetFile: string): Promise<void> {
    this.discovery.resetCaches();
    this.contentCache.clear();
    if (!this.discovery.isPotentialContextFile(targetFile)) return;
    try {
      this.loadedRealPaths.add(await realpath(targetFile));
    } catch {
      // A deletion or failed canonicalization should not expand scope.
    }
  }

  private async collect(sources: ContextSource[]): Promise<ContextBatch> {
    const contexts: LoadedContext[] = [];
    let bytes = 0;
    let lines = 0;
    let truncated = false;

    for (const source of sources) {
      if (this.loadedRealPaths.has(source.realPath)) continue;
      const content = await this.readContext(source.realPath);
      if (content === undefined) continue;

      const complete = formatContext(source, content, this.projectRoot);
      const completeBytes = Buffer.byteLength(complete);
      const completeLines = countLines(complete);
      const fits = bytes + completeBytes <= MAX_CONTEXT_BYTES && lines + completeLines <= MAX_CONTEXT_LINES;

      if (!fits && contexts.length > 0) {
        truncated = true;
        break;
      }

      let text = complete;
      let sourceTruncated = false;
      if (!fits) {
        text = truncateContext(complete, MAX_CONTEXT_BYTES, MAX_CONTEXT_LINES);
        sourceTruncated = true;
        truncated = true;
      }

      // Claim before yielding the batch so concurrent tool results cannot inject
      // the same source twice. Failed reads are never claimed.
      this.loadedRealPaths.add(source.realPath);
      contexts.push({ source, text, truncated: sourceTruncated });
      bytes += Buffer.byteLength(text);
      lines += countLines(text);
    }

    return {
      contexts,
      text: contexts.map((context) => context.text).join("\n\n"),
      truncated,
    };
  }

  private readContext(realPath: string): Promise<string | undefined> {
    const cached = this.contentCache.get(realPath);
    if (cached) return cached;
    const content = readFile(realPath, "utf8").catch(() => undefined);
    this.contentCache.set(realPath, content);
    return content;
  }
}

export function formatContext(source: ContextSource, content: string, projectRoot: string): string {
  const sourcePath = toPosixPath(path.relative(projectRoot, source.path)) || ".";
  const scopePath = toPosixPath(path.relative(projectRoot, source.scopeDirectory)) || ".";
  const lines = [
    "<pi-subdir-context>",
    `Source: ${sourcePath}`,
    `Scope: ${scopePath}/**`,
    `Kind: ${source.kind}`,
  ];

  if (source.skill) {
    lines.push(`Skill name: ${source.skill.name}`);
    lines.push(`Description: ${source.skill.description}`);
    lines.push(`Paths: ${source.skill.paths?.join(", ") ?? "all files beneath scope"}`);
  }

  lines.push("", content, "</pi-subdir-context>");
  return lines.join("\n");
}

function truncateContext(text: string, maxBytes: number, maxLines: number): string {
  const notice = "\n[pi-subdir-context: source truncated at the safety limit]\n</pi-subdir-context>";
  const withoutClosing = text.endsWith("</pi-subdir-context>")
    ? text.slice(0, -"</pi-subdir-context>".length)
    : text;
  let selected = withoutClosing.split("\n").slice(0, Math.max(1, maxLines - 2)).join("\n");
  const byteBudget = Math.max(0, maxBytes - Buffer.byteLength(notice));
  if (Buffer.byteLength(selected) > byteBudget) {
    selected = Buffer.from(selected).subarray(0, byteBudget).toString("utf8").replace(/\uFFFD$/, "");
  }
  return selected + notice;
}

function countLines(text: string): number {
  return text ? text.split("\n").length : 0;
}

function emptyBatch(): ContextBatch {
  return { contexts: [], text: "", truncated: false };
}
