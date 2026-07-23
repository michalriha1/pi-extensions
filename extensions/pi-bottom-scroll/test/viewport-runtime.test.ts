import assert from "node:assert/strict";
import test from "node:test";

import type { Component, TUI } from "@earendil-works/pi-tui";

import { createViewportRuntime } from "../viewport-runtime.ts";

class Leaf implements Component {
	lines: string[];
	renderCalls = 0;

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(_width: number): string[] {
		this.renderCalls += 1;
		return [...this.lines];
	}

	invalidate(): void {}
}

class Group implements Component {
	children: Component[];

	constructor(children: Component[] = []) {
		this.children = children;
	}

	render(width: number): string[] {
		return this.children.flatMap((child) => child.render(width));
	}

	invalidate(): void {
		for (const child of this.children) child.invalidate();
	}
}

class FakeTerminal {
	columns = 80;
	rows = 8;
	readonly writes: string[] = [];

	write(data: string): void {
		this.writes.push(data);
	}
}

class FakeTui {
	children: Component[] = [];
	terminal = new FakeTerminal();
	focusedComponent: Component | null = null;
	overlayVisible = false;
	readonly requestedForces: boolean[] = [];
	stopCalls = 0;

	render(width: number): string[] {
		return this.children.flatMap((child) => child.render(width));
	}

	requestRender(force = false): void {
		this.requestedForces.push(force);
	}

	stop(): void {
		this.stopCalls += 1;
	}

	hasOverlay(): boolean {
		return this.overlayVisible;
	}
}

interface Fixture {
	tui: FakeTui;
	history: Leaf;
	capture: Leaf;
	editor: Leaf;
	runtime: ReturnType<typeof createViewportRuntime>;
}

function createFixture(historyLines = Array.from({ length: 10 }, (_value, index) => `h${index}`)): Fixture {
	const tui = new FakeTui();
	const history = new Leaf(historyLines);
	const capture = new Leaf([]);
	const editor = new Leaf(["editor"]);
	const status = new Group();
	const widgetAbove = new Group();
	const editorContainer = new Group([editor]);
	const widgetBelow = new Group([capture]);
	const footer = new Leaf(["footer"]);
	tui.children = [history, status, widgetAbove, editorContainer, widgetBelow, footer];
	tui.focusedComponent = editor;
	const runtime = createViewportRuntime(tui as unknown as TUI, capture);
	runtime.install();
	return { tui, history, capture, editor, runtime };
}

test("sticky split pins the current root suffix to the bottom", () => {
	const fixture = createFixture();
	const lines = fixture.tui.render(80);
	assert.deepEqual(lines, ["h4", "h5", "h6", "h7", "h8", "h9", "editor", "footer"]);
	assert.equal(fixture.runtime.getSnapshot().active, true);
	assert.equal(fixture.runtime.getSnapshot().followBottom, true);
});

test("scroll-only frames reuse raw history and ordinary requests invalidate the cache", () => {
	const fixture = createFixture();
	fixture.tui.render(80);
	assert.equal(fixture.history.renderCalls, 1);

	assert.equal(fixture.runtime.enqueueWheel(-1, 1_000), true);
	assert.deepEqual(fixture.tui.render(80).slice(0, 6), ["h3", "h4", "h5", "h6", "h7", "h8"]);
	assert.equal(fixture.history.renderCalls, 1);

	fixture.tui.requestRender();
	fixture.tui.render(80);
	assert.equal(fixture.history.renderCalls, 2);
});

test("visible overlays fall back, clear pending motion, and cleanly re-enter", () => {
	const fixture = createFixture();
	fixture.tui.render(80);
	for (let index = 0; index < 6; index += 1) fixture.runtime.enqueueWheel(-1, 1_000 + index * 10);
	fixture.tui.overlayVisible = true;
	const fallbackLines = fixture.tui.render(80);
	assert.equal(fallbackLines.length, 12);
	assert.equal(fixture.runtime.getSnapshot().active, false);
	assert.equal(fixture.runtime.getSnapshot().pendingDelta, 0);
	assert.equal(fixture.runtime.getSnapshot().lastFallbackReason, "visible-overlay");

	fixture.tui.overlayVisible = false;
	fixture.tui.requestRender();
	assert.equal(fixture.tui.requestedForces.at(-1), true);
	assert.equal(fixture.tui.render(80).length, 8);
	assert.equal(fixture.runtime.getSnapshot().active, true);
});

test("unknown layouts, tiny dimensions, tall pinned panes, and inline images use native rendering", () => {
	const unknown = createFixture();
	unknown.tui.children.pop();
	assert.equal(unknown.tui.render(80).length, 11);
	assert.equal(unknown.runtime.getSnapshot().lastFallbackReason, "unknown-layout");

	const tiny = createFixture();
	tiny.tui.terminal.columns = 10;
	assert.equal(tiny.tui.render(10).length, 12);
	assert.equal(tiny.runtime.getSnapshot().lastFallbackReason, "invalid-or-tiny-dimensions");

	const image = createFixture(["h0", "\x1b_Gi=1;payload", "h2"]);
	assert.equal(image.tui.render(80).length, 5);
	assert.equal(image.runtime.getSnapshot().lastFallbackReason, "inline-image");

	const tall = createFixture();
	const editorContainer = tall.tui.children[3] as Group;
	const footer = tall.tui.children[5] as Leaf;
	const tallEditor = new Leaf(Array.from({ length: 4 }, () => "editor"));
	editorContainer.children = [tallEditor];
	tall.tui.focusedComponent = tallEditor;
	footer.lines = Array.from({ length: 4 }, () => "footer");
	assert.equal(tall.tui.render(80).length, 18);
	assert.equal(tall.runtime.getSnapshot().lastFallbackReason, "pinned-pane-too-tall");
});

test("resize transition falls back once and queues a forced clean re-entry through requestRender", async () => {
	const fixture = createFixture();
	fixture.tui.render(80);
	fixture.tui.terminal.rows = 9;
	assert.equal(fixture.tui.render(80).length, 12);
	assert.equal(fixture.runtime.getSnapshot().lastFallbackReason, "resize-transition");
	await Promise.resolve();
	assert.equal(fixture.tui.requestedForces.at(-1), true);
	assert.equal(fixture.tui.render(80).length, 9);
});

test("patch is instance-only and restores exact descriptors only while wrappers are owned", () => {
	const first = createFixture();
	const second = new FakeTui();
	assert.equal(Object.hasOwn(second, "render"), false);
	assert.equal(Object.hasOwn(first.tui, "render"), true);
	assert.equal(Object.hasOwn(first.tui, "requestRender"), true);

	const replacement = (_width: number): string[] => ["replacement"];
	Object.defineProperty(first.tui, "render", {
		configurable: true,
		enumerable: true,
		writable: true,
		value: replacement,
	});
	first.runtime.dispose();
	assert.equal(first.tui.render, replacement);
	assert.equal(Object.hasOwn(first.tui, "requestRender"), false);
	assert.equal(Object.hasOwn(first.tui, "stop"), false);
});

test("pre-existing own descriptors are restored exactly and stop cleanup is idempotent", () => {
	const tui = new FakeTui();
	const customRender = function customRender(this: FakeTui, width: number): string[] {
		return this.children.flatMap((child) => child.render(width));
	};
	Object.defineProperty(tui, "render", {
		configurable: true,
		enumerable: true,
		writable: false,
		value: customRender,
	});
	const capture = new Leaf([]);
	const editor = new Leaf(["editor"]);
	tui.children = [
		new Leaf(["history"]),
		new Group(),
		new Group(),
		new Group([editor]),
		new Group([capture]),
		new Leaf(["footer"]),
	];
	tui.focusedComponent = editor;
	let stopCleanups = 0;
	const runtime = createViewportRuntime(tui as unknown as TUI, capture, () => {
		stopCleanups += 1;
	});
	runtime.install();
	tui.stop();
	tui.stop();
	const descriptor = Object.getOwnPropertyDescriptor(tui, "render");
	assert.equal(descriptor?.value, customRender);
	assert.equal(descriptor?.enumerable, true);
	assert.equal(descriptor?.writable, false);
	assert.equal(stopCleanups, 1);
	assert.equal(tui.stopCalls, 2);
	runtime.dispose();
});
