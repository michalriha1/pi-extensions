import { parse } from "yaml";

import type { SkillMetadata } from "./types.ts";

interface FrontmatterResult {
  data: Record<string, unknown>;
}

export function parseFrontmatter(content: string): FrontmatterResult {
  const normalized = content.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---\n") && !normalized.startsWith("---\r\n")) {
    return { data: {} };
  }

  const lines = normalized.split(/\r?\n/);
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closing < 0) return { data: {} };

  try {
    const parsed = parse(lines.slice(1, closing).join("\n"));
    return { data: isRecord(parsed) ? parsed : {} };
  } catch {
    return { data: {} };
  }
}

export function parseSkillMetadata(content: string): SkillMetadata | undefined {
  const { data } = parseFrontmatter(content);
  const name = typeof data.name === "string" ? data.name.trim() : "";
  const description = typeof data.description === "string" ? data.description.trim() : "";
  if (!name || !description) return undefined;

  const paths = normalizePaths(data.paths);
  return paths === undefined ? { name, description } : { name, description, paths };
}

function normalizePaths(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const path = value.trim();
    return path ? [path] : [];
  }
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
