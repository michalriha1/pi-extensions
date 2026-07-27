import { INTENT_FIELD, INTENT_KIND_FIELD, INTENT_KINDS, INTENT_MAX_LENGTH } from "./logic.ts";

/**
 * Tools whose parameter schema gains the intent fields.
 *
 * Only `bash` is enabled by default: every other built-in is already decidable
 * from its arguments (`read`/`grep`/`find`/`ls` are always exploration,
 * `edit`/`write` always mutation), so intent there would spend tokens without
 * changing a single grouping decision. Add names here to widen the set.
 */
export const INTENT_TOOL_NAMES: readonly string[] = ["bash"];

/**
 * Appended to the system prompt while at least one schema carries the fields.
 * Pi cannot attach `promptGuidelines` to tools this extension does not own, so
 * the guidance is chained onto the turn's system prompt instead.
 */
export const INTENT_PROMPT_GUIDELINE = [
	"Tool call intent:",
	`- Tools whose schema declares \`${INTENT_KIND_FIELD}\` and \`${INTENT_FIELD}\` are rendered as a grouped transcript. Set both fields on every call to those tools.`,
	`- \`${INTENT_KIND_FIELD}\`: "explore" when the call only inspects state, "modify" when it changes state, starts a build, or has any other side effect. When unsure, use "modify".`,
	`- \`${INTENT_FIELD}\`: one short present-participle phrase describing why you are making the call, at most ${INTENT_MAX_LENGTH} characters, for example "Checking which tests cover the parser".`,
	`- Never restate the command in \`${INTENT_FIELD}\`, never include secrets or credentials, and never label a state-changing call as "explore".`,
].join("\n");

const INTENT_KIND_SCHEMA = {
	type: "string",
	enum: [...INTENT_KINDS],
	description:
		'Whether this call only inspects state ("explore") or changes it ("modify"). Used for transcript grouping. Use "modify" when unsure.',
} as const;

const INTENT_SCHEMA = {
	type: "string",
	maxLength: INTENT_MAX_LENGTH,
	description: `Short phrase describing why you are making this call, for example "Checking which tests cover the parser". At most ${INTENT_MAX_LENGTH} characters. No secrets.`,
} as const;

export type IntentSchemaInjection = "injected" | "already-present" | "unsupported";

export interface IntentToolSchema {
	name: string;
	parameters: unknown;
	sourceInfo?: { source?: string };
}

export interface IntentInjectionReport {
	injected: string[];
	alreadyPresent: string[];
	unsupported: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Add the intent fields to a TypeBox/JSON-Schema object in place.
 *
 * Pi hands out `definition.parameters` by reference and the agent passes that
 * same object to the provider, so mutation is enough to make the fields visible
 * to the model. Nothing is added to `required`: a call that omits them stays
 * valid and falls back to deterministic classification.
 */
export function injectIntentSchema(parameters: unknown): IntentSchemaInjection {
	if (!isRecord(parameters) || parameters.type !== "object") return "unsupported";
	const properties = parameters.properties;
	if (!isRecord(properties)) return "unsupported";
	if (INTENT_FIELD in properties || INTENT_KIND_FIELD in properties) return "already-present";
	properties[INTENT_KIND_FIELD] = { ...INTENT_KIND_SCHEMA };
	properties[INTENT_FIELD] = { ...INTENT_SCHEMA };
	return "injected";
}

/**
 * Inject into every listed tool that is a pi built-in. Foreign tools are skipped
 * because their arguments are forwarded verbatim to an MCP server or another
 * extension that may reject unknown fields.
 */
export function injectIntentSchemas(
	tools: readonly IntentToolSchema[],
	names: readonly string[] = INTENT_TOOL_NAMES,
): IntentInjectionReport {
	const wanted = new Set(names.map((name) => name.toLowerCase()));
	const report: IntentInjectionReport = { injected: [], alreadyPresent: [], unsupported: [] };
	for (const tool of tools) {
		if (!wanted.has(tool.name.toLowerCase())) continue;
		if (tool.sourceInfo?.source !== undefined && tool.sourceInfo.source !== "builtin") {
			report.unsupported.push(tool.name);
			continue;
		}
		switch (injectIntentSchema(tool.parameters)) {
			case "injected":
				report.injected.push(tool.name);
				break;
			case "already-present":
				report.alreadyPresent.push(tool.name);
				break;
			case "unsupported":
				report.unsupported.push(tool.name);
				break;
		}
	}
	return report;
}

/** True when at least one tool currently advertises the intent fields. */
export function hasIntentSchema(report: IntentInjectionReport): boolean {
	return report.injected.length > 0 || report.alreadyPresent.length > 0;
}
