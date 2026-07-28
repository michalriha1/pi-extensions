import {
	INTENT_GROUP_FIELD,
	INTENT_GROUP_TEXT_FIELD,
	INTENT_KIND_FIELD,
	INTENT_KINDS,
	INTENT_TEXT_FIELD,
} from "./logic.ts";

/**
 * Tools whose parameter schema gains the intent field.
 *
 * Only `bash` is enabled by default: every other built-in is already decidable
 * from its arguments (`read`/`grep`/`find`/`ls` are always exploration,
 * `edit`/`write` always mutation), so intent there would spend tokens without
 * changing a single grouping decision. Add names here to widen the set.
 */
export const INTENT_TOOL_NAMES: readonly string[] = ["bash"];

/**
 * Appended to the system prompt while at least one schema carries the field.
 * Pi cannot attach `promptGuidelines` to tools this extension does not own, so
 * the guidance is chained onto the turn's system prompt instead.
 */
export const INTENT_PROMPT_GUIDELINE = `Set \`${INTENT_KIND_FIELD}\` on every tool call that declares it: "explore" when the call only inspects state, "modify" when it changes state or has any other side effect, and "modify" when unsure. For every bash call, set \`${INTENT_TEXT_FIELD}\` to a concise neutral action phrase such as "Inspect repository status" or "Copy URL to clipboard". When two or more consecutive modifying bash calls serve one goal, also set the same short machine identifier in \`${INTENT_GROUP_FIELD}\` and the same neutral goal phrase in \`${INTENT_GROUP_TEXT_FIELD}\` on every call; keep \`${INTENT_TEXT_FIELD}\` specific to each command. Do not set group fields on exploration calls.`;

const INTENT_KIND_SCHEMA = {
	type: "string",
	enum: [...INTENT_KINDS],
	description:
		'Whether this call only inspects state ("explore") or changes it ("modify"). Used for transcript grouping. Use "modify" when unsure.',
} as const;

const INTENT_TEXT_SCHEMAS = {
	[INTENT_TEXT_FIELD]: {
		type: "string",
		description:
			'Concise neutral action phrase for a bash call, for example "Inspect repository status" or "Copy URL to clipboard".',
	},
	[INTENT_GROUP_FIELD]: {
		type: "string",
		description:
			"Short shared machine identifier for consecutive modifying bash calls with one goal.",
	},
	[INTENT_GROUP_TEXT_FIELD]: {
		type: "string",
		description:
			"Concise neutral heading shared by every modifying bash call in the same intent group.",
	},
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Add the intent field to a TypeBox/JSON-Schema object in place, and report
 * whether the schema now carries it.
 *
 * Pi hands out `definition.parameters` by reference and the agent passes that
 * same object to the provider, so mutation is enough to make the field visible
 * to the model. Nothing is added to `required`: a call that omits it stays
 * valid and falls back to deterministic classification.
 */
export function injectIntentSchema(parameters: unknown): boolean {
	if (!isRecord(parameters) || parameters.type !== "object") return false;
	const properties = parameters.properties;
	if (!isRecord(properties)) return false;
	if (!(INTENT_KIND_FIELD in properties))
		properties[INTENT_KIND_FIELD] = { ...INTENT_KIND_SCHEMA };
	for (const [field, schema] of Object.entries(INTENT_TEXT_SCHEMAS)) {
		if (!(field in properties)) properties[field] = { ...schema };
	}
	return true;
}

/**
 * Inject into every listed tool that is a pi built-in, and report whether any
 * tool now carries the field. Foreign tools are skipped because their arguments
 * are forwarded verbatim to an MCP server or another extension that may reject
 * unknown fields.
 */
export function injectIntentSchemas(
	tools: readonly { name: string; parameters: unknown; sourceInfo?: { source?: string } }[],
	names: readonly string[] = INTENT_TOOL_NAMES,
): boolean {
	const wanted = new Set(names.map((name) => name.toLowerCase()));
	let injected = false;
	for (const tool of tools) {
		if (!wanted.has(tool.name.toLowerCase())) continue;
		if (tool.sourceInfo?.source !== undefined && tool.sourceInfo.source !== "builtin") continue;
		if (injectIntentSchema(tool.parameters)) injected = true;
	}
	return injected;
}
