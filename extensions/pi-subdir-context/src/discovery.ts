import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpathSync } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import createIgnore from "ignore";

import { parseSkillMetadata } from "./frontmatter.ts";
import { ancestorsThroughParent, isInside, toPosixPath } from "./path-utils.ts";
import type { ContextSource } from "./types.ts";

const execFileAsync = promisify(execFile);
const CONFIG_ROOT_NAMES = [".pi", ".claude", ".cursor"] as const;
const INSTRUCTION_FILES = ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"] as const;

export type ConfigIgnoreChecker = (configRoot: string, projectRoot: string) => Promise<boolean>;

export async function gitCheckIgnored(configRoot: string, projectRoot: string): Promise<boolean> {
  const relative = toPosixPath(path.relative(projectRoot, configRoot));
  try {
    await execFileAsync("git", ["check-ignore", "-q", "--", relative], {
      cwd: projectRoot,
      timeout: 2_000,
    });
    return true;
  } catch {
    return false;
  }
}

export class ContextDiscovery {
  readonly projectRoot: string;
  private readonly isIgnoredConfigRoot: ConfigIgnoreChecker;
  private readonly selectedRootCache = new Map<string, Promise<string | undefined>>();
  private readonly rootSourceCache = new Map<string, Promise<ContextSource[]>>();
  private readonly ignoreCache = new Map<string, Promise<boolean>>();

  constructor(projectRoot: string, isIgnoredConfigRoot: ConfigIgnoreChecker = gitCheckIgnored) {
    this.projectRoot = realpathSync(projectRoot);
    this.isIgnoredConfigRoot = isIgnoredConfigRoot;
  }

  resetCaches(): void {
    this.selectedRootCache.clear();
    this.rootSourceCache.clear();
    this.ignoreCache.clear();
  }

  async discover(targetFile: string): Promise<ContextSource[]> {
    const sources: ContextSource[] = [];
    for (const directory of ancestorsThroughParent(this.projectRoot, targetFile)) {
      const configRoot = await this.selectConfigRoot(directory);
      if (!configRoot) continue;
      const candidates = await this.sourcesInRoot(configRoot, directory);
      for (const source of candidates) {
        if (source.kind !== "scoped-skill" || skillApplies(source, targetFile)) sources.push(source);
      }
    }
    return sources;
  }

  isPotentialContextFile(targetFile: string): boolean {
    if (!isInside(this.projectRoot, targetFile)) return false;
    const parts = path.relative(this.projectRoot, targetFile).split(path.sep);

    for (let index = 0; index < parts.length; index += 1) {
      const configName = parts[index];
      if (!CONFIG_ROOT_NAMES.includes(configName as (typeof CONFIG_ROOT_NAMES)[number])) continue;
      const inside = parts.slice(index + 1);
      if (inside.length === 1 && INSTRUCTION_FILES.includes(inside[0] as (typeof INSTRUCTION_FILES)[number])) {
        return true;
      }
      if (inside.length === 3 && inside[0] === "skills" && inside[2] === "SKILL.md") return true;
      if (
        configName === ".cursor" &&
        inside[0] === "rules" &&
        inside.length >= 2 &&
        (inside.at(-1)?.endsWith(".md") || inside.at(-1)?.endsWith(".mdc"))
      ) {
        return true;
      }
    }
    return false;
  }

  private selectConfigRoot(directory: string): Promise<string | undefined> {
    const cached = this.selectedRootCache.get(directory);
    if (cached) return cached;

    const selection = this.findSelectedConfigRoot(directory);
    this.selectedRootCache.set(directory, selection);
    return selection;
  }

  private async findSelectedConfigRoot(directory: string): Promise<string | undefined> {
    for (const name of CONFIG_ROOT_NAMES) {
      const candidate = path.join(directory, name);
      try {
        if (!(await stat(candidate)).isDirectory()) continue;
      } catch {
        continue;
      }

      // Precedence is decided by existence. An ignored or escaping winner suppresses
      // lower-priority roots rather than allowing an accidental fallback.
      let canonical: string;
      try {
        canonical = await realpath(candidate);
      } catch {
        return undefined;
      }
      if (!isInside(this.projectRoot, canonical)) return undefined;
      if (await this.isIgnored(canonical)) return undefined;
      return canonical;
    }
    return undefined;
  }

  private isIgnored(configRoot: string): Promise<boolean> {
    const cached = this.ignoreCache.get(configRoot);
    if (cached) return cached;
    const result = this.isIgnoredConfigRoot(configRoot, this.projectRoot).catch(() => false);
    this.ignoreCache.set(configRoot, result);
    return result;
  }

  private sourcesInRoot(configRoot: string, scopeDirectory: string): Promise<ContextSource[]> {
    const cached = this.rootSourceCache.get(configRoot);
    if (cached) return cached;
    const scan = this.scanRoot(configRoot, scopeDirectory);
    this.rootSourceCache.set(configRoot, scan);
    return scan;
  }

  private async scanRoot(configRoot: string, scopeDirectory: string): Promise<ContextSource[]> {
    const sources: ContextSource[] = [];
    const override = await this.fileSource(path.join(configRoot, "AGENTS.override.md"), configRoot, scopeDirectory, "instructions");
    if (override) {
      sources.push(override);
    } else {
      const agents = await this.fileSource(path.join(configRoot, "AGENTS.md"), configRoot, scopeDirectory, "instructions");
      if (agents) sources.push(agents);
    }

    const claude = await this.fileSource(path.join(configRoot, "CLAUDE.md"), configRoot, scopeDirectory, "instructions");
    if (claude) sources.push(claude);

    if (path.basename(configRoot) === ".cursor") {
      for (const rulePath of await markdownFilesRecursively(path.join(configRoot, "rules"))) {
        const rule = await this.fileSource(rulePath, configRoot, scopeDirectory, "cursor-rule");
        if (rule) sources.push(rule);
      }
    }

    const skillsDirectory = path.join(configRoot, "skills");
    let skillDirectories: string[] = [];
    try {
      skillDirectories = (await readdir(skillsDirectory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git")
        .map((entry) => entry.name)
        .sort();
    } catch {
      // Missing or unreadable skills directories are normal.
    }

    for (const skillDirectory of skillDirectories) {
      const skillPath = path.join(skillsDirectory, skillDirectory, "SKILL.md");
      const skill = await this.fileSource(skillPath, configRoot, scopeDirectory, "scoped-skill");
      if (!skill) continue;
      try {
        const metadata = parseSkillMetadata(await readFile(skill.realPath, "utf8"));
        if (metadata) sources.push({ ...skill, skill: metadata });
      } catch {
        // Invalid/unreadable skills are not context sources.
      }
    }

    return sources;
  }

  private async fileSource(
    candidate: string,
    configRoot: string,
    scopeDirectory: string,
    kind: ContextSource["kind"],
  ): Promise<ContextSource | undefined> {
    try {
      if (!(await stat(candidate)).isFile()) return undefined;
      const canonical = await realpath(candidate);
      if (!isInside(this.projectRoot, canonical)) return undefined;
      return { path: candidate, realPath: canonical, scopeDirectory, configRoot, kind };
    } catch {
      return undefined;
    }
  }
}

function skillApplies(source: ContextSource, targetFile: string): boolean {
  const patterns = source.skill?.paths;
  if (patterns === undefined) return true;
  if (patterns.length === 0) return false;

  const relative = toPosixPath(path.relative(source.scopeDirectory, targetFile));
  if (!relative || relative.startsWith("../")) return false;
  try {
    return createIgnore().add(patterns).ignores(relative);
  } catch {
    return false;
  }
}

async function markdownFilesRecursively(directory: string): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await markdownFilesRecursively(candidate)));
    } else if (entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".mdc"))) {
      files.push(candidate);
    }
  }
  return files;
}
