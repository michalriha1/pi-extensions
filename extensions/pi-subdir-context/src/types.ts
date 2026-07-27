export type ContextKind = "instructions" | "cursor-rule" | "scoped-skill";

export interface SkillMetadata {
  name: string;
  description: string;
  paths?: string[];
}

export interface ContextSource {
  path: string;
  realPath: string;
  scopeDirectory: string;
  configRoot: string;
  kind: ContextKind;
  skill?: SkillMetadata;
}

export interface LoadedContext {
  source: ContextSource;
  text: string;
  truncated: boolean;
}

export interface ContextBatch {
  contexts: LoadedContext[];
  text: string;
  truncated: boolean;
}
