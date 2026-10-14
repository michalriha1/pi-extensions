import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Skill } from "@earendil-works/pi-coding-agent";

export type State = "on" | "name-only" | "user-invocable-only" | "off";
export type Policy = ReadonlyMap<string, State>;
const states = new Set<string>(["on", "name-only", "user-invocable-only", "off"]);
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Validate only the adapter's field; unrelated Claude settings are ignored. */
export function parsePolicy(text: string): Policy {
  const settings: unknown = JSON.parse(text);
  if (!object(settings)) throw new Error("settings must be an object");
  if (!Object.hasOwn(settings, "skillOverrides")) return new Map();
  const overrides = settings.skillOverrides;
  if (!object(overrides)) throw new Error("skillOverrides must be an object");
  const result = new Map<string, State>();
  for (const [name, state] of Object.entries(overrides)) {
    if (!name || typeof state !== "string" || !states.has(state)) {
      throw new Error("skillOverrides must map nonempty names to supported states");
    }
    result.set(name, state as State);
  }
  return result;
}

export class PolicyReader {
  private good = new Map<string, Policy>();
  private errors = new Map<string, string>();
  private warn: (message: string) => void;
  constructor(warn: (message: string) => void = console.warn) { this.warn = warn; }

  private read(path: string): Policy {
    try {
      let policy: Policy;
      try {
        policy = parsePolicy(readFileSync(path, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        policy = new Map(); // Deletion is an intentional removal, not a parse failure.
      }
      this.good.set(path, policy);
      this.errors.delete(path);
      return policy;
    } catch (error) {
      // Do not print file contents (other settings may contain secrets).
      const reason = error instanceof SyntaxError ? "invalid JSON" :
        (error as NodeJS.ErrnoException).code ?? "invalid skillOverrides schema";
      if (this.errors.get(path) !== reason) {
        this.errors.set(path, reason);
        this.warn(`[pi-claude-skill-policy] ${path}: ${reason}; retaining last good policy (empty if none).`);
      }
      return this.good.get(path) ?? new Map();
    }
  }

  refresh(cwd: string, trusted: boolean, configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")): Policy {
    const paths = [resolve(configDir, "settings.json")];
    // Trust is scoped to the host cwd; never walk to a parent/repository root.
    if (trusted) paths.push(join(cwd, ".claude/settings.json"), join(cwd, ".claude/settings.local.json"));
    const merged = new Map<string, State>();
    for (const path of paths) for (const [name, state] of this.read(path)) merged.set(name, state);
    return merged;
  }
}

/**
 * Claude keys skills by directory name or plugin-qualified name (`plugin:skill`);
 * Pi keys them by frontmatter name. Match the Pi name first, then the skill
 * directory name, each against exact keys before `plugin:`-stripped keys.
 */
export function stateFor(policy: Policy, name: string, filePath?: string): State {
  const ids = [name];
  if (filePath) ids.push(basename(dirname(filePath)));
  for (const id of ids) {
    const exact = policy.get(id);
    if (exact) return exact;
  }
  for (const id of ids) {
    for (const [key, state] of policy) {
      const colon = key.lastIndexOf(":");
      if (colon !== -1 && key.slice(colon + 1) === id) return state;
    }
  }
  return "on";
}

export function discoverySkills(skills: Skill[], policy: Policy): Skill[] {
  return skills.flatMap((skill) => {
    const state = stateFor(policy, skill.name, skill.filePath);
    if (skill.disableModelInvocation || state === "off" || state === "user-invocable-only") return [];
    // Pi requires a string description; empty text preserves its native name/path rendering.
    return [state === "name-only" ? { ...skill, description: "" } : skill];
  });
}

/** Match Pi 1.2.0's _expandSkillCommand exactly (literal space, no trim). */
export function skillCommandName(text: string): string | undefined {
  if (!text.startsWith("/skill:")) return undefined;
  const space = text.indexOf(" ");
  return space === -1 ? text.slice(7) : text.slice(7, space);
}
