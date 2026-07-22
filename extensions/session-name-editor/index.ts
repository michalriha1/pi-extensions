import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { addSessionNameToTopBorder } from "./logic.ts";

export default function sessionNameEditorExtension(pi: ExtensionAPI): void {
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
