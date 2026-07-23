import type { Component, TUI } from "@earendil-works/pi-tui";

import {
	addWheelInput,
	createScrollState,
	drainScrollFrame,
	reconcileScrollBounds,
	resetScrollMotion,
	type ScrollBounds,
	type ScrollDirection,
	type ScrollState,
} from "./scroll-logic.ts";

interface TerminalLike {
	columns: number;
	rows: number;
	drainInput(maxMs?: number, idleMs?: number): Promise<void>;
	write(data: string): void;
}

interface TuiInternals {
	children: Component[];
	terminal: TerminalLike;
	render(width: number): string[];
	requestRender(force?: boolean): void;
	stop(): void;
	hasOverlay?: () => boolean;
	focusedComponent?: Component | null;
}

interface RootLayout {
	historyChildren: Component[];
	stickyChildren: Component[];
	signature: Component[];
}

interface HistoryCache {
	width: number;
	height: number;
	historyLines: string[];
	signature: Component[];
}

export interface ViewportSnapshot {
	active: boolean;
	viewportTop: number;
	followBottom: boolean;
	pendingDelta: number;
	historyLineCount: number;
	viewportRows: number;
	lastFallbackReason: string | undefined;
}

const ROOT_SUFFIX_CHILD_COUNT = 5;
const MINIMUM_WIDTH = 20;
const MINIMUM_HEIGHT = 8;
const MINIMUM_HISTORY_ROWS = 3;
const INLINE_IMAGE_MARKERS = ["\x1b_G", "\x1b]1337;File="] as const;
const SIXEL_MARKER = /\x1bP[0-9;?]*q/;

function hasChildren(component: Component): component is Component & { children: Component[] } {
	return Array.isArray((component as unknown as { children?: unknown }).children);
}

function containsComponent(root: Component, target: Component, visited = new Set<Component>()): boolean {
	if (root === target) return true;
	if (visited.has(root) || !hasChildren(root)) return false;
	visited.add(root);
	return root.children.some((child) => containsComponent(child, target, visited));
}

function containsInlineImage(lines: readonly string[]): boolean {
	return lines.some(
		(line) => INLINE_IMAGE_MARKERS.some((marker) => line.includes(marker)) || SIXEL_MARKER.test(line),
	);
}

function renderComponents(components: readonly Component[], width: number): string[] {
	const lines: string[] = [];
	for (const component of components) {
		const rendered = component.render(width);
		if (!Array.isArray(rendered) || rendered.some((line) => typeof line !== "string")) {
			throw new TypeError("Pi component returned invalid rendered lines");
		}
		lines.push(...rendered);
	}
	return lines;
}

function sameSignature(left: readonly Component[], right: readonly Component[]): boolean {
	return left.length === right.length && left.every((component, index) => component === right[index]);
}

function findRootLayout(tui: TuiInternals, captureWidget: Component): RootLayout | undefined {
	const captureRootIndex = tui.children.findIndex((child) => containsComponent(child, captureWidget));
	const suffixStart = captureRootIndex - 3;
	if (
		captureRootIndex !== tui.children.length - 2
		|| suffixStart < 0
		|| tui.children.length - suffixStart !== ROOT_SUFFIX_CHILD_COUNT
	) {
		return undefined;
	}

	const stickyChildren = tui.children.slice(suffixStart);
	if (stickyChildren.length !== ROOT_SUFFIX_CHILD_COUNT) return undefined;
	if (!stickyChildren.slice(0, 4).every(hasChildren)) return undefined;
	if (!containsComponent(stickyChildren[3]!, captureWidget)) return undefined;

	const focused = tui.focusedComponent;
	if (focused && !containsComponent(stickyChildren[2]!, focused)) return undefined;

	return {
		historyChildren: tui.children.slice(0, suffixStart),
		stickyChildren,
		signature: [...tui.children],
	};
}

function ownDescriptor(object: object, key: PropertyKey): PropertyDescriptor | undefined {
	return Object.getOwnPropertyDescriptor(object, key);
}

function restoreOwnedDescriptor(
	object: object,
	key: PropertyKey,
	wrapper: unknown,
	previous: PropertyDescriptor | undefined,
): void {
	const current = ownDescriptor(object, key);
	if (!current || current.value !== wrapper) return;
	if (previous) {
		Object.defineProperty(object, key, previous);
	} else {
		Reflect.deleteProperty(object, key);
	}
}

export class ViewportRuntime {
	private readonly tui: TuiInternals;
	private readonly captureWidget: Component;
	private readonly onStop: () => void;
	private readonly previousRenderDescriptor: PropertyDescriptor | undefined;
	private readonly previousRequestRenderDescriptor: PropertyDescriptor | undefined;
	private readonly previousStopDescriptor: PropertyDescriptor | undefined;
	private readonly previousDrainInputDescriptor: PropertyDescriptor | undefined;
	private readonly originalRender: TuiInternals["render"];
	private readonly originalRequestRender: TuiInternals["requestRender"];
	private readonly originalStop: TuiInternals["stop"];
	private readonly originalDrainInput: TerminalLike["drainInput"];
	private renderWrapper: TuiInternals["render"] | undefined;
	private requestRenderWrapper: TuiInternals["requestRender"] | undefined;
	private stopWrapper: TuiInternals["stop"] | undefined;
	private drainInputWrapper: TerminalLike["drainInput"] | undefined;
	private scrollState: ScrollState = createScrollState();
	private historyCache: HistoryCache | undefined;
	private installed = false;
	private disposed = false;
	private active = false;
	private ordinaryRenderPending = true;
	private extensionRenderQueued = false;
	private queuedRenderMayUseCache = false;
	private internalRequest = false;
	private cleanReentryNeeded = false;
	private cleanMicrotaskQueued = false;
	private lastWidth = 0;
	private lastHeight = 0;
	private historyLineCount = 0;
	private viewportRows = 0;
	private lastFallbackReason: string | undefined;

	constructor(tui: TUI, captureWidget: Component, onStop: () => void = () => {}) {
		this.tui = tui as unknown as TuiInternals;
		this.captureWidget = captureWidget;
		this.onStop = onStop;
		this.previousRenderDescriptor = ownDescriptor(this.tui, "render");
		this.previousRequestRenderDescriptor = ownDescriptor(this.tui, "requestRender");
		this.previousStopDescriptor = ownDescriptor(this.tui, "stop");
		this.previousDrainInputDescriptor = ownDescriptor(this.tui.terminal, "drainInput");
		this.originalRender = this.tui.render;
		this.originalRequestRender = this.tui.requestRender;
		this.originalStop = this.tui.stop;
		this.originalDrainInput = this.tui.terminal.drainInput;
	}

	install(): void {
		if (this.installed || this.disposed) return;
		this.installed = true;

		this.renderWrapper = (width) => this.renderFrame(width);
		this.requestRenderWrapper = (force = false) => {
			let nextForce = force;
			if (!this.internalRequest) {
				this.ordinaryRenderPending = true;
				this.queuedRenderMayUseCache = false;
				this.historyCache = undefined;
				if (this.cleanReentryNeeded) {
					nextForce = true;
					this.cleanReentryNeeded = false;
				}
			}
			this.originalRequestRender.call(this.tui, nextForce);
		};
		this.stopWrapper = () => {
			try {
				this.onStop();
			} finally {
				this.dispose();
				this.originalStop.call(this.tui);
			}
		};
		this.drainInputWrapper = (maxMs, idleMs) => {
			this.onStop();
			return this.originalDrainInput.call(this.tui.terminal, maxMs, idleMs);
		};

		Object.defineProperty(this.tui, "render", {
			configurable: true,
			enumerable: false,
			writable: true,
			value: this.renderWrapper,
		});
		Object.defineProperty(this.tui, "requestRender", {
			configurable: true,
			enumerable: false,
			writable: true,
			value: this.requestRenderWrapper,
		});
		Object.defineProperty(this.tui, "stop", {
			configurable: true,
			enumerable: false,
			writable: true,
			value: this.stopWrapper,
		});
		Object.defineProperty(this.tui.terminal, "drainInput", {
			configurable: true,
			enumerable: false,
			writable: true,
			value: this.drainInputWrapper,
		});
	}

	requestCleanRender(): void {
		if (!this.installed || this.disposed) return;
		this.cleanReentryNeeded = true;
		this.tui.requestRender(false);
	}

	enqueueWheel(direction: ScrollDirection, now: number): boolean {
		if (!this.canConsumeScroll()) return false;
		this.scrollState = addWheelInput(this.scrollState, direction, now);
		this.queueScrollRender();
		return true;
	}

	getSnapshot(): ViewportSnapshot {
		return {
			active: this.active,
			viewportTop: this.scrollState.viewportTop,
			followBottom: this.scrollState.followBottom,
			pendingDelta: this.scrollState.pendingDelta,
			historyLineCount: this.historyLineCount,
			viewportRows: this.viewportRows,
			lastFallbackReason: this.lastFallbackReason,
		};
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.active = false;
		this.historyCache = undefined;
		this.scrollState = resetScrollMotion(this.scrollState);

		if (this.renderWrapper) {
			restoreOwnedDescriptor(this.tui, "render", this.renderWrapper, this.previousRenderDescriptor);
		}
		if (this.requestRenderWrapper) {
			restoreOwnedDescriptor(
				this.tui,
				"requestRender",
				this.requestRenderWrapper,
				this.previousRequestRenderDescriptor,
			);
		}
		if (this.stopWrapper) {
			restoreOwnedDescriptor(this.tui, "stop", this.stopWrapper, this.previousStopDescriptor);
		}
		if (this.drainInputWrapper) {
			restoreOwnedDescriptor(
				this.tui.terminal,
				"drainInput",
				this.drainInputWrapper,
				this.previousDrainInputDescriptor,
			);
		}
	}

	private canConsumeScroll(): boolean {
		if (!this.active || this.cleanReentryNeeded || this.disposed || !this.historyCache) return false;
		if (this.hasVisibleOverlay()) return false;
		if (this.tui.terminal.columns !== this.lastWidth || this.tui.terminal.rows !== this.lastHeight) return false;
		const layout = findRootLayout(this.tui, this.captureWidget);
		return layout !== undefined && sameSignature(layout.signature, this.historyCache.signature);
	}

	private hasVisibleOverlay(): boolean {
		if (typeof this.tui.hasOverlay !== "function") return false;
		try {
			return this.tui.hasOverlay.call(this.tui);
		} catch {
			return true;
		}
	}

	private queueScrollRender(): void {
		if (this.extensionRenderQueued || this.disposed) return;
		this.extensionRenderQueued = true;
		this.queuedRenderMayUseCache = !this.ordinaryRenderPending && this.historyCache !== undefined;
		this.internalRequest = true;
		try {
			this.originalRequestRender.call(this.tui, false);
		} finally {
			this.internalRequest = false;
		}
	}

	private renderFrame(width: number): string[] {
		const height = this.tui.terminal.rows;
		const scrollOnlyFrame = this.extensionRenderQueued
			&& this.queuedRenderMayUseCache
			&& !this.ordinaryRenderPending;
		this.extensionRenderQueued = false;
		this.queuedRenderMayUseCache = false;
		this.ordinaryRenderPending = false;

		if (!Number.isFinite(width) || !Number.isFinite(height) || width < MINIMUM_WIDTH || height < MINIMUM_HEIGHT) {
			return this.fallback("invalid-or-tiny-dimensions", this.originalRender.call(this.tui, width), width, height);
		}
		if (this.hasVisibleOverlay()) {
			return this.fallback("visible-overlay", this.originalRender.call(this.tui, width), width, height);
		}

		const layout = findRootLayout(this.tui, this.captureWidget);
		if (!layout) {
			return this.fallback("unknown-layout", this.originalRender.call(this.tui, width), width, height);
		}

		let historyLines: string[];
		let stickyLines: string[];
		try {
			const cache = this.historyCache;
			historyLines = scrollOnlyFrame
				&& cache
				&& cache.width === width
				&& cache.height === height
				&& sameSignature(cache.signature, layout.signature)
				? [...cache.historyLines]
				: renderComponents(layout.historyChildren, width);
			stickyLines = renderComponents(layout.stickyChildren, width);
		} catch {
			return this.fallback("component-render-failed", this.originalRender.call(this.tui, width), width, height);
		}
		const rawLines = [...historyLines, ...stickyLines];

		if (this.lastWidth !== 0 && (this.lastWidth !== width || this.lastHeight !== height)) {
			const fallback = this.fallback("resize-transition", rawLines, width, height);
			this.scheduleCleanReentry();
			return fallback;
		}
		if (containsInlineImage(rawLines)) {
			return this.fallback("inline-image", rawLines, width, height);
		}
		if (stickyLines.length <= 0 || stickyLines.length >= height) {
			return this.fallback("pinned-pane-too-tall", rawLines, width, height);
		}

		const viewportRows = height - stickyLines.length;
		if (viewportRows < MINIMUM_HISTORY_ROWS) {
			return this.fallback("history-pane-too-small", rawLines, width, height);
		}

		const bounds: ScrollBounds = {
			historyLineCount: historyLines.length,
			viewportRows,
		};
		this.scrollState = reconcileScrollBounds(this.scrollState, bounds);
		if (this.scrollState.pendingDelta !== 0) {
			this.scrollState = drainScrollFrame(this.scrollState, bounds).state;
		}

		const visibleHistory = historyLines.slice(
			this.scrollState.viewportTop,
			this.scrollState.viewportTop + viewportRows,
		);
		while (visibleHistory.length < viewportRows) visibleHistory.push("");

		this.historyCache = {
			width,
			height,
			historyLines: [...historyLines],
			signature: [...layout.signature],
		};
		this.active = true;
		this.cleanReentryNeeded = false;
		this.lastFallbackReason = undefined;
		this.lastWidth = width;
		this.lastHeight = height;
		this.historyLineCount = historyLines.length;
		this.viewportRows = viewportRows;

		if (this.scrollState.pendingDelta !== 0) this.queueScrollRender();
		return [...visibleHistory, ...stickyLines];
	}

	private fallback(reason: string, rawLines: string[], width: number, height: number): string[] {
		this.active = false;
		this.cleanReentryNeeded = true;
		this.historyCache = undefined;
		this.scrollState = resetScrollMotion(this.scrollState);
		this.lastFallbackReason = reason;
		this.lastWidth = width;
		this.lastHeight = height;
		this.historyLineCount = 0;
		this.viewportRows = 0;
		return rawLines;
	}

	private scheduleCleanReentry(): void {
		if (this.cleanMicrotaskQueued || this.disposed) return;
		this.cleanMicrotaskQueued = true;
		queueMicrotask(() => {
			this.cleanMicrotaskQueued = false;
			if (this.disposed || !this.cleanReentryNeeded) return;
			this.tui.requestRender(false);
		});
	}
}

export function createViewportRuntime(
	tui: TUI,
	captureWidget: Component,
	onStop: () => void = () => {},
): ViewportRuntime {
	return new ViewportRuntime(tui, captureWidget, onStop);
}
