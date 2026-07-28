import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, truncateToWidth } from "@earendil-works/pi-tui";
import {
	classifyToolPresentation,
	type ExplorationToolDescriptor,
	formatCommandSummary,
	formatExplorationSummary,
	formatMutationStatistics,
	formatMutationTarget,
	formatRemoteActionSummary,
	generateSelectionLabels,
	groupExplorationItems,
	isExplorationTool,
} from "./logic.ts";

const PATCH_KEY = Symbol.for("pi.tool-call-grouping.patch.v7");
const ACTIVE_THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

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
	kind: "exploration" | "mutation" | "remote";
	members: GroupMember[];
	stable: boolean;
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
	getTheme: () => Theme | undefined;
	toolClass?: typeof ToolExecutionComponent;
	assistantClass?: typeof AssistantMessageComponent;
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

function hasAssistantBoundaryContent(component: object): boolean {
	const assistant = component as RuntimeAssistantMessage;
	if (hasVisibleAssistantText(component)) return true;
	if (typeof assistant.updateContent !== "function" || !isRecord(assistant.lastMessage)) return false;
	const content = assistant.lastMessage.content;
	return Array.isArray(content) && content.some((item) => isRecord(item) && item.type === "toolCall");
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
type StatusColor = "accent" | "success" | "error";

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
	private parentStates = new Map<object, ParentState>();
	private memberships = new WeakMap<object, RuntimeMembership>();
	private componentParents = new WeakMap<object, object>();
	private descriptorCache = new WeakMap<object, DescriptorCacheEntry>();
	private normalizedOutputCache = new WeakMap<RuntimeToolResult, Map<number, string[]>>();
	private groupRowsCache = new WeakMap<RuntimeGroup, Map<Theme | undefined, Map<number, Map<object, string[]>>>>();
	private componentRowsCache = new WeakMap<object, Map<Theme | undefined, Map<number, string[]>>>();
	private selectionLabels = new Map<object, string>();
	private assistantContentStates = new Map<object, AssistantContentState>();
	private adoptedParents = new WeakSet<object>();
	private readonly updateAssistantContent: UpdateAssistantContentMethod;
	private readonly getTheme: () => Theme | undefined;
	private readonly onParentRebuild: ((parent: object) => void) | undefined;
	private readonly onCompactTextOutputNormalize: (() => void) | undefined;
	private readonly onCustomRowsCompute: ((target: object) => void) | undefined;
	private themeInitialized = false;
	private activeTheme: Theme | undefined;
	private activeThemeGeneration: Theme | undefined;

	constructor(
		getTheme: () => Theme | undefined,
		updateAssistantContent: UpdateAssistantContentMethod,
		onParentRebuild?: (parent: object) => void,
		onCompactTextOutputNormalize?: () => void,
		onCustomRowsCompute?: (target: object) => void,
	) {
		this.getTheme = getTheme;
		this.updateAssistantContent = updateAssistantContent;
		this.onParentRebuild = onParentRebuild;
		this.onCompactTextOutputNormalize = onCompactTextOutputNormalize;
		this.onCustomRowsCompute = onCustomRowsCompute;
	}

	reset(): void {
		this.restoreAllAssistantContent();
		this.parentStates.clear();
		this.memberships = new WeakMap();
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
				if (this.descriptor(component) && runtime.expanded !== true && !targets.includes(component)) targets.push(component);
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
			this.invalidateRows(component);
			this.memberships.delete(component);
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
		this.invalidateRows(component);
		this.memberships.delete(component);
		this.descriptorCache.delete(component);
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
			this.invalidateRows(component);
			this.memberships.delete(component);
			this.descriptorCache.delete(component);
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
		if (!parent) return;
		const state = this.parentStates.get(parent);
		if (state) this.rebuildParent(parent, state);
	}

	resultChanged(component: object): void {
		this.invalidateRows(component);
		const membership = this.memberships.get(component);
		if (membership) membership.group.stable = this.isSettled(membership.group.members);
	}

	expansionChanged(component: object): void {
		this.invalidateRows(component);
	}

	render(component: object, width: number, originalRender: RenderMethod): string[] {
		const runtime = component as RuntimeToolExecution;
		if (runtime.expanded === true) return originalRender.call(component, width);
		const theme = this.currentTheme();
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

	private computeGroupRows(group: RuntimeGroup, width: number, theme: Theme | undefined): Map<object, string[]> {
		this.onCustomRowsCompute?.(group);
		const rows = new Map<object, string[]>(group.members.map((member) => [member.component, []]));
		if (group.kind === "exploration") {
			let start = 0;
			while (start < group.members.length) {
				while ((group.members[start]?.component as RuntimeToolExecution | undefined)?.expanded === true) start += 1;
				if (start >= group.members.length) break;
				let end = start + 1;
				while (end < group.members.length && (group.members[end]?.component as RuntimeToolExecution | undefined)?.expanded !== true) end += 1;
				const members = group.members.slice(start, end);
				const leader = members[0];
				if (leader) rows.set(leader.component, this.renderExplorationGroup(members, width, theme));
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
			const action = edit ? (state === "pending" ? "Editing" : "Edited") : state === "pending" ? "Writing" : "Wrote";
			const summary = allEdits || allWrites ? target : `${action} ${target}`;
			const statistics = formatMutationStatistics(member.descriptor, runtime.result?.details);
			const compactStatistics = edit ? statistics?.replace(/ lines$/, "") : statistics;
			const branch = index === members.length - 1 ? "└" : "├";
			const text = `  ${branch} ${this.selectionPrefix(member.component)}${summary}${compactStatistics ? ` (${compactStatistics})` : ""}`;
			lines.push(theme ? theme.fg("muted", text) : text);
		}
		return widthSafeLines(lines, width);
	}

	private isGroupableMutation(member: GroupMember | undefined): boolean {
		if (!member) return false;
		const runtime = member.component as RuntimeToolExecution;
		return runtime.expanded !== true && semanticState(runtime) !== "failure";
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
		const status = state === "pending" ? "Running" : state === "success" ? "Ran" : "Command failed";
		const color: StatusColor = state === "pending" ? "accent" : state === "success" ? "success" : "error";
		const lines = [statusHeader(theme, status, formatCommandSummary(descriptor), color, this.selectionLabels.get(component))];
		for (const output of this.normalizedOutput(runtime, 3)) {
			lines.push(detailLine(theme, output, state === "failure"));
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

	private isSettled(members: GroupMember[]): boolean {
		return members.every((member) => {
			const runtime = member.component as RuntimeToolExecution;
			return runtime.isPartial === false && runtime.result !== undefined;
		});
	}

	private rebuildParent(parent: object, state: ParentState): void {
		for (const component of state.components) this.memberships.delete(component);
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
		const grouped = groupExplorationItems(
			tools.map(({ component, index, descriptor }) => ({
				id: componentId(component, index),
				exploration: isExplorationTool(descriptor),
			})),
		);
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
			} else if (descriptor || hasVisibleAssistantText(component)) {
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
			} else if (descriptor || hasAssistantBoundaryContent(component)) {
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
	const containerClass = options.containerClass ?? Container;
	const toolPrototype = toolClass.prototype as unknown as Record<string, unknown>;
	const assistantPrototype = assistantClass.prototype as unknown as Record<string, unknown>;
	const containerPrototype = containerClass.prototype as unknown as Record<string, unknown>;
	const originalRender = toolPrototype.render;
	const originalUpdateArgs = toolPrototype.updateArgs;
	const originalUpdateResult = toolPrototype.updateResult;
	const originalSetExpanded = toolPrototype.setExpanded;
	const originalUpdateAssistantContent = assistantPrototype.updateContent;
	const originalContainerRender = containerPrototype.render;
	const originalAddChild = containerPrototype.addChild;
	const originalRemoveChild = containerPrototype.removeChild;
	const originalClear = containerPrototype.clear;

	if (
		typeof originalRender !== "function" ||
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
		updateAssistantContent,
		options.onParentRebuild,
		options.onCompactTextOutputNormalize,
		options.onCustomRowsCompute,
	);
	let restored = false;

	const wrappedRender: RenderMethod = function (width) {
		return runtime.render(this, width, render);
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
		runtime.expansionChanged(this);
	};
	const wrappedUpdateAssistantContent: UpdateAssistantContentMethod = function (message) {
		runtime.updateAssistant(this, message);
	};
	const wrappedContainerRender: ContainerRenderMethod = function (width) {
		runtime.adopt(
			this,
			this.children.filter(
				(component) => component instanceof toolClass || component instanceof assistantClass,
			),
			assistantClass,
		);
		return containerRender.call(this, width);
	};
	const wrappedAddChild: AddChildMethod = function (component) {
		addChild.call(this, component);
		if (component instanceof toolClass || component instanceof assistantClass) {
			runtime.observe(this, component, component instanceof assistantClass);
		}
	};
	const wrappedRemoveChild: RemoveChildMethod = function (component) {
		removeChild.call(this, component);
		if (component instanceof toolClass || component instanceof assistantClass) runtime.forget(this, component);
	};
	const wrappedClear: ClearMethod = function () {
		clear.call(this);
		runtime.clear(this);
	};

	toolPrototype.render = wrappedRender;
	toolPrototype.updateArgs = wrappedUpdateArgs;
	toolPrototype.updateResult = wrappedUpdateResult;
	toolPrototype.setExpanded = wrappedSetExpanded;
	assistantPrototype.updateContent = wrappedUpdateAssistantContent;
	containerPrototype.render = wrappedContainerRender;
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
			if (toolPrototype.render === wrappedRender) toolPrototype.render = render;
			if (toolPrototype.updateArgs === wrappedUpdateArgs) toolPrototype.updateArgs = updateArgs;
			if (toolPrototype.updateResult === wrappedUpdateResult) toolPrototype.updateResult = updateResult;
			if (toolPrototype.setExpanded === wrappedSetExpanded) toolPrototype.setExpanded = setExpanded;
			if (assistantPrototype.updateContent === wrappedUpdateAssistantContent) {
				assistantPrototype.updateContent = updateAssistantContent;
			}
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
