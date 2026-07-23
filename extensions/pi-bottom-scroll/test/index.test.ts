import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

import piBottomScroll from "../index.ts";

class TestComponent implements Component {
	children: Component[];
	private readonly lines: string[];

	constructor(lines: string[] = [], children: Component[] = []) {
		this.lines = lines;
		this.children = children;
	}

	render(width: number): string[] {
		return [...this.lines, ...this.children.flatMap((child) => child.render(width))];
	}

	invalidate(): void {}
}

class TestTerminal {
	columns = 80;
	rows = 8;
	readonly writes: string[] = [];

	write(data: string): void {
		this.writes.push(data);
	}
}

class TestTui {
	children: Component[];
	terminal = new TestTerminal();
	focusedComponent: Component;
	readonly requests: boolean[] = [];
	stopCalls = 0;

	constructor() {
		const editor = new TestComponent(["editor"]);
		this.focusedComponent = editor;
		this.children = [
			new TestComponent(Array.from({ length: 10 }, (_value, index) => `h${index}`)),
			new TestComponent(),
			new TestComponent(),
			new TestComponent([], [editor]),
			new TestComponent(),
			new TestComponent(["footer"]),
		];
	}

	render(width: number): string[] {
		return this.children.flatMap((child) => child.render(width));
	}

	requestRender(force = false): void {
		this.requests.push(force);
	}

	stop(): void {
		this.stopCalls += 1;
	}

	hasOverlay(): boolean {
		return false;
	}
}

type ExtensionHandler = (event: unknown, context: unknown) => unknown;
type TerminalInputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

class ExtensionHarness {
	readonly handlers = new Map<string, ExtensionHandler>();

	on(event: string, handler: ExtensionHandler): void {
		this.handlers.set(event, handler);
	}
}

function createSessionHarness(): {
	harness: ExtensionHarness;
	tui: TestTui;
	context: object;
	getInputHandler: () => TerminalInputHandler | undefined;
	getUnsubscribeCount: () => number;
	getWidget: () => (Component & { dispose?(): void }) | undefined;
} {
	const harness = new ExtensionHarness();
	const tui = new TestTui();
	let inputHandler: TerminalInputHandler | undefined;
	let unsubscribeCount = 0;
	let widget: (Component & { dispose?(): void }) | undefined;
	const context = {
		mode: "tui",
		ui: {
			setWidget: (
				_key: string,
				content: ((runtimeTui: TUI) => Component & { dispose?(): void }) | undefined,
			): void => {
				if (!content) return;
				widget = content(tui as unknown as TUI);
				const below = tui.children[4] as TestComponent;
				below.children.push(widget);
			},
			onTerminalInput: (handler: TerminalInputHandler): (() => void) => {
				inputHandler = handler;
				let unsubscribed = false;
				return () => {
					if (unsubscribed) return;
					unsubscribed = true;
					unsubscribeCount += 1;
				};
			},
		},
	};
	piBottomScroll(harness as unknown as ExtensionAPI);
	return {
		harness,
		tui,
		context,
		getInputHandler: () => inputHandler,
		getUnsubscribeCount: () => unsubscribeCount,
		getWidget: () => widget,
	};
}

test("extension captures the live TUI, subscribes to terminal input, and cleans up idempotently", async () => {
	const session = createSessionHarness();
	await session.harness.handlers.get("session_start")?.({}, session.context);
	assert.equal(Object.hasOwn(session.tui, "render"), true);
	assert.equal(session.tui.terminal.writes.length, 1);
	assert.match(session.tui.terminal.writes[0]!, /1049h.*1007h/);

	session.tui.render(80);
	assert.deepEqual(session.getInputHandler()?.("\x1b[A"), { consume: true });

	session.getWidget()?.dispose?.();
	await session.harness.handlers.get("session_shutdown")?.({}, session.context);
	await session.harness.handlers.get("session_shutdown")?.({}, session.context);
	assert.equal(session.getUnsubscribeCount(), 1);
	assert.equal(Object.hasOwn(session.tui, "render"), false);
	assert.equal(session.tui.terminal.writes.length, 2);
	assert.match(session.tui.terminal.writes[1]!, /1007l.*1049l/);
});

test("wrapped TUI.stop restores extension modes even without session_shutdown", async () => {
	const session = createSessionHarness();
	await session.harness.handlers.get("session_start")?.({}, session.context);
	session.tui.stop();
	assert.equal(session.tui.stopCalls, 1);
	assert.equal(session.tui.terminal.writes.length, 2);
	assert.equal(Object.hasOwn(session.tui, "stop"), false);
	assert.equal(session.getUnsubscribeCount(), 1);
});
