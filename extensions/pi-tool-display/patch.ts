import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { type TuiMouseEvent, type TuiMouseEventResult, Container, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	CODEMODE_TOOL_NAME,
	classifyToolPresentation,
	type ExplorationGroupItem,
	type ExplorationToolDescriptor,
	formatCommandSummary,
	formatCompletedSummary,
	formatExplorationSummary,
	formatMutationStatistics,
	formatMutationTarget,
	formatRemoteActionSummary,
	generateSelectionLabels,
	groupExplorationItems,
	isExplorationTool,
} from "./logic.ts";

const PATCH_KEY = Symbol.for("pi.tool-display.patch.v9");
// TEMPORARY: retain the non-intent pending renderers below for re-enabling later.
export const HIDE_PENDING_CALLS = true;

const ACTIVE_THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

/** Private Pi 1.2 fullscreen router surface, feature-detected before hooking. */
interface RuntimeMouseUI {
	terminal?: { columns: number; rows: number };
	getPrimaryScrollView?: () => { scrollTop: number };
	createMouseEvent: (type: TuiMouseEvent["type"], button: number, x: number, y: number, extra?: Partial<TuiMouseEvent>) => TuiMouseEvent;
	requestRender: (force?: boolean) => void;
}

interface RuntimeToolDefinition {
	label?: unknown;
	description?: unknown;
}

interface RuntimeToolResult {
	content?: unknown;
	details?: unknown;
	isError?: unknown;
}

interface RuntimeToolExecution {
	toolName?: unknown;
	toolCallId?: unknown;
	args?: unknown;
	toolDefinition?: unknown;
	builtInToolDefinition?: unknown;
	isPartial?: unknown;
	result?: RuntimeToolResult;
	expanded?: unknown;
	setExpanded?: unknown;
}

interface RuntimeAssistantMessage {
	lastMessage?: unknown;
	updateContent?: unknown;
}

interface AssistantContentState {
	original: AssistantMessage;
	filtered: AssistantMessage;
}

interface GroupMember {
	component: object;
	descriptor: ExplorationToolDescriptor;
	summary: string;
}

interface DescriptorCacheEntry {
	args: unknown;
	toolName: unknown;
	toolDefinition: unknown;
	builtInToolDefinition: unknown;
	descriptor: ExplorationToolDescriptor | undefined;
}

interface RuntimeGroup {
	kind: "exploration" | "mutation" | "remote" | "completed";
	members: GroupMember[];
	stable: boolean;
	activeSection?: string;
}

interface RuntimeMembership {
	group: RuntimeGroup;
	index: number;
}

interface ParentState {
	components: object[];
}

interface PatchHandle {
	installed: boolean;
	reason?: string;
	beginSelection(): string[];
	cancelSelection(): void;
	expandSelection(label: string): boolean;
	reset(): void;
	restore(): void;
}

interface PatchRecord {
	handle: PatchHandle;
}

interface PatchGlobal {
	[PATCH_KEY]?: PatchRecord;
}

type MouseMethod = (this: object, event: TuiMouseEvent) => TuiMouseEventResult | undefined;

type RenderMethod = (this: object, width: number) => string[];
type UpdateArgsMethod = (this: object, args: unknown) => void;
type UpdateResultMethod = (this: object, result: RuntimeToolResult, isPartial?: boolean) => void;
type SetExpandedMethod = (this: object, expanded: boolean) => void;
type UpdateAssistantContentMethod = (this: object, message: AssistantMessage) => void;
type ContainerRenderMethod = (this: Container, width: number) => string[];
type AddChildMethod = (this: Container, component: object) => void;
type RemoveChildMethod = (this: Container, component: object) => void;
type ClearMethod = (this: Container) => void;

interface PatchOptions {
	/** Temporary opt-out for exercising retained pending rendering. */
	hidePending?: boolean;
	getTheme: () => Theme | undefined;
	toolClass?: typeof ToolExecutionComponent;
	assistantClass?: typeof AssistantMessageComponent;
	userClass?: typeof UserMessageComponent;
	containerClass?: typeof Container;
	onParentRebuild?: (parent: object) => void;
	onCompactTextOutputNormalize?: () => void;
	onCustomRowsCompute?: (target: object) => void;
}

function isRecord(value: unknown): value is Record<string | symbol, unknown> {
	return typeof value === "object" && value !== null;
}

function definitionMetadata(value: unknown): RuntimeToolDefinition | undefined {
	return isRecord(value) ? value : undefined;
}

function runtimeDescriptor(component: object): ExplorationToolDescriptor | undefined {
	const runtime = component as RuntimeToolExecution;
	if (typeof runtime.toolName !== "string") return undefined;
	const custom = definitionMetadata(runtime.toolDefinition);
	const builtIn = definitionMetadata(runtime.builtInToolDefinition);
	const label =
		typeof custom?.label === "string" ? custom.label : typeof builtIn?.label === "string" ? builtIn.label : undefined;
	const description =
		typeof custom?.description === "string"
			? custom.description
			: typeof builtIn?.description === "string"
				? builtIn.description
				: undefined;
	return {
		name: runtime.toolName,
		args: runtime.args,
		label,
		description,
		isCustom: custom !== undefined && builtIn === undefined,
	};
}

function componentId(component: object, index: number): string {
	const id = (component as RuntimeToolExecution).toolCallId;
	return typeof id === "string" ? id : `tool-${index}`;
}

function hasVisibleAssistantText(component: object): boolean {
	const assistant = component as RuntimeAssistantMessage;
	if (typeof assistant.updateContent !== "function" || !isRecord(assistant.lastMessage)) return false;
	const content = assistant.lastMessage.content;
	return (
		Array.isArray(content) &&
		content.some(
			(item) =>
				isRecord(item) && item.type === "text" && typeof item.text === "string" && item.text.trim().length > 0,
		)
	);
}

function withoutThinking(message: AssistantMessage): AssistantMessage {
	return { ...message, content: message.content.filter((item) => item.type !== "thinking") };
}

function cleanOutputLine(value: string): string {
	return value
		.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]+/g, " ")
		.replace(/\t/g, "  ")
		.trimEnd();
}

function compactTextOutput(
	result: RuntimeToolResult | undefined,
	maxLines: number,
	onNormalize?: () => void,
): string[] {
	onNormalize?.();
	if (!Array.isArray(result?.content)) return [];
	const lines: string[] = [];
	for (const item of result.content) {
		if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") continue;
		lines.push(...item.text.split(/\r\n|\r|\n/).map(cleanOutputLine));
	}
	while (lines[0] === "") lines.shift();
	while (lines.at(-1) === "") lines.pop();
	if (lines.length <= maxLines) return lines;
	return [...lines.slice(0, Math.max(0, maxLines - 1)), `… (+${lines.length - maxLines + 1} lines)`];
}

type SemanticState = "pending" | "success" | "failure";
type StatusColor = "accent" | "success" | "error" | "muted";

function semanticState(runtime: RuntimeToolExecution): SemanticState {
	if (runtime.result?.isError === true) return "failure";
	return runtime.isPartial === false && runtime.result !== undefined ? "success" : "pending";
}

function groupedExplorationHeader(theme: Theme | undefined, status: string, color: StatusColor): string {
	const header = `• ${status}`;
	return theme ? theme.fg(color, theme.bold(header)) : header;
}

function statusHeader(
	theme: Theme | undefined,
	status: string,
	summary: string,
	color: StatusColor,
	selectionLabel?: string,
): string {
	const label = theme ? theme.fg(color, theme.bold(status)) : status;
	const selection = selectionLabel ? `${theme ? theme.fg("warning", `[${selectionLabel}]`) : `[${selectionLabel}]`} ` : "";
	return `• ${selection}${label}${summary ? ` ${summary}` : ""}`;
}

function detailLine(theme: Theme | undefined, text: string, error = false): string {
	const line = `  ${text}`;
	return theme ? theme.fg(error ? "error" : "muted", line) : line;
}

function widthSafeLines(lines: string[], width: number): string[] {
	const availableWidth = Math.max(0, width);
	return ["", ...lines.map((line) => truncateToWidth(line, availableWidth, "…"))];
}

class GroupingRuntime {
	private hovered?: { component: object; group: RuntimeGroup; key: string; left: number; right: number; row: number };
	private uiCleanup = new Map<object, () => void>();

	clearHover(): boolean {
		if (!this.hovered) return false;
		this.groupRowsCache.delete(this.hovered.group);
		this.hovered = undefined;
		return true;
	}

	/** Pi routes only to the hit child, with no leave event. Observe normalized events
	 * at the owning fullscreen router, including blank space/overlays; never raw input.
	 * Instance hooks are restored on reset/reload, not global input listeners.
	 */
	private observeUI(component: object): void {
		const ui = (component as { ui?: RuntimeMouseUI }).ui;
		if (!ui || this.uiCleanup.has(ui) || typeof ui.createMouseEvent !== "function" || typeof ui.requestRender !== "function") return;
		const runtime = this;
		const ownMouse = Object.getOwnPropertyDescriptor(ui, "createMouseEvent");
		const ownRender = Object.getOwnPropertyDescriptor(ui, "requestRender");
		const mouse = ui.createMouseEvent;
		const render = ui.requestRender;
		const geometry = () => `${ui.terminal?.columns}:${ui.terminal?.rows}:${ui.getPrimaryScrollView?.().scrollTop}`;
		let previous = geometry();
		const wrappedMouse = function (this: RuntimeMouseUI, ...args: Parameters<RuntimeMouseUI["createMouseEvent"]>) {
			const event = mouse.apply(this, args);
			if (runtime.leaveForEvent(event)) render.call(this);
			return event;
		};
		const wrappedRender = function (this: RuntimeMouseUI, ...args: Parameters<RuntimeMouseUI["requestRender"]>) {
			const next = geometry();
			if (next !== previous) runtime.clearHover();
			previous = next;
			return render.apply(this, args);
		};
		ui.createMouseEvent = wrappedMouse;
		ui.requestRender = wrappedRender;
		this.uiCleanup.set(ui, () => {
			if (ui.createMouseEvent === wrappedMouse) {
				if (ownMouse) Object.defineProperty(ui, "createMouseEvent", ownMouse); else Reflect.deleteProperty(ui, "createMouseEvent");
			}
			if (ui.requestRender === wrappedRender) {
				if (ownRender) Object.defineProperty(ui, "requestRender", ownRender); else Reflect.deleteProperty(ui, "requestRender");
			}
		});
	}

	leaveForEvent(event: TuiMouseEvent): boolean {
		const hover = this.hovered;
		if (!hover) return false;
		if (event.type !== "move" || event.screenY !== hover.row || event.screenX < hover.left || event.screenX >= hover.right) return this.clearHover();
		return false;
	}

	private opened = new WeakSet<object>();
	private mouseRows = new WeakMap<object, { width: number; height: number; group?: RuntimeGroup; native: boolean }>();
	private parentStates = new Map<object, ParentState>();
	private memberships = new WeakMap<object, RuntimeMembership>();
	// Separate from kind-specific pending groups: one completed summary per visible-message interval.
	private sequences = new WeakMap<object, RuntimeGroup>();
	private componentParents = new WeakMap<object, object>();
	private descriptorCache = new WeakMap<object, DescriptorCacheEntry>();
	private normalizedOutputCache = new WeakMap<RuntimeToolResult, Map<number, string[]>>();
	private groupRowsCache = new WeakMap<RuntimeGroup, Map<Theme | undefined, Map<number, Map<object, string[]>>>>();
	private componentRowsCache = new WeakMap<object, Map<Theme | undefined, Map<number, string[]>>>();
	private selectionLabels = new Map<object, string>();
	private assistantContentStates = new Map<object, AssistantContentState>();
	private adoptedParents = new WeakSet<object>();
	private readonly updateAssistantContent: UpdateAssistantContentMethod;
	private readonly userClass: typeof UserMessageComponent;
	private readonly getTheme: () => Theme | undefined;
	private readonly onParentRebuild: ((parent: object) => void) | undefined;
	private readonly onCompactTextOutputNormalize: (() => void) | undefined;
	private readonly onCustomRowsCompute: ((target: object) => void) | undefined;
	private themeInitialized = false;
	private activeTheme: Theme | undefined;
	private activeThemeGeneration: Theme | undefined;

	constructor(
		getTheme: () => Theme | undefined,
		private readonly hidePending: boolean,
		updateAssistantContent: UpdateAssistantContentMethod,
		userClass: typeof UserMessageComponent,
		onParentRebuild?: (parent: object) => void,
		onCompactTextOutputNormalize?: () => void,
		onCustomRowsCompute?: (target: object) => void,
	) {
		this.getTheme = getTheme;
		this.updateAssistantContent = updateAssistantContent;
		this.userClass = userClass;
		this.onParentRebuild = onParentRebuild;
		this.onCompactTextOutputNormalize = onCompactTextOutputNormalize;
		this.onCustomRowsCompute = onCustomRowsCompute;
	}

	reset(): void {
		this.clearHover();
		for (const cleanup of this.uiCleanup.values()) cleanup();
		this.uiCleanup.clear();
		this.restoreAllAssistantContent();
		this.opened = new WeakSet();
		this.mouseRows = new WeakMap();
		this.parentStates.clear();
		this.memberships = new WeakMap();
		this.sequences = new WeakMap();
		this.componentParents = new WeakMap();
		this.descriptorCache = new WeakMap();
		this.normalizedOutputCache = new WeakMap();
		this.groupRowsCache = new WeakMap();
		this.componentRowsCache = new WeakMap();
		this.adoptedParents = new WeakSet();
		this.themeInitialized = false;
		this.activeTheme = undefined;
		this.activeThemeGeneration = undefined;
		this.selectionLabels.clear();
	}

	beginSelection(): string[] {
		const targets: object[] = [];
		for (const state of this.parentStates.values()) {
			for (const component of state.components) {
				const runtime = component as RuntimeToolExecution;
				if ((!this.hidePending || this.isComplete(component)) && this.descriptor(component) && runtime.expanded !== true && !targets.includes(component)) targets.push(component);
			}
		}
		const labels = generateSelectionLabels(targets.length);
		this.selectionLabels = new Map(targets.map((component, index) => [component, labels[index] ?? ""]));
		for (const component of targets) this.invalidateRows(component);
		return labels;
	}

	cancelSelection(): void {
		const targets = [...this.selectionLabels.keys()];
		this.selectionLabels.clear();
		for (const component of targets) this.invalidateRows(component);
	}

	expandSelection(label: string): boolean {
		const targets = [...this.selectionLabels.keys()];
		const target = [...this.selectionLabels].find(([, candidate]) => candidate === label)?.[0];
		this.selectionLabels.clear();
		for (const component of targets) this.invalidateRows(component);
		if (!target) return false;
		const setExpanded = (target as RuntimeToolExecution).setExpanded;
		if (typeof setExpanded !== "function") return false;
		this.opened.delete(target);
		setExpanded.call(target, true);
		return true;
	}

	adopt(parent: object, components: object[], assistantClass: typeof AssistantMessageComponent): void {
		if (this.adoptedParents.has(parent)) return;
		this.adoptedParents.add(parent);
		const state = this.parentStates.get(parent) ?? { components: [] };
		if (
			state.components.length === components.length &&
			state.components.every((component, index) => component === components[index])
		) {
			return;
		}
		for (const component of state.components) {
			if (components.includes(component)) continue;
			this.restoreAssistantContent(component);
			this.opened.delete(component);
			this.invalidateRows(component);
			this.memberships.delete(component);
			this.sequences.delete(component);
			if (this.componentParents.get(component) === parent) this.componentParents.delete(component);
		}
		state.components = [...components];
		this.parentStates.set(parent, state);
		for (const component of components) {
			if (component instanceof assistantClass) this.observeAssistantContent(component);
			this.componentParents.set(component, parent);
		}
		this.rebuildParent(parent, state);
	}

	observe(parent: object, component: object, assistant: boolean): void {
		if (assistant) this.observeAssistantContent(component);
		const previousParent = this.componentParents.get(component);
		if (previousParent && previousParent !== parent) {
			const previousState = this.parentStates.get(previousParent);
			if (previousState) {
				this.memberships.delete(component);
				previousState.components = previousState.components.filter((candidate) => candidate !== component);
				this.rebuildParent(previousParent, previousState);
			}
		}
		const state = this.parentStates.get(parent) ?? { components: [] };
		if (!this.parentStates.has(parent)) this.parentStates.set(parent, state);
		if (!state.components.includes(component)) state.components.push(component);
		this.componentParents.set(component, parent);
		this.rebuildParent(parent, state);
	}

	forget(parent: object, component: object): void {
		const state = this.parentStates.get(parent);
		if (!state || !state.components.includes(component)) return;
		this.restoreAssistantContent(component);
		this.opened.delete(component);
		this.invalidateRows(component);
		this.memberships.delete(component);
		this.descriptorCache.delete(component);
		this.sequences.delete(component);
		const result = (component as RuntimeToolExecution).result;
		if (result) this.normalizedOutputCache.delete(result);
		this.selectionLabels.delete(component);
		if (this.componentParents.get(component) === parent) this.componentParents.delete(component);
		state.components = state.components.filter((candidate) => candidate !== component);
		this.rebuildParent(parent, state);
	}

	clear(parent: object): void {
		const state = this.parentStates.get(parent);
		if (!state) return;
		for (const component of state.components) {
			this.restoreAssistantContent(component);
			this.opened.delete(component);
			this.invalidateRows(component);
			this.memberships.delete(component);
			this.descriptorCache.delete(component);
			this.sequences.delete(component);
			const result = (component as RuntimeToolExecution).result;
			if (result) this.normalizedOutputCache.delete(result);
			this.selectionLabels.delete(component);
			if (this.componentParents.get(component) === parent) this.componentParents.delete(component);
		}
		this.parentStates.delete(parent);
	}

	updateAssistant(component: object, message: AssistantMessage): void {
		const state = this.assistantContentStates.get(component);
		if (state?.filtered === message) {
			this.updateAssistantContent.call(component, message);
			return;
		}
		const filtered = withoutThinking(message);
		this.assistantContentStates.set(component, { original: message, filtered });
		this.updateAssistantContent.call(component, filtered);
		const parent = this.componentParents.get(component);
		const parentState = parent ? this.parentStates.get(parent) : undefined;
		if (parent && parentState) this.rebuildParent(parent, parentState);
	}

	private observeAssistantContent(component: object): void {
		if (this.assistantContentStates.has(component)) return;
		const lastMessage = (component as RuntimeAssistantMessage).lastMessage;
		if (isRecord(lastMessage) && Array.isArray(lastMessage.content)) {
			this.updateAssistant(component, lastMessage as unknown as AssistantMessage);
		}
	}

	private restoreAssistantContent(component: object): void {
		const state = this.assistantContentStates.get(component);
		if (!state) return;
		this.assistantContentStates.delete(component);
		this.updateAssistantContent.call(component, state.original);
	}

	private restoreAllAssistantContent(): void {
		for (const component of [...this.assistantContentStates.keys()]) this.restoreAssistantContent(component);
	}

	argsChanged(component: object): void {
		this.descriptorCache.delete(component);
		this.invalidateRows(component);
		const parent = this.componentParents.get(component);
		if (!parent) {
			this.sequences.delete(component);
			return;
		}
		const state = this.parentStates.get(parent);
		if (state) this.rebuildParent(parent, state);
	}

	resultChanged(component: object): void {
		this.invalidateRows(component);
		const membership = this.memberships.get(component);
		if (membership) membership.group.stable = this.isSettled(membership.group.members);
	}

	keyboardExpansionChanged(component: object): void {
		this.opened.delete(component);
		this.invalidateRows(component);
	}

	expansionChanged(component: object): void {
		this.invalidateRows(component);
	}

	handleMouse(component: object, event: TuiMouseEvent, original: MouseMethod): TuiMouseEventResult | undefined {
		const layout = this.mouseRows.get(component);
		if (!layout || layout.width !== event.width || event.y < 0 || event.y >= layout.height || event.x < 0 || event.x >= event.width) return undefined;
		if (layout.native) return original.call(component, event);
		const group = layout.group;
		if (!group || !(event.type === "move" && event.button === "none" || event.type === "click" && event.button === "left")) return undefined;
		const members = group.members.filter(({ component }) => this.isComplete(component) && ((component as RuntimeToolExecution).expanded !== true || this.opened.has(component)));
		const sections = this.summarySections(members);
		const leader = members.find(({ component }) => (component as RuntimeToolExecution).expanded !== true || this.opened.has(component));
		let section: string | undefined;
		if (leader?.component === component && event.y === 1) {
			let x = visibleWidth("• ");
			const labels = members.map(({ component }) => this.selectionPrefix(component).trim()).filter(Boolean).join(" ");
			const full = "• " + sections.map(s => s.text).join("") + (labels ? ` ${labels}` : "");
			const end = visibleWidth(full) > event.width ? Math.max(0, event.width - visibleWidth("…")) : visibleWidth(full);
			for (const item of sections) {
				const start = x + visibleWidth(item.separator);
				x += visibleWidth(item.text);
				if (event.x >= start && event.x < Math.min(x, end)) {
					section = item.key;
					if (event.type === "move") {
						if (this.hovered?.group === group && this.hovered.key === section) return undefined;
						this.clearHover();
						this.hovered = { component, group, key: section, left: event.screenX - event.x + start, right: event.screenX - event.x + Math.min(x, end), row: event.screenY };
						this.groupRowsCache.delete(group);
						return { handled: true, render: true };
					}
				}
			}
			if (!section) return undefined;
		} else if (!this.opened.has(component)) return undefined;
		if (event.type === "move") return undefined;
		const active = section && section !== group.activeSection ? section : undefined;
		group.activeSection = active;
		for (const { component: member, descriptor } of members) {
			if (active && (active === "failed" ? (member as RuntimeToolExecution).result?.isError === true : this.category(descriptor) === active)) this.opened.add(member);
			else this.opened.delete(member);
			this.invalidateRows(member);
		}
		// Pi's dispatcher schedules the render; no raw input interception or focus change.
		return { handled: true, render: true };
	}

	render(component: object, width: number, originalRender: RenderMethod, setExpanded: SetExpandedMethod): string[] {
		this.observeUI(component);
		if (this.hovered?.component === component && this.mouseRows.get(component)?.width !== width) this.clearHover();
		const rows = this.renderRows(component, width, originalRender, setExpanded);
		const sequence = this.sequences.get(component);
		const members = sequence?.members.filter(({ component }) => this.isComplete(component) &&
			((component as RuntimeToolExecution).expanded !== true || this.opened.has(component)));
		const grouped = this.isComplete(component) && ((component as RuntimeToolExecution).expanded !== true || this.opened.has(component));
		this.mouseRows.set(component, {
			width, height: rows.length,
			group: grouped && (members?.[0]?.component === component || this.opened.has(component)) ? sequence : undefined,
			native: !grouped && (component as RuntimeToolExecution).expanded === true,
		});
		return rows;
	}

	private renderRows(component: object, width: number, originalRender: RenderMethod, setExpanded: SetExpandedMethod): string[] {
		const runtime = component as RuntimeToolExecution;
		if (this.hidePending && !this.isComplete(component)) return [];
		if (runtime.expanded === true && !this.opened.has(component)) return originalRender.call(component, width);
		const theme = this.currentTheme();
		if (this.isComplete(component)) {
			const sequence = this.sequences.get(component);
			if (sequence) {
				const header = this.renderGroupMember(component, sequence, width, theme);
				if (!this.opened.has(component)) return header;
				// Mouse detail uses the original collapsed renderer; keyboard expansion stays independent.
				const expanded = runtime.expanded === true;
				try {
					if (expanded) setExpanded.call(component, false);
					return [...header, ...originalRender.call(component, width)];
				} finally {
					if (expanded) setExpanded.call(component, true);
				}
			}
			const descriptor = this.descriptor(component);
			if (descriptor) {
				const group: RuntimeGroup = { kind: "completed", members: [{ component, descriptor, summary: "" }], stable: true };
				this.sequences.set(component, group);
				return this.renderGroupMember(component, group, width, theme);
			}
		}
		const membership = this.memberships.get(component);
		if (membership) return this.renderGroupMember(component, membership.group, width, theme);

		let byTheme = this.componentRowsCache.get(component);
		const cached = byTheme?.get(theme)?.get(width);
		if (cached) return cached;
		const descriptor = this.descriptor(component);
		if (!descriptor) return originalRender.call(component, width);
		const presentation = classifyToolPresentation(descriptor);
		if (presentation === "original") return this.labelOriginal(component, originalRender.call(component, width), width);
		if (presentation === "exploration") return originalRender.call(component, width);
		if (runtime.isPartial !== false || runtime.result === undefined) {
			return this.computeStandaloneRows(component, runtime, descriptor, presentation, width, theme);
		}
		const rows = this.computeStandaloneRows(component, runtime, descriptor, presentation, width, theme);
		if (!byTheme) {
			byTheme = new Map();
			this.componentRowsCache.set(component, byTheme);
		}
		let byWidth = byTheme.get(theme);
		if (!byWidth) {
			byWidth = new Map();
			byTheme.set(theme, byWidth);
		}
		byWidth.set(width, rows);
		return rows;
	}

	private renderGroupMember(component: object, group: RuntimeGroup, width: number, theme: Theme | undefined): string[] {
		if (!group.stable) return this.computeGroupRows(group, width, theme).get(component) ?? [];
		let byTheme = this.groupRowsCache.get(group);
		const cached = byTheme?.get(theme)?.get(width);
		if (cached) return cached.get(component) ?? [];
		const rows = this.computeGroupRows(group, width, theme);
		if (!byTheme) {
			byTheme = new Map();
			this.groupRowsCache.set(group, byTheme);
		}
		let byWidth = byTheme.get(theme);
		if (!byWidth) {
			byWidth = new Map();
			byTheme.set(theme, byWidth);
		}
		byWidth.set(width, rows);
		return rows.get(component) ?? [];
	}

	private category(descriptor: ExplorationToolDescriptor): string {
		return formatCompletedSummary([descriptor]).toLowerCase();
	}

	private summarySections(members: GroupMember[]): Array<{ key: string; text: string; separator: string }> {
		const buckets = new Map<string, ExplorationToolDescriptor[]>();
		for (const { descriptor } of members) {
			const key = this.category(descriptor);
			const bucket = buckets.get(key) ?? [];
			bucket.push(descriptor);
			buckets.set(key, bucket);
		}
		const sections = [...buckets].map(([key, descriptors], index) => {
			const separator = index ? ", " : "";
			const summary = formatCompletedSummary(descriptors);
			return { key, separator, text: separator + (index ? summary.toLowerCase() : summary) };
		});
		const failed = members.filter(({ component }) => (component as RuntimeToolExecution).result?.isError === true).length;
		if (failed) sections.push({ key: "failed", separator: " · ", text: ` · ${failed} failed` });
		return sections;
	}

	private computeGroupRows(group: RuntimeGroup, width: number, theme: Theme | undefined): Map<object, string[]> {
		this.onCustomRowsCompute?.(group);
		const rows = new Map<object, string[]>(group.members.map((member) => [member.component, []]));
		if (group.kind === "completed") {
			const members = group.members.filter(({ component }) => this.isComplete(component) && ((component as RuntimeToolExecution).expanded !== true || this.opened.has(component)));
			const leader = members[0];
			if (leader) {
				const labels = members.map(({ component }) => this.selectionPrefix(component).trim()).filter(Boolean).join(" ");
				const sections = this.summarySections(members);
				const highlight = (section: { key: string; separator: string; text: string }) => {
					const text = section.text.slice(section.separator.length);
					if (!theme || this.hovered?.group !== group || this.hovered.key !== section.key) return section.text;
					// fg() resets to terminal default, not the surrounding summary color.
					const baseColor = section.key === "failed" ? "error" : "muted";
					return section.separator + theme.fg("text", text) + theme.getFgAnsi(baseColor);
				};
				const regular = sections.filter(section => section.key !== "failed").map(highlight).join("");
				const failure = sections.filter(section => section.key === "failed").map(highlight).join("");
				const header = "• " + (theme ? theme.fg("muted", theme.bold(regular)) : regular)
					+ (theme && failure ? theme.fg("error", theme.bold(failure)) : failure);
				rows.set(leader.component, widthSafeLines([header + (labels ? ` ${labels}` : "")], width));
			}
			return rows;
		}
		// Keep the existing compact renderer for the pending subset only.
		group = { ...group, members: group.members.filter(({ component }) => !this.isComplete(component)) };
		if (group.kind === "exploration") {
			let start = 0;
			while (start < group.members.length) {
				while ((group.members[start]?.component as RuntimeToolExecution | undefined)?.expanded === true) start += 1;
				if (start >= group.members.length) break;
				let end = start + 1;
				while (end < group.members.length && (group.members[end]?.component as RuntimeToolExecution | undefined)?.expanded !== true) end += 1;
				const members = group.members.slice(start, end);
				const leader = members[0];
				if (leader) {
					rows.set(
						leader.component,
						this.renderExplorationGroup(members, width, theme),
					);
				}
				start = end + 1;
			}
			return rows;
		}

		const groupable = group.kind === "mutation" ? this.isGroupableMutation.bind(this) : this.isGroupableRemote.bind(this);
		let start = 0;
		while (start < group.members.length) {
			const member = group.members[start];
			if (!member) break;
			const runtime = member.component as RuntimeToolExecution;
			if (runtime.expanded === true) {
				start += 1;
				continue;
			}
			if (!groupable(member)) {
				rows.set(member.component, group.kind === "mutation"
					? this.renderMutation(member.component, runtime, member.descriptor, width, theme)
					: this.renderRemote(member.component, runtime, member.descriptor, width, theme));
				start += 1;
				continue;
			}
			let end = start + 1;
			while (end < group.members.length && groupable(group.members[end])) end += 1;
			const members = group.members.slice(start, end);
			if (members.length < 2) {
				rows.set(member.component, group.kind === "mutation"
					? this.renderMutation(member.component, runtime, member.descriptor, width, theme)
					: this.renderRemote(member.component, runtime, member.descriptor, width, theme));
			} else {
				rows.set(member.component, group.kind === "mutation"
					? this.renderMutationGroup(members, width, theme)
					: this.renderRemoteGroup(members, width, theme));
			}
			start = end;
		}
		return rows;
	}

	private renderExplorationGroup(members: GroupMember[], width: number, theme: Theme | undefined): string[] {
		const settled = this.isSettled(members);
		const lines = [groupedExplorationHeader(theme, settled ? "Explored" : "Exploring", settled ? "success" : "accent")];
		for (let index = 0; index < members.length; index += 1) {
			const member = members[index];
			if (!member) continue;
			const branch = index === members.length - 1 ? "└" : "├";
			const selection = this.selectionPrefix(member.component);
			const text = `  ${branch} ${selection}${member.summary}`;
			lines.push(theme ? theme.fg("muted", text) : text);
		}
		return widthSafeLines(lines, width);
	}

	private renderMutationGroup(members: GroupMember[], width: number, theme: Theme | undefined): string[] {
		const allEdits = members.every((member) => member.descriptor.name.toLowerCase() === "edit");
		const allWrites = members.every((member) => member.descriptor.name.toLowerCase() === "write");
		const pending = members.some((member) => semanticState(member.component as RuntimeToolExecution) === "pending");
		const status = allEdits
			? pending
				? "Editing"
				: "Edited"
			: allWrites
				? pending
					? "Writing"
					: "Wrote"
				: pending
					? "Modifying"
					: "Modified";
		const lines = [statusHeader(theme, status, "", pending ? "accent" : "success")];
		for (let index = 0; index < members.length; index += 1) {
			const member = members[index];
			if (!member) continue;
			const runtime = member.component as RuntimeToolExecution;
			const edit = member.descriptor.name.toLowerCase() === "edit";
			const target = member.summary;
			const state = semanticState(runtime);
			const failed = state === "failure";
			const action = edit
				? state === "pending"
					? "Editing"
					: failed
						? "Edit failed"
						: "Edited"
				: state === "pending"
					? "Writing"
					: failed
						? "Write failed"
						: "Wrote";
			const summary =
				failed && (allEdits || allWrites)
					? `Failed ${target}`
					: allEdits || allWrites
						? target
						: `${action} ${target}`;
			const statistics = failed ? undefined : formatMutationStatistics(member.descriptor, runtime.result?.details);
			const compactStatistics = edit ? statistics?.replace(/ lines$/, "") : statistics;
			const branch = index === members.length - 1 ? "└" : "├";
			const text = `  ${branch} ${this.selectionPrefix(member.component)}${summary}${compactStatistics ? ` (${compactStatistics})` : ""}`;
			lines.push(theme ? theme.fg(failed ? "error" : "muted", text) : text);
		}
		return widthSafeLines(lines, width);
	}

	private isGroupableMutation(member: GroupMember | undefined): boolean {
		if (!member) return false;
		const runtime = member.component as RuntimeToolExecution;
		return runtime.expanded !== true;
	}

	private renderRemoteGroup(members: GroupMember[], width: number, theme: Theme | undefined): string[] {
		const pending = members.some((member) => semanticState(member.component as RuntimeToolExecution) === "pending");
		const lines = [statusHeader(theme, pending ? "Calling" : "Called", "", pending ? "accent" : "success")];
		for (let index = 0; index < members.length; index += 1) {
			const member = members[index];
			if (!member) continue;
			const branch = index === members.length - 1 ? "└" : "├";
			const text = `  ${branch} ${this.selectionPrefix(member.component)}${member.summary}`;
			lines.push(theme ? theme.fg("muted", text) : text);
		}
		return widthSafeLines(lines, width);
	}

	private isGroupableRemote(member: GroupMember | undefined): boolean {
		if (!member) return false;
		const runtime = member.component as RuntimeToolExecution;
		return runtime.expanded !== true && semanticState(runtime) !== "failure";
	}

	private computeStandaloneRows(
		component: object,
		runtime: RuntimeToolExecution,
		descriptor: ExplorationToolDescriptor,
		presentation: "mutation" | "command" | "remote",
		width: number,
		theme: Theme | undefined,
	): string[] {
		this.onCustomRowsCompute?.(component);
		switch (presentation) {
			case "mutation":
				return this.renderMutation(component, runtime, descriptor, width, theme);
			case "command":
				return this.renderCommand(component, runtime, descriptor, width, theme);
			case "remote":
				return this.renderRemote(component, runtime, descriptor, width, theme);
		}
	}

	private renderMutation(
		component: object,
		runtime: RuntimeToolExecution,
		descriptor: ExplorationToolDescriptor,
		width: number,
		theme: Theme | undefined,
	): string[] {
		const state = semanticState(runtime);
		const edit = descriptor.name.toLowerCase() === "edit";
		const status =
			state === "pending" ? (edit ? "Editing" : "Writing") : state === "success" ? (edit ? "Edited" : "Wrote") : edit ? "Edit failed" : "Write failed";
		const color: StatusColor = state === "pending" ? "accent" : state === "success" ? "success" : "error";
		const lines = [statusHeader(theme, status, formatMutationTarget(descriptor), color, this.selectionLabels.get(component))];
		const statistics = formatMutationStatistics(descriptor, runtime.result?.details);
		if (statistics) lines.push(detailLine(theme, statistics));
		if (state === "failure") {
			for (const output of this.normalizedOutput(runtime, 1)) lines.push(detailLine(theme, output, true));
		}
		return widthSafeLines(lines, width);
	}

	private renderCommand(
		component: object,
		runtime: RuntimeToolExecution,
		descriptor: ExplorationToolDescriptor,
		width: number,
		theme: Theme | undefined,
	): string[] {
		const state = semanticState(runtime);
		// Script output starts with a wall-time header and is meant for the model;
		// the expanded view (pi's own renderer) shows it in full.
		const script = descriptor.name.toLowerCase() === CODEMODE_TOOL_NAME;
		const status =
			state === "pending"
				? "Running"
				: state === "success"
					? "Ran"
					: script
							? "Script failed"
							: "Command failed";
		const color: StatusColor = state === "pending" ? "accent" : state === "success" ? "success" : "error";
		const summary = formatCommandSummary(descriptor);
		const lines = [statusHeader(theme, status, summary, color, this.selectionLabels.get(component))];
		if (!script) {
			for (const output of this.normalizedOutput(runtime, 3)) {
				lines.push(detailLine(theme, output, state === "failure"));
			}
		}
		return widthSafeLines(lines, width);
	}

	private renderRemote(
		component: object,
		runtime: RuntimeToolExecution,
		descriptor: ExplorationToolDescriptor,
		width: number,
		theme: Theme | undefined,
	): string[] {
		const state = semanticState(runtime);
		const status = state === "pending" ? "Calling" : state === "success" ? "Called" : "Call failed";
		const color: StatusColor = state === "pending" ? "accent" : state === "success" ? "success" : "error";
		const lines = [statusHeader(theme, status, formatRemoteActionSummary(descriptor), color, this.selectionLabels.get(component))];
		if (state === "failure") {
			for (const output of this.normalizedOutput(runtime, 1)) lines.push(detailLine(theme, output, true));
		}
		return widthSafeLines(lines, width);
	}

	private currentTheme(): Theme | undefined {
		const theme = this.getTheme();
		const generation = (globalThis as Record<symbol, Theme | undefined>)[ACTIVE_THEME_KEY];
		if (!this.themeInitialized) {
			this.themeInitialized = true;
			this.activeTheme = theme;
			this.activeThemeGeneration = generation;
		} else if (theme !== this.activeTheme || generation !== this.activeThemeGeneration) {
			this.activeTheme = theme;
			this.activeThemeGeneration = generation;
			this.groupRowsCache = new WeakMap();
			this.componentRowsCache = new WeakMap();
		}
		return theme;
	}

	private invalidateRows(component: object): void {
		if (this.hovered?.group === this.sequences.get(component)) this.clearHover();
		this.mouseRows.delete(component);
		const sequence = this.sequences.get(component);
		if (sequence) this.groupRowsCache.delete(sequence);
		const membership = this.memberships.get(component);
		if (membership) this.groupRowsCache.delete(membership.group);
		this.componentRowsCache.delete(component);
	}

	private descriptor(component: object): ExplorationToolDescriptor | undefined {
		const runtime = component as RuntimeToolExecution;
		const cached = this.descriptorCache.get(component);
		if (
			cached &&
			Object.is(cached.args, runtime.args) &&
			cached.toolName === runtime.toolName &&
			cached.toolDefinition === runtime.toolDefinition &&
			cached.builtInToolDefinition === runtime.builtInToolDefinition
		) {
			return cached.descriptor;
		}
		const descriptor = runtimeDescriptor(component);
		this.descriptorCache.set(component, {
			args: runtime.args,
			toolName: runtime.toolName,
			toolDefinition: runtime.toolDefinition,
			builtInToolDefinition: runtime.builtInToolDefinition,
			descriptor,
		});
		return descriptor;
	}

	private normalizedOutput(runtime: RuntimeToolExecution, maxLines: number): string[] {
		const result = runtime.result;
		if (runtime.isPartial !== false || result === undefined) {
			return compactTextOutput(result, maxLines, this.onCompactTextOutputNormalize);
		}
		let byMaxLines = this.normalizedOutputCache.get(result);
		const cached = byMaxLines?.get(maxLines);
		if (cached) return cached;
		const normalized = compactTextOutput(result, maxLines, this.onCompactTextOutputNormalize);
		if (!byMaxLines) {
			byMaxLines = new Map();
			this.normalizedOutputCache.set(result, byMaxLines);
		}
		byMaxLines.set(maxLines, normalized);
		return normalized;
	}

	private selectionPrefix(component: object): string {
		const label = this.selectionLabels.get(component);
		return label ? `[${label}] ` : "";
	}

	private labelOriginal(component: object, lines: string[], width: number): string[] {
		const prefix = this.selectionPrefix(component);
		if (!prefix) return lines;
		const index = lines.findIndex((line) => line.length > 0);
		if (index < 0) return lines;
		const labeled = [...lines];
		labeled[index] = truncateToWidth(`${prefix}${labeled[index]}`, Math.max(0, width), "…");
		return labeled;
	}

	private isComplete(component: object): boolean {
		const runtime = component as RuntimeToolExecution;
		return runtime.isPartial === false && runtime.result !== undefined;
	}

	private isSettled(members: GroupMember[]): boolean {
		return members.every((member) => {
			const runtime = member.component as RuntimeToolExecution;
			return runtime.isPartial === false && runtime.result !== undefined;
		});
	}

	private rebuildParent(parent: object, state: ParentState): void {
		this.clearHover();
		for (const component of state.components) {
			this.mouseRows.delete(component);
			this.opened.delete(component);
		}
		for (const component of state.components) {
			this.memberships.delete(component);
			this.sequences.delete(component);
		}
		let sequence: RuntimeGroup | undefined;
		for (const component of state.components) {
			const descriptor = this.descriptor(component);
			if (descriptor) {
				// Only completed members contribute rows. Mutators invalidate this cache even while siblings run.
				sequence ??= { kind: "completed", members: [], stable: true };
				sequence.members.push({ component, descriptor, summary: "" });
				this.sequences.set(component, sequence);
			} else if (component instanceof this.userClass || hasVisibleAssistantText(component)) {
				sequence = undefined;
			}
		}
		this.addMemberships(state);
		this.onParentRebuild?.(parent);
	}

	private addMemberships(state: ParentState): void {
		const tools: Array<{ component: object; index: number; descriptor: ExplorationToolDescriptor }> = [];
		for (let index = 0; index < state.components.length; index += 1) {
			const component = state.components[index];
			if (!component) continue;
			const descriptor = this.descriptor(component);
			if (descriptor) tools.push({ component, index, descriptor });
		}
		let breakBeforeNextExploration = false;
		const explorationItems: ExplorationGroupItem[] = [];
		for (let index = 0; index < state.components.length; index += 1) {
			const component = state.components[index];
			if (!component) continue;
			const descriptor = this.descriptor(component);
			if (!descriptor) {
				if (component instanceof this.userClass || hasVisibleAssistantText(component)) {
					breakBeforeNextExploration = true;
				}
				continue;
			}
			const exploration = isExplorationTool(descriptor);
			explorationItems.push({
				id: componentId(component, index),
				exploration,
				breakBefore: exploration && breakBeforeNextExploration,
			});
			breakBeforeNextExploration = false;
		}
		const grouped = groupExplorationItems(explorationItems);
		const byId = new Map(tools.map((tool) => [componentId(tool.component, tool.index), tool]));
		for (const groupedItems of grouped) {
			const members: GroupMember[] = [];
			for (const item of groupedItems.items) {
				const match = byId.get(item.id);
				if (match) {
					members.push({
						component: match.component,
						descriptor: match.descriptor,
						summary: formatExplorationSummary(match.descriptor),
					});
				}
			}
			if (members.length === 0) continue;
			const group: RuntimeGroup = { kind: "exploration", members, stable: this.isSettled(members) };
			for (let index = 0; index < members.length; index += 1) {
				const member = members[index];
				if (member) this.memberships.set(member.component, { group, index });
			}
		}

		let mutationMembers: GroupMember[] = [];
		const addMutationGroup = () => {
			if (mutationMembers.length >= 2) {
				const group: RuntimeGroup = { kind: "mutation", members: mutationMembers, stable: this.isSettled(mutationMembers) };
				for (let index = 0; index < mutationMembers.length; index += 1) {
					const member = mutationMembers[index];
					if (member) this.memberships.set(member.component, { group, index });
				}
			}
			mutationMembers = [];
		};
		for (const component of state.components) {
			const descriptor = this.descriptor(component);
			if (descriptor && classifyToolPresentation(descriptor) === "mutation") {
				mutationMembers.push({ component, descriptor, summary: formatMutationTarget(descriptor) });
			} else if (descriptor || component instanceof this.userClass || hasVisibleAssistantText(component)) {
				addMutationGroup();
			}
		}
		addMutationGroup();

		let remoteMembers: GroupMember[] = [];
		const addRemoteGroup = () => {
			if (remoteMembers.length >= 2) {
				const group: RuntimeGroup = { kind: "remote", members: remoteMembers, stable: this.isSettled(remoteMembers) };
				for (let index = 0; index < remoteMembers.length; index += 1) {
					const member = remoteMembers[index];
					if (member) this.memberships.set(member.component, { group, index });
				}
			}
			remoteMembers = [];
		};
		for (const component of state.components) {
			const descriptor = this.descriptor(component);
			if (descriptor && classifyToolPresentation(descriptor) === "remote") {
				remoteMembers.push({ component, descriptor, summary: formatRemoteActionSummary(descriptor) });
			} else if (descriptor || component instanceof this.userClass || hasVisibleAssistantText(component)) {
				addRemoteGroup();
			}
		}
		addRemoteGroup();
	}
}

export function installToolCallGroupingPatch(options: PatchOptions): PatchHandle {
	const globals = globalThis as PatchGlobal;
	const existing = globals[PATCH_KEY];
	if (existing) return existing.handle;

	const toolClass = options.toolClass ?? ToolExecutionComponent;
	const assistantClass = options.assistantClass ?? AssistantMessageComponent;
	const userClass = options.userClass ?? UserMessageComponent;
	const containerClass = options.containerClass ?? Container;
	const toolPrototype = toolClass.prototype as unknown as Record<string, unknown>;
	const assistantPrototype = assistantClass.prototype as unknown as Record<string, unknown>;
	const containerPrototype = containerClass.prototype as unknown as Record<string, unknown>;
	const originalRender = toolPrototype.render;
	const originalMouse = toolPrototype.handleMouse;
	const originalInvalidate = toolPrototype.invalidate;
	const originalUpdateArgs = toolPrototype.updateArgs;
	const originalUpdateResult = toolPrototype.updateResult;
	const originalSetExpanded = toolPrototype.setExpanded;
	const originalUpdateAssistantContent = assistantPrototype.updateContent;
	const originalContainerRender = containerPrototype.render;
	const originalContainerMouse = containerPrototype.handleMouse;
	const originalAddChild = containerPrototype.addChild;
	const originalRemoveChild = containerPrototype.removeChild;
	const originalClear = containerPrototype.clear;

	if (
		typeof originalRender !== "function" ||
		typeof originalMouse !== "function" ||
		typeof originalInvalidate !== "function" ||
		typeof originalUpdateArgs !== "function" ||
		typeof originalUpdateResult !== "function" ||
		typeof originalSetExpanded !== "function" ||
		typeof originalUpdateAssistantContent !== "function" ||
		typeof originalContainerRender !== "function" ||
		typeof originalAddChild !== "function" ||
		typeof originalRemoveChild !== "function" ||
		typeof originalClear !== "function"
	) {
		return {
			installed: false,
			reason: "Incompatible ToolExecutionComponent or Container prototype",
			beginSelection: () => [],
			cancelSelection() {},
			expandSelection: () => false,
			reset() {},
			restore() {},
		};
	}

	const render = originalRender as RenderMethod;
	const updateArgs = originalUpdateArgs as UpdateArgsMethod;
	const updateResult = originalUpdateResult as UpdateResultMethod;
	const setExpanded = originalSetExpanded as SetExpandedMethod;
	const updateAssistantContent = originalUpdateAssistantContent as UpdateAssistantContentMethod;
	const containerRender = originalContainerRender as ContainerRenderMethod;
	const addChild = originalAddChild as AddChildMethod;
	const removeChild = originalRemoveChild as RemoveChildMethod;
	const clear = originalClear as ClearMethod;
	const runtime = new GroupingRuntime(
		options.getTheme,
		options.hidePending ?? HIDE_PENDING_CALLS,
		updateAssistantContent,
		userClass,
		options.onParentRebuild,
		options.onCompactTextOutputNormalize,
		options.onCustomRowsCompute,
	);
	let restored = false;

	const wrappedRender: RenderMethod = function (width) {
		return runtime.render(this, width, render, setExpanded);
	};
	const wrappedInvalidate = function (this: object) {
		(originalInvalidate as (this: object) => void).call(this);
		runtime.expansionChanged(this);
	};
	const wrappedMouse: MouseMethod = function (event) {
		const changed = runtime.leaveForEvent(event);
		const result = runtime.handleMouse(this, event, originalMouse as MouseMethod);
		return changed && event.type === "move" ? { ...result, handled: true, render: true } : result;
	};
	const wrappedUpdateArgs: UpdateArgsMethod = function (args) {
		updateArgs.call(this, args);
		runtime.argsChanged(this);
	};
	const wrappedUpdateResult: UpdateResultMethod = function (result, isPartial) {
		updateResult.call(this, result, isPartial);
		runtime.resultChanged(this);
	};
	const wrappedSetExpanded: SetExpandedMethod = function (expanded) {
		setExpanded.call(this, expanded);
		runtime.keyboardExpansionChanged(this);
	};
	const wrappedUpdateAssistantContent: UpdateAssistantContentMethod = function (message) {
		runtime.updateAssistant(this, message);
	};
	const wrappedContainerMouse: MouseMethod = function (event) {
		const changed = runtime.leaveForEvent(event);
		const result = (originalContainerMouse as MouseMethod).call(this, event);
		// Only moves may be consumed to request a leave repaint. Preserve wheel/drag/click routing.
		if (changed && event.type === "move") return { ...result, handled: true, render: true };
		return result;
	};
	const wrappedContainerRender: ContainerRenderMethod = function (width) {
		runtime.adopt(
			this,
			this.children.filter(
				(component) =>
					component instanceof toolClass ||
					component instanceof assistantClass ||
					component instanceof userClass,
			),
			assistantClass,
		);
		return containerRender.call(this, width);
	};
	const wrappedAddChild: AddChildMethod = function (component) {
		addChild.call(this, component);
		if (
			component instanceof toolClass ||
			component instanceof assistantClass ||
			component instanceof userClass
		) {
			runtime.observe(this, component, component instanceof assistantClass);
		}
	};
	const wrappedRemoveChild: RemoveChildMethod = function (component) {
		removeChild.call(this, component);
		if (
			component instanceof toolClass ||
			component instanceof assistantClass ||
			component instanceof userClass
		)
			runtime.forget(this, component);
	};
	const wrappedClear: ClearMethod = function () {
		clear.call(this);
		runtime.clear(this);
	};

	toolPrototype.render = wrappedRender;
	toolPrototype.handleMouse = wrappedMouse;
	toolPrototype.invalidate = wrappedInvalidate;
	toolPrototype.updateArgs = wrappedUpdateArgs;
	toolPrototype.updateResult = wrappedUpdateResult;
	toolPrototype.setExpanded = wrappedSetExpanded;
	assistantPrototype.updateContent = wrappedUpdateAssistantContent;
	containerPrototype.render = wrappedContainerRender;
	containerPrototype.handleMouse = wrappedContainerMouse;
	containerPrototype.addChild = wrappedAddChild;
	containerPrototype.removeChild = wrappedRemoveChild;
	containerPrototype.clear = wrappedClear;

	const handle: PatchHandle = {
		installed: true,
		beginSelection: () => runtime.beginSelection(),
		cancelSelection: () => runtime.cancelSelection(),
		expandSelection: (label) => runtime.expandSelection(label),
		reset: () => runtime.reset(),
		restore: () => {
			if (restored) return;
			restored = true;
			if (toolPrototype.invalidate === wrappedInvalidate) toolPrototype.invalidate = originalInvalidate;
			if (toolPrototype.handleMouse === wrappedMouse) toolPrototype.handleMouse = originalMouse;
			if (toolPrototype.render === wrappedRender) toolPrototype.render = render;
			if (toolPrototype.updateArgs === wrappedUpdateArgs) toolPrototype.updateArgs = updateArgs;
			if (toolPrototype.updateResult === wrappedUpdateResult) toolPrototype.updateResult = updateResult;
			if (toolPrototype.setExpanded === wrappedSetExpanded) toolPrototype.setExpanded = setExpanded;
			if (assistantPrototype.updateContent === wrappedUpdateAssistantContent) {
				assistantPrototype.updateContent = updateAssistantContent;
			}
			if (containerPrototype.handleMouse === wrappedContainerMouse) containerPrototype.handleMouse = originalContainerMouse;
			if (containerPrototype.render === wrappedContainerRender) containerPrototype.render = containerRender;
			if (containerPrototype.addChild === wrappedAddChild) containerPrototype.addChild = addChild;
			if (containerPrototype.removeChild === wrappedRemoveChild) containerPrototype.removeChild = removeChild;
			if (containerPrototype.clear === wrappedClear) containerPrototype.clear = clear;
			if (globals[PATCH_KEY]?.handle === handle) delete globals[PATCH_KEY];
			runtime.reset();
		},
	};
	globals[PATCH_KEY] = { handle };
	return handle;
}
