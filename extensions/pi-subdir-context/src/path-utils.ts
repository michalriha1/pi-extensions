import { access, realpath } from "node:fs/promises";
import path from "node:path";

export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

export function stripPathSigil(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

/**
 * Resolve a path through its deepest existing ancestor. This rejects both
 * lexical `..` escapes and symlink escapes, while still supporting new files.
 */
export async function resolveProjectPath(
  projectRoot: string,
  inputPath: string,
): Promise<string | undefined> {
  const cleaned = stripPathSigil(inputPath.trim());
  if (!cleaned) return undefined;

  const absolute = path.resolve(projectRoot, cleaned);
  const missingParts: string[] = [];
  let existing = absolute;

  while (true) {
    try {
      await access(existing);
      break;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return undefined;
      missingParts.unshift(path.basename(existing));
      existing = parent;
    }
  }

  let canonical: string;
  try {
    canonical = await realpath(existing);
  } catch {
    return undefined;
  }

  const resolved = path.resolve(canonical, ...missingParts);
  return isInside(projectRoot, resolved) ? resolved : undefined;
}

export function hasSkippedProjectSegment(projectRoot: string, target: string): boolean {
  const relative = path.relative(projectRoot, target);
  return relative.split(path.sep).some((part) => part === ".git" || part === "node_modules");
}

export function ancestorsThroughParent(projectRoot: string, targetFile: string): string[] {
  const parent = path.dirname(targetFile);
  if (!isInside(projectRoot, parent)) return [];

  const relative = path.relative(projectRoot, parent);
  if (!relative) return [projectRoot];

  const ancestors = [projectRoot];
  let current = projectRoot;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    ancestors.push(current);
  }
  return ancestors;
}
