import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { INTENT_PROMPT_GUIDELINE, injectIntentSchemas } from "./intent.ts";
import { installToolCallGroupingPatch } from "./patch.ts";

const ACTIVE_THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

function getActiveTheme(): Theme | undefined {
	return (globalThis as Record<symbol, Theme | undefined>)[ACTIVE_THEME_KEY];
}

export default function piToolDisplayExtension(pi: ExtensionAPI): void {
	let currentTheme: Theme | undefined;
	let patch: ReturnType<typeof installToolCallGroupingPatch> | undefined;
	let cancelActiveSelection: (() => void) | undefined;

	// Re-applied every turn: pi rebuilds tool definitions when tools are
	// registered, reloaded, or re-activated, and injection is idempotent.
	const applyIntentSchemas = (): boolean => injectIntentSchemas(pi.getAllTools());

	const cancelSelection = () => {
		cancelActiveSelection?.();
		cancelActiveSelection = undefined;
		patch?.cancelSelection();
	};

	pi.registerShortcut("ctrl+shift+l", {
		description: "Expand a collapsed tool call",
		handler: async (ctx) => {
			if (ctx.mode !== "tui" || cancelActiveSelection) return;
			const labels = patch?.beginSelection() ?? [];
			if (labels.length === 0) {
				patch?.cancelSelection();
				ctx.ui.notify("No collapsed tool calls", "info");
				return;
			}

			const validLabels = new Set(labels);
			let active = true;
			try {
				const selected = await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
					let input = "";
					const instruction = new Text("", 1, 0);
					const finish = (label: string | undefined) => {
						if (!active) return;
						active = false;
						done(label);
					};
					cancelActiveSelection = () => finish(undefined);
					const updateInstruction = () => {
						instruction.setText(
							theme.fg("dim", `Type a tool label${input ? `: ${input}` : ""} · cancel with configured selection key`),
						);
					};
					updateInstruction();
					return {
						render: (width) => instruction.render(width),
						invalidate: () => instruction.invalidate(),
						handleInput: (data) => {
							if (keybindings.matches(data, "tui.select.cancel")) {
								finish(undefined);
								return;
							}
							if (!/^[a-z]+$/.test(data)) return;
							input += data;
							if (validLabels.has(input)) {
								finish(input);
								return;
							}
							if (!labels.some((label) => label.startsWith(input))) input = "";
							updateInstruction();
							tui.requestRender();
						},
					};
				});
				if (selected) patch?.expandSelection(selected);
			} finally {
				active = false;
				cancelActiveSelection = undefined;
				patch?.cancelSelection();
			}
		},
	});

	// Intent costs tokens on every owned tool call, so it is only requested where
	// the grouped renderer can actually show it.
	pi.on("before_agent_start", (event, ctx) => {
		if (ctx.mode !== "tui" || !applyIntentSchemas()) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${INTENT_PROMPT_GUIDELINE}` };
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		applyIntentSchemas();
		cancelSelection();
		currentTheme = ctx.ui.theme;
		patch = installToolCallGroupingPatch({ getTheme: () => currentTheme ?? getActiveTheme() });
		patch.reset();
		if (!patch.installed && patch.reason) ctx.ui.notify(`Tool call grouping disabled: ${patch.reason}`, "warning");
	});

	pi.on("session_shutdown", () => {
		if (!patch) return;
		cancelSelection();
		currentTheme = undefined;
		patch.restore();
		patch = undefined;
	});
}

export * from "./intent.ts";
export * from "./logic.ts";
export { installToolCallGroupingPatch } from "./patch.ts";
