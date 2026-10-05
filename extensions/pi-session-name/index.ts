import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { addSessionNameToTopBorder } from "./logic.ts";

const renameSessionParameters = Type.Object({
	name: Type.String({ description: "Session display name; trimmed, nonblank, at most 200 characters, no control characters.", minLength: 1, maxLength: 200 }),
});
export type RenameSessionInput = Static<typeof renameSessionParameters>;

export default function piSessionNameExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "rename_session",
		label: "Rename session",
		description: "Rename the current Pi session using its supported naming API. Trims whitespace; requires 1–200 characters without control characters or line breaks. Returns the verified name. Does not rename other sessions.",
		promptSnippet: "Set and verify the current session display name",
		parameters: renameSessionParameters,
		async execute(_toolCallId, params, signal) {
			signal?.throwIfAborted();
			if (typeof params.name !== "string") throw new Error("Session name must be a string.");
			const name = params.name.trim();
			if (!name || [...name].length > 200 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(name)) {
				throw new Error("Session name must contain 1–200 characters without control characters or line breaks.");
			}
			pi.setSessionName(name);
			if (pi.getSessionName() !== name) throw new Error("Could not verify the requested session name.");
			return {
				content: [{ type: "text", text: `Session renamed to ${JSON.stringify(name)}.` }],
				details: { success: true, name },
			};
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		const previousFactory = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
			const editor = previousFactory?.(tui, editorTheme, keybindings) ?? new CustomEditor(tui, editorTheme, keybindings);
			const renderEditor = editor.render.bind(editor);

			editor.render = (width: number) =>
				addSessionNameToTopBorder(
					renderEditor(width),
					width,
					pi.getSessionName(),
					(label) => ctx.ui.theme.inverse(editor.borderColor?.(label) ?? label),
					(border) => editor.borderColor?.(border) ?? border,
				);

			return editor;
		});
	});
}

export { addSessionNameToTopBorder } from "./logic.ts";
