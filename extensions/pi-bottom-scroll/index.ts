import { performance } from "node:perf_hooks";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

import { TerminalModes } from "./terminal-modes.ts";
import { createViewportRuntime, type ViewportRuntime } from "./viewport-runtime.ts";

const EXTENSION_ID = "pi-bottom-scroll";
const CAPTURE_WIDGET_KEY = `${EXTENSION_ID}:tui-capture`;

export type AlternateScrollDirection = "up" | "down";

/**
 * Decode the legacy cursor sequences emitted by DEC alternate-scroll mode (1007).
 * Kitty keyboard protocol keeps physical Up/Down keys on enhanced sequences while
 * wheel reports remain legacy sequences. Unsupported non-Kitty terminals cannot
 * distinguish physical arrows from wheel reports without SGR mouse capture.
 */
export function decodeAlternateScrollCursorSequence(data: string): AlternateScrollDirection | undefined {
	if (data === "\x1b[A" || data === "\x1bOA") return "up";
	if (data === "\x1b[B" || data === "\x1bOB") return "down";
	return undefined;
}

class CaptureWidget implements Component {
	private readonly onDispose: () => void;
	private disposed = false;

	constructor(onDispose: () => void) {
		this.onDispose = onDispose;
	}

	render(_width: number): string[] {
		return [];
	}

	invalidate(): void {}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.onDispose();
	}
}

export default function piBottomScroll(pi: ExtensionAPI): void {
	let cleanupActiveSession: () => void = () => {};

	pi.on("session_start", (_event, ctx) => {
		cleanupActiveSession();
		cleanupActiveSession = () => {};
		if (ctx.mode !== "tui") return;

		let viewport: ViewportRuntime | undefined;
		let terminalModes: TerminalModes | undefined;
		let unsubscribeInput: (() => void) | undefined;
		let cleaned = false;
		const cleanup = (): void => {
			if (cleaned) return;
			cleaned = true;
			unsubscribeInput?.();
			unsubscribeInput = undefined;
			viewport?.dispose();
			terminalModes?.deactivate();
			if (cleanupActiveSession === cleanup) cleanupActiveSession = () => {};
		};
		cleanupActiveSession = cleanup;

		const captureWidget = new CaptureWidget(cleanup);
		ctx.ui.setWidget(
			CAPTURE_WIDGET_KEY,
			(tui: TUI) => {
				viewport = createViewportRuntime(tui, captureWidget, cleanup);
				viewport.install();
				terminalModes = new TerminalModes(tui.terminal);
				terminalModes.activate();
				unsubscribeInput = ctx.ui.onTerminalInput((data) => {
					const direction = decodeAlternateScrollCursorSequence(data);
					if (!direction || !viewport) return undefined;
					const consumed = viewport.enqueueWheel(direction === "up" ? -1 : 1, performance.now());
					return consumed ? { consume: true } : undefined;
				});
				return captureWidget;
			},
			{ placement: "belowEditor" },
		);
		viewport?.requestCleanRender();
	});

	pi.on("session_shutdown", () => {
		cleanupActiveSession();
	});
}
