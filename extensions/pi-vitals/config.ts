import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { IconSet } from "./icons.js";
import { getDefaultColors } from "./theme.js";
import type {
  ColorScheme,
  ColorValue,
  PowerlineUserConfig,
  SemanticColor,
  StatusLineSegmentId,
  StatusLineSegmentOptions,
} from "./types.js";

const DEFAULT_LEFT_SEGMENTS: readonly StatusLineSegmentId[] = [
  "pi", "separator", "model", "thinking", "ext_status", "separator", "path", "git", "separator",
  "token_total", "token_in", "token_out", "cache_read", "cache_write",
];
const DEFAULT_RIGHT_SEGMENTS: readonly StatusLineSegmentId[] = ["separator", "context_pct"];
const SEGMENT_IDS = new Set([
  "pi", "model", "path", "git", "token_in", "token_out", "token_total", "cost", "context_pct",
  "context_total", "cache_read", "cache_write", "thinking", "ext_status", "separator",
]);
const COLOR_NAMES = new Set([
  "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted", "dim", "text",
  "thinkingText", "userMessageText", "customMessageText", "customMessageLabel", "toolTitle", "toolOutput",
  "mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder",
  "mdHr", "mdListBullet", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "syntaxComment", "syntaxKeyword",
  "syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator",
  "syntaxPunctuation", "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh",
  "thinkingXhigh", "bashMode",
]);
const SEMANTIC_COLORS = new Set<SemanticColor>([
  "pi", "model", "path", "git", "gitDirty", "gitClean", "thinking", "thinkingHigh", "context", "contextWarn",
  "contextError", "cost", "tokens", "separator",
]);
const ICON_NAMES = new Set<keyof IconSet>([
  "pi", "model", "folder", "repo", "branch", "git", "tokens", "contextPct", "contextTotal", "cost",
  "cacheRead", "cacheWrite", "input", "output", "thinking", "separator", "auto",
]);

const DEFAULT_SEGMENT_OPTIONS: StatusLineSegmentOptions = {
  model: { showThinkingLevel: false },
  path: { mode: "basename" },
  git: { showBranch: true, showStaged: true, showUnstaged: true, showUntracked: true },
  context_pct: { showAutoIcon: false },
};

export interface EffectiveConfig {
  readonly leftSegments: readonly StatusLineSegmentId[];
  readonly rightSegments: readonly StatusLineSegmentId[];
  readonly colors: ColorScheme;
  readonly segmentOptions: StatusLineSegmentOptions;
  readonly icons: Partial<IconSet>;
}
export interface ConfigState {
  readonly userConfig: PowerlineUserConfig | null;
  readonly effectiveConfig: EffectiveConfig;
  readonly configFound: boolean;
  readonly diagnostics: readonly string[];
}
export interface ConfigReader { exists(path: string): boolean; read(path: string): string; }
export interface ConfigController {
  getState(): ConfigState;
  loadUserConfig(): PowerlineUserConfig | null;
  getEffectiveConfig(): EffectiveConfig;
  clear(): void;
}

type JsonObject = Record<string, unknown>;
function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function sanitizeDiagnostic(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "�");
}
function reportUnknownOptions(object: JsonObject, path: string, names: readonly string[], diagnostics: string[]): void {
  const known = new Set(names);
  for (const name of Object.keys(object)) if (!known.has(name)) diagnostics.push(`${path}.${name} is not supported`);
}
function getConfigPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  return join(homeDir, ".pi", "agent", "powerline.json");
}
function freezeSegmentOptions(options: StatusLineSegmentOptions): StatusLineSegmentOptions {
  return Object.freeze({
    ...options,
    ...(options.model && { model: Object.freeze({ ...options.model }) }),
    ...(options.path && { path: Object.freeze({ ...options.path }) }),
    ...(options.git && { git: Object.freeze({ ...options.git }) }),
    ...(options.thinking && { thinking: Object.freeze({ ...options.thinking }) }),
    ...(options.context_pct && { context_pct: Object.freeze({ ...options.context_pct }) }),
  });
}
function validateSegments(value: unknown, name: string, diagnostics: string[]): StatusLineSegmentId[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"
    && (SEGMENT_IDS.has(item) || item.startsWith("text:")))) {
    diagnostics.push(`${name} must be an array of known segment names or text:<value> entries`);
    return undefined;
  }
  return value as StatusLineSegmentId[];
}
function validateColors(value: unknown, diagnostics: string[]): ColorScheme | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    diagnostics.push("colors must be an object");
    return undefined;
  }
  const colors: ColorScheme = {};
  for (const [name, color] of Object.entries(value)) {
    if (!SEMANTIC_COLORS.has(name as SemanticColor)) {
      diagnostics.push(`colors.${name} is not a supported semantic color`);
    } else if (typeof color !== "string" || (!COLOR_NAMES.has(color) && !/^#[0-9a-fA-F]{6}$/.test(color))) {
      diagnostics.push(`colors.${name} must be a theme color name or a six-digit #RRGGBB value`);
    } else {
      colors[name as SemanticColor] = color as ColorValue;
    }
  }
  return colors;
}
function booleanOption(object: JsonObject, key: string, path: string, diagnostics: string[]): boolean | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    diagnostics.push(`${path}.${key} must be a boolean`);
    return undefined;
  }
  return value;
}
function validateOptions(value: unknown, diagnostics: string[]): StatusLineSegmentOptions | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    diagnostics.push("segmentOptions must be an object");
    return undefined;
  }
  const result: StatusLineSegmentOptions = {};
  const optionNames = new Set(["model", "path", "git", "thinking", "context_pct"]);
  for (const name of Object.keys(value)) if (!optionNames.has(name)) diagnostics.push(`segmentOptions.${name} is not supported`);

  if (value.model !== undefined) {
    if (!isObject(value.model)) diagnostics.push("segmentOptions.model must be an object");
    else {
      reportUnknownOptions(value.model, "segmentOptions.model", ["showThinkingLevel"], diagnostics);
      const showThinkingLevel = booleanOption(value.model, "showThinkingLevel", "segmentOptions.model", diagnostics);
      result.model = showThinkingLevel === undefined ? {} : { showThinkingLevel };
    }
  }
  if (value.path !== undefined) {
    if (!isObject(value.path)) diagnostics.push("segmentOptions.path must be an object");
    else {
      reportUnknownOptions(value.path, "segmentOptions.path", ["mode", "maxLength"], diagnostics);
      const mode = value.path.mode;
      const maxLength = value.path.maxLength;
      const pathOptions: NonNullable<StatusLineSegmentOptions["path"]> = {};
      if (mode !== undefined && mode !== "basename" && mode !== "abbreviated" && mode !== "full") diagnostics.push("segmentOptions.path.mode must be basename, abbreviated, or full");
      else if (mode !== undefined) pathOptions.mode = mode;
      if (maxLength !== undefined && (!Number.isInteger(maxLength) || (maxLength as number) < 1)) diagnostics.push("segmentOptions.path.maxLength must be a positive integer");
      else if (maxLength !== undefined) pathOptions.maxLength = maxLength as number;
      result.path = pathOptions;
    }
  }
  if (value.git !== undefined) {
    if (!isObject(value.git)) diagnostics.push("segmentOptions.git must be an object");
    else {
      reportUnknownOptions(value.git, "segmentOptions.git", ["showBranch", "showStaged", "showUnstaged", "showUntracked"], diagnostics);
      const git: NonNullable<StatusLineSegmentOptions["git"]> = {};
      for (const key of ["showBranch", "showStaged", "showUnstaged", "showUntracked"] as const) {
        const option = booleanOption(value.git, key, "segmentOptions.git", diagnostics);
        if (option !== undefined) git[key] = option;
      }
      result.git = git;
    }
  }
  if (value.thinking !== undefined) {
    if (!isObject(value.thinking)) diagnostics.push("segmentOptions.thinking must be an object");
    else {
      reportUnknownOptions(value.thinking, "segmentOptions.thinking", ["prefix"], diagnostics);
      if (value.thinking.prefix !== undefined && typeof value.thinking.prefix !== "string") diagnostics.push("segmentOptions.thinking.prefix must be a string");
      else result.thinking = value.thinking.prefix === undefined ? {} : { prefix: value.thinking.prefix };
    }
  }
  if (value.context_pct !== undefined) {
    if (!isObject(value.context_pct)) diagnostics.push("segmentOptions.context_pct must be an object");
    else {
      reportUnknownOptions(value.context_pct, "segmentOptions.context_pct", ["showAutoIcon"], diagnostics);
      const showAutoIcon = booleanOption(value.context_pct, "showAutoIcon", "segmentOptions.context_pct", diagnostics);
      result.context_pct = showAutoIcon === undefined ? {} : { showAutoIcon };
    }
  }
  return result;
}
function validateIcons(value: unknown, diagnostics: string[]): Partial<IconSet> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    diagnostics.push("icons must be an object");
    return undefined;
  }
  const icons: Partial<IconSet> = {};
  for (const [name, icon] of Object.entries(value)) {
    if (!ICON_NAMES.has(name as keyof IconSet)) diagnostics.push(`icons.${name} is not a supported icon`);
    else if (typeof icon !== "string") diagnostics.push(`icons.${name} must be a string`);
    else icons[name as keyof IconSet] = icon;
  }
  return icons;
}
function validateConfig(value: unknown, diagnostics: string[]): PowerlineUserConfig | null {
  if (!isObject(value)) {
    diagnostics.push("configuration root must be a JSON object");
    return null;
  }
  const known = new Set(["leftSegments", "rightSegments", "colors", "segmentOptions", "icons"]);
  for (const name of Object.keys(value)) if (!known.has(name)) diagnostics.push(`${name} is not a supported configuration property`);
  return {
    leftSegments: validateSegments(value.leftSegments, "leftSegments", diagnostics),
    rightSegments: validateSegments(value.rightSegments, "rightSegments", diagnostics),
    colors: validateColors(value.colors, diagnostics),
    segmentOptions: validateOptions(value.segmentOptions, diagnostics),
    icons: validateIcons(value.icons, diagnostics),
  };
}

export function createConfigController(
  reader: ConfigReader = { exists: existsSync, read: (path) => readFileSync(path, "utf8") },
  configPath: () => string = getConfigPath,
): ConfigController {
  let cachedState: ConfigState | undefined;
  const getState = (): ConfigState => {
    if (cachedState) return cachedState;
    const diagnostics: string[] = [];
    const path = configPath();
    let configFound = false;
    let userConfig: PowerlineUserConfig | null = null;
    try {
      configFound = reader.exists(path);
      if (configFound) userConfig = validateConfig(JSON.parse(reader.read(path)) as unknown, diagnostics);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      diagnostics.push(sanitizeDiagnostic(`could not parse ${path}: ${detail}`));
    }
    const effectiveConfig: EffectiveConfig = Object.freeze({
      leftSegments: Object.freeze([...(userConfig?.leftSegments ?? DEFAULT_LEFT_SEGMENTS)]),
      rightSegments: Object.freeze([...(userConfig?.rightSegments ?? DEFAULT_RIGHT_SEGMENTS)]),
      colors: Object.freeze({ ...getDefaultColors(), ...userConfig?.colors }),
      segmentOptions: freezeSegmentOptions({
        ...DEFAULT_SEGMENT_OPTIONS,
        ...userConfig?.segmentOptions,
        model: { ...DEFAULT_SEGMENT_OPTIONS.model, ...userConfig?.segmentOptions?.model },
        path: { ...DEFAULT_SEGMENT_OPTIONS.path, ...userConfig?.segmentOptions?.path },
        git: { ...DEFAULT_SEGMENT_OPTIONS.git, ...userConfig?.segmentOptions?.git },
        context_pct: { ...DEFAULT_SEGMENT_OPTIONS.context_pct, ...userConfig?.segmentOptions?.context_pct },
      }),
      icons: Object.freeze({ ...(userConfig?.icons ?? {}) }),
    });
    cachedState = Object.freeze({ userConfig, effectiveConfig, configFound, diagnostics: Object.freeze(diagnostics) });
    return cachedState;
  };
  return {
    getState,
    loadUserConfig: () => getState().userConfig,
    getEffectiveConfig: () => getState().effectiveConfig,
    clear() { cachedState = undefined; },
  };
}

const defaultConfigController = createConfigController();
export function loadUserConfig(): PowerlineUserConfig | null { return defaultConfigController.loadUserConfig(); }
export function clearUserConfigCache(): void { defaultConfigController.clear(); }
export function getEffectiveConfig(): EffectiveConfig { return defaultConfigController.getEffectiveConfig(); }
export function getConfigState(): ConfigState { return defaultConfigController.getState(); }
