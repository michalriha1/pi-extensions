import type { AssistantMessage } from "../../../packages/ai/src/types.ts";
import {
	AssistantMessageComponent,
	createBashToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	initTheme,
	theme as activeTheme,
	type Theme,
	type ToolDefinition,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import toolCallGroupingExtension from "./index.ts";
import {
	classifyToolPresentation,
	type ExplorationToolDescriptor,
	formatExplorationSummary,
	formatRemoteActionSummary,
	generateSelectionLabels,
	groupExplorationItems,
	isExplorationTool,
	isReadOnlyShellCommand,
} from "./logic.ts";
import { installToolCallGroupingPatch } from "./patch.ts";

function fakeTui(): TUI {
	return { requestRender() {} } as unknown as TUI;
}

function component(
	name: string,
	id: string,
	args: Record<string, unknown>,
	definition?: ToolDefinition,
): ToolExecutionComponent {
	return new ToolExecutionComponent(name, id, args, {}, definition, fakeTui(), process.cwd());
}

function thinkingMessage(toolCallId?: string, toolName?: string, text?: string): AssistantMessage {
	const content = [
		{ type: "thinking", thinking: "hidden reasoning" },
		...(text ? [{ type: "text", text }] : []),
		...(toolCallId && toolName ? [{ type: "toolCall", id: toolCallId, name: toolName, arguments: {} }] : []),
	];
	return {
		role: "assistant",
		content,
		stopReason: toolCallId ? "toolUse" : "stop",
	} as unknown as AssistantMessage;
}

function thinkingComponent(toolCallId: string, toolName: string, text?: string): AssistantMessageComponent {
	return new AssistantMessageComponent(thinkingMessage(toolCallId, toolName, text), true);
}

function customDefinition(name = "deploy_service", label = "Deploy service"): ToolDefinition {
	return {
		name,
		label,
		description: "Perform a remote action",
		parameters: Type.Record(Type.String(), Type.Unknown()),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
	};
}

function mcpDefinition(): ToolDefinition {
	return {
		...customDefinition("mcp", "MCP"),
		description: "Proxy operations to MCP servers",
	};
}

let activePatch: ReturnType<typeof installToolCallGroupingPatch> | undefined;

beforeAll(() => initTheme("dark"));

afterEach(() => {
	activePatch?.restore();
	activePatch = undefined;
});

describe("exploration classification", () => {
	test.each(["read", "grep", "find", "ls"])("classifies built-in %s", (name) => {
		expect(isExplorationTool({ name })).toBe(true);
	});

	test.each(["web_search", "fetch_content", "get_search_content"])(
		"classifies pi-web-access tool %s explicitly",
		(name) => {
			expect(isExplorationTool({ name, description: "description without retrieval keywords" })).toBe(true);
		},
	);

	test("classifies Explore subagents and subagent result retrieval", () => {
		expect(isExplorationTool({ name: "Agent", args: { subagent_type: "Explore" } })).toBe(true);
		expect(isExplorationTool({ name: "get_subagent_result", args: { agent_id: "agent-1" } })).toBe(true);
		expect(isExplorationTool({ name: "Agent", args: { subagent_type: "Plan" } })).toBe(false);
		expect(isExplorationTool({ name: "Agent", args: { subagent_type: "general-purpose" } })).toBe(false);
	});

	test("classifies retrieval MCP operations and rejects auth, connection, and mutation operations", () => {
		expect(isExplorationTool({ name: "mcp", args: { server: "jira", tool: "get_issue" } })).toBe(true);
		expect(isExplorationTool({ name: "mcp", args: { server: "jira", search: "open issues" } })).toBe(true);
		expect(isExplorationTool({ name: "mcp", args: { describe: "custom_tool" } })).toBe(true);
		expect(isExplorationTool({ name: "mcp", args: { server: "jira" } })).toBe(true);
		expect(isExplorationTool({ name: "mcp", args: { server: "jira", action: "connect" } })).toBe(false);
		expect(isExplorationTool({ name: "mcp", args: { tool: "search_issues", action: "disconnect" } })).toBe(false);
		expect(isExplorationTool({ name: "mcp", args: { tool: "search_issues", action: "upsert_issue" } })).toBe(false);
		expect(isExplorationTool({ name: "mcp", args: { tool: "search_issues", action: "subscribe" } })).toBe(false);
		expect(isExplorationTool({ name: "mcp", args: { tool: "search_issues", action: "delete_issue" } })).toBe(false);
		expect(isExplorationTool({ name: "mcp", args: {} })).toBe(false);
	});

	test.each([
		"pwd",
		"ls -la",
		'rg "needle value" packages | head -20',
		"/usr/bin/find . -name '*.ts'",
		"git -C ../codex diff --stat",
		"git -C ../codex log --oneline -10",
		"git -C ../codex blame -L 1,20 -- README.md",
		"git -C ../codex status --short && git -C ../codex log --oneline -5 && git -C ../codex blame -L 1,20 -- README.md",
		"git blame -L 1,20 -- packages/coding-agent/src/core/tools/bash.ts",
		"git log --oneline -10",
		"git blame -L 195,220 CampaignManager.cs; git show $(git log --all -S'normalizedKeywords' --format='%H' -- CampaignManager.cs | tail -1) -- CampaignManager.cs | head -220",
		"git show \"$(git log -1 --format='%H')\" -- README.md",
		"realpath .pi/extensions/tool-call-grouping/logic.ts",
		"diff -q logic.ts ../logic.ts && git diff --check && git diff --stat",
		"ls -la node_modules/vitest 2>/dev/null; find node_modules -path '*/vitest/dist/cli.js' -print | head",
		"find . -iname '*tool-call-group*' | head -50 && rg -n 'tool-call-group' .pi packages 2>/dev/null | head -200",
		"find ~/.pi -type f -maxdepth 5 2> /dev/null | rg 'tool-call|group'",
		"sed -n '1,20p' README.md",
		"wc -l .pi/extensions/tool-call-grouping/*.ts; find .pi/extensions/tool-call-grouping -name '*.json'",
		"find . -iname '*tool*call*group*' -o -path '*tool-call-grouping*'; find ../codex -maxdepth 2 -type f | head -80; git status --short",
		'rg -n "decodeTextSignature|parseTextSignature|TextSignatureV1|textSignature" packages/ai/src | head -100; rg -n "textSignature" packages/coding-agent/src | head -80',
		"find ../codex/codex-rs/tui/src -path '*snapshots*' -type f | xargs rg -L 'Running|Ran|Explored|Edited|Added|Deleted' | head -40",
		"find . -type f -print0 | xargs -0 rg needle | head -40",
	])("classifies read-only shell command: %s", (command) => {
		expect(isReadOnlyShellCommand(command)).toBe(true);
		expect(isExplorationTool({ name: "bash", args: { command } })).toBe(true);
		expect(isExplorationTool({ name: "hypa_shell", args: { command } })).toBe(true);
	});

	test.each([
		"rm -rf tmp",
		"cat file > copy",
		"cat file >/tmp/copy",
		"cat file >>/dev/null",
		"rg needle | xargs rm",
		"find . | xargs sh -c 'touch changed'",
		"find . | xargs --unknown rg needle",
		"find . -delete",
		"find . -exec cat {} \\;",
		"sed -i 's/a/b/' file",
		"sed 's/a/b/w output' file",
		"sort -o output file",
		"tree -o output .",
		"echo $(touch file)",
		"git show \"$(touch file)\"",
		"git show $(git log",
		"git status && touch file",
		"git status &&",
		"wc -l README.md; touch file",
		"wc -l README.md\ntouch file",
		"git diff --output=patch.diff",
		"git -C ../codex commit -m test",
		"curl https://example.com",
	])("rejects potentially mutating shell command: %s", (command) => {
		expect(isReadOnlyShellCommand(command)).toBe(false);
		expect(isExplorationTool({ name: "bash", args: { command } })).toBe(false);
		expect(isExplorationTool({ name: "hypa_shell", args: { command } })).toBe(false);
	});

	test("conservatively classifies direct custom tools from metadata tokens", () => {
		expect(isExplorationTool({ name: "jira_get_issue", label: "Get issue" })).toBe(true);
		expect(isExplorationTool({ name: "database", description: "Query the reporting database" })).toBe(true);
		expect(isExplorationTool({ name: "forgetful", description: "Manage memory" })).toBe(false);
		expect(isExplorationTool({ name: "search_and_update", label: "Search and update" })).toBe(false);
	});

	test("classifies collapsed semantic presentations without changing exploration", () => {
		expect(classifyToolPresentation({ name: "read", args: { path: "a.ts" } })).toBe("exploration");
		expect(classifyToolPresentation({ name: "bash", args: { command: "git status" } })).toBe("exploration");
		expect(classifyToolPresentation({ name: "edit" })).toBe("mutation");
		expect(classifyToolPresentation({ name: "write" })).toBe("mutation");
		expect(classifyToolPresentation({ name: "bash", args: { command: "npm run check" } })).toBe("command");
		expect(classifyToolPresentation({ name: "hypa_shell", args: { command: "touch file" } })).toBe("command");
		expect(classifyToolPresentation({ name: "mcp", args: { action: "connect" } })).toBe("remote");
		expect(classifyToolPresentation({ name: "deploy_service", isCustom: true })).toBe("remote");
		expect(classifyToolPresentation({ name: "unknown" })).toBe("original");
	});
});

describe("exploration summaries", () => {
	test.each<{ tool: ExplorationToolDescriptor; expected: string }>([
		{ tool: { name: "read", args: { path: "packages/foo.ts" } }, expected: "Read packages/foo.ts" },
		{
			tool: { name: "grep", args: { pattern: "ToolExecutionComponent", path: "packages/coding-agent/src" } },
			expected: "Search ToolExecutionComponent in packages/coding-agent/src",
		},
		{ tool: { name: "find", args: { pattern: "*.ts", path: "src" } }, expected: "Find *.ts in src" },
		{ tool: { name: "ls", args: { path: ".pi/extensions" } }, expected: "List .pi/extensions" },
		{ tool: { name: "bash", args: { command: "rg needle packages | head -20" } }, expected: "$ rg needle packages | head -20" },
		{ tool: { name: "hypa_shell", args: { command: "ls -la" } }, expected: "$ ls -la" },
		{
			tool: { name: "mcp", args: { server: "jira", tool: "read_issue", args: '{"issueKey":"ABC-123"}' } },
			expected: "MCP read issue jira ABC-123",
		},
		{
			tool: { name: "mcp", args: { server: "jira" } },
			expected: "MCP list jira",
		},
		{
			tool: { name: "web_search", args: { queries: ["Pi extensions", "Pi custom rendering", "Pi TUI"] } },
			expected: "Web search Pi extensions; Pi custom rendering (+1)",
		},
		{
			tool: { name: "fetch_content", args: { urls: ["https://pi.dev", "https://example.com"] } },
			expected: "Fetch https://pi.dev (+1)",
		},
		{
			tool: { name: "get_search_content", args: { responseId: "response-123", queryIndex: 0 } },
			expected: "Retrieve search content response-123",
		},
		{
			tool: { name: "Agent", args: { subagent_type: "Explore", description: "Locate grouping logic" } },
			expected: "Explore Locate grouping logic",
		},
		{
			tool: { name: "get_subagent_result", args: { agent_id: "agent-1" } },
			expected: "Get subagent result agent-1",
		},
	])("formats $tool.name", ({ tool, expected }) => {
		expect(formatExplorationSummary(tool)).toBe(expected);
	});

	test("removes ANSI and control characters so summaries stay on one line", () => {
		expect(formatExplorationSummary({ name: "read", args: { path: "src/\u001b[31mred.ts\u001b[0m\nnext" } })).toBe(
			"Read src/red.ts next",
		);
	});
});

describe("remote action summaries", () => {
	test("includes the Agent description", () => {
		expect(
			formatRemoteActionSummary({
				name: "Agent",
				label: "Agent",
				args: { subagent_type: "general-purpose", description: "Review provider behavior" },
			}),
		).toBe("Agent Review provider behavior");
	});
});

describe("pure grouping", () => {
	test("groups consecutive exploration tools and uses non-exploration tools as boundaries", () => {
		const groups = groupExplorationItems([
			{ id: "read-1", exploration: true },
			{ id: "grep-1", exploration: true },
			{ id: "bash-1", exploration: false },
			{ id: "read-2", exploration: true },
		]);
		expect(groups.map((group) => group.items.map((item) => item.id))).toEqual([["read-1", "grep-1"], ["read-2"]]);
	});

	test("generates deterministic fixed-width prefix-safe selection labels", () => {
		expect(generateSelectionLabels(3)).toEqual(["a", "s", "d"]);
		const labels = generateSelectionLabels(27);
		expect(labels).toHaveLength(27);
		expect(labels.slice(0, 3)).toEqual(["aa", "as", "ad"]);
		expect(labels[26]).toBe("sa");
		expect(new Set(labels).size).toBe(labels.length);
		expect(labels.every((label) => label.length === 2)).toBe(true);
		expect(labels.some((label) => labels.some((candidate) => candidate !== label && candidate.startsWith(label)))).toBe(false);
	});
});

describe("runtime patch", () => {
	function install(
		onParentRebuild?: (parent: object) => void,
		onCompactTextOutputNormalize?: () => void,
		onCustomRowsCompute?: (target: object) => void,
	): ReturnType<typeof installToolCallGroupingPatch> {
		activePatch = installToolCallGroupingPatch({
			getTheme: () => undefined,
			onParentRebuild,
			onCompactTextOutputNormalize,
			onCustomRowsCompute,
		});
		expect(activePatch.installed).toBe(true);
		return activePatch;
	}

	test("renders one grouped row per exploration call and transitions from Exploring to Explored", () => {
		install();
		const parent = new Container();
		const read = component("read", "read-1", { path: "packages/foo.ts" });
		const grep = component("grep", "grep-1", { pattern: "needle", path: "packages" });
		parent.addChild(read);
		parent.addChild(grep);

		const running = read.render(120);
		expect(running).toEqual(["", "• Exploring", "  ├ Read packages/foo.ts", "  └ Search needle in packages"]);
		expect(grep.render(120)).toEqual([]);

		read.updateResult({ content: [{ type: "text", text: "file" }], isError: false }, false);
		grep.updateResult({ content: [{ type: "text", text: "match" }], isError: false }, false);
		expect(read.render(120)[1]).toBe("• Explored");
	});

	test("uses distinct lifecycle colors for pending, completed, and failed headers", () => {
		activePatch = installToolCallGroupingPatch({ getTheme: () => activeTheme });
		expect(activePatch.installed).toBe(true);
		expect(activeTheme.getFgAnsi("accent")).not.toBe(activeTheme.getFgAnsi("text"));
		expect(activeTheme.getFgAnsi("success")).not.toBe(activeTheme.getFgAnsi("text"));
		expect(activeTheme.getFgAnsi("error")).not.toBe(activeTheme.getFgAnsi("text"));

		const explorationParent = new Container();
		const read = component("read", "read-themed", { path: "first.ts" });
		const list = component("ls", "ls-themed", { path: "src" });
		explorationParent.addChild(read);
		explorationParent.addChild(list);

		const mutationParent = new Container();
		const edit = component("edit", "edit-themed", { path: "first.ts", edits: [] });
		const write = component("write", "write-themed", { path: "second.ts", content: "done" });
		mutationParent.addChild(edit);
		mutationParent.addChild(write);

		const commandParent = new Container();
		const command = component(
			"bash",
			"bash-themed",
			{ command: "npm run a-very-long-check-command" },
			createBashToolDefinition(process.cwd()),
		);
		commandParent.addChild(command);

		const remoteParent = new Container();
		const firstRemote = component("deploy_service", "remote-themed-1", { target: "one" }, customDefinition());
		const secondRemote = component("deploy_service", "remote-themed-2", { target: "two" }, customDefinition());
		remoteParent.addChild(firstRemote);
		remoteParent.addChild(secondRemote);

		expect(read.render(120)[1]).toBe(activeTheme.fg("accent", activeTheme.bold("• Exploring")));
		expect(edit.render(120)[1]).toBe(`• ${activeTheme.fg("accent", activeTheme.bold("Modifying"))}`);
		expect(command.render(120)[1]).toBe(
			`• ${activeTheme.fg("accent", activeTheme.bold("Running"))} $ npm run a-very-long-check-command`,
		);
		expect(firstRemote.render(120)[1]).toBe(`• ${activeTheme.fg("accent", activeTheme.bold("Calling"))}`);

		for (const tool of [read, list, edit, write, command, firstRemote, secondRemote]) {
			tool.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
		}
		expect(read.render(120)[1]).toBe(activeTheme.fg("success", activeTheme.bold("• Explored")));
		expect(edit.render(120)[1]).toBe(`• ${activeTheme.fg("success", activeTheme.bold("Modified"))}`);
		expect(command.render(120)[1]).toBe(
			`• ${activeTheme.fg("success", activeTheme.bold("Ran"))} $ npm run a-very-long-check-command`,
		);
		expect(firstRemote.render(120)[1]).toBe(`• ${activeTheme.fg("success", activeTheme.bold("Called"))}`);

		const truncatedCommandHeader = command.render(18)[1] ?? "";
		expect(visibleWidth(truncatedCommandHeader)).toBeLessThanOrEqual(18);
		expect(truncatedCommandHeader).toContain(activeTheme.getFgAnsi("success"));
		expect(truncatedCommandHeader).not.toContain(activeTheme.getFgAnsi("text"));

		command.updateResult({ content: [{ type: "text", text: "failed" }], isError: true }, false);
		expect(command.render(120)[1]).toBe(
			`• ${activeTheme.fg("error", activeTheme.bold("Command failed"))} $ npm run a-very-long-check-command`,
		);
	});

	test("groups exploration tools across assistant prose, tool-call content, and unrelated TUI rows", () => {
		install();
		const parent = new Container();
		const first = component("read", "read-1", { path: "first.ts" });
		const shell = component(
			"bash",
			"bash-1",
			{ command: "git status --short" },
			createBashToolDefinition(process.cwd()),
		);
		const last = component("find", "find-1", { pattern: "*.ts" });
		parent.addChild(first);
		parent.addChild(thinkingComponent("bash-1", "bash", "I will inspect the repository."));
		parent.addChild(shell);
		parent.addChild(thinkingComponent("find-1", "find"));
		parent.addChild(new Text("status", 0, 0));
		parent.addChild(last);

		expect(first.render(120)).toEqual([
			"",
			"• Exploring",
			"  ├ Read first.ts",
			"  ├ $ git status --short",
			"  └ Find *.ts",
		]);
		expect(shell.render(120)).toEqual([]);
		expect(last.render(120)).toEqual([]);
	});

	test("uses an actual non-exploration tool as an exploration boundary", () => {
		install();
		const parent = new Container();
		const first = component("read", "read-1", { path: "first.ts" });
		const command = component(
			"bash",
			"bash-1",
			{ command: "printf changed" },
			createBashToolDefinition(process.cwd()),
		);
		const last = component("ls", "ls-1", { path: "src" });
		parent.addChild(first);
		parent.addChild(command);
		parent.addChild(last);

		expect(first.render(120)).toEqual(["", "• Exploring", "  └ Read first.ts"]);
		expect(command.render(120)).toEqual(["", "• Running $ printf changed"]);
		expect(last.render(120)).toEqual(["", "• Exploring", "  └ List src"]);
	});

	test("filters thinking-only, mixed, and streaming assistant updates without blank rows or input mutation", () => {
		const originalAssistantRender = AssistantMessageComponent.prototype.render;
		install();
		const parent = new Container();
		const assistant = new AssistantMessageComponent(undefined, false);
		const finalOnly = new AssistantMessageComponent(undefined, false);
		parent.addChild(assistant);
		parent.addChild(finalOnly);

		const thinkingOnly = thinkingMessage();
		const thinkingOnlyContent = thinkingOnly.content;
		assistant.updateContent(thinkingOnly);
		expect(assistant.render(120)).toEqual([]);
		expect(thinkingOnly.content).toBe(thinkingOnlyContent);
		expect(thinkingOnly.content).toEqual([{ type: "thinking", thinking: "hidden reasoning" }]);

		const mixed = thinkingMessage(undefined, undefined, "Final answer");
		const mixedContent = mixed.content;
		const final = {
			...mixed,
			content: mixed.content.filter((item) => item.type !== "thinking"),
		};
		assistant.updateContent(mixed);
		finalOnly.updateContent(final);
		expect(assistant.render(120)).toEqual(finalOnly.render(120));
		expect(mixed.content).toBe(mixedContent);
		expect(mixed.content[0]).toEqual({ type: "thinking", thinking: "hidden reasoning" });

		const streaming = thinkingMessage(undefined, undefined, "Partial answer");
		assistant.updateContent(streaming);
		expect(assistant.render(120).join("\n")).toContain("Partial answer");
		expect(assistant.render(120).join("\n")).not.toContain("hidden reasoning");
		expect(AssistantMessageComponent.prototype.render).toBe(originalAssistantRender);
	});

	test("filters initial messages on construction and first observation, then restores latest originals", () => {
		const originalAssistantRender = AssistantMessageComponent.prototype.render;
		const originalUpdateContent = AssistantMessageComponent.prototype.updateContent;
		const observedMessage = thinkingMessage(undefined, undefined, "Observed answer");
		const observed = new AssistantMessageComponent(observedMessage, false);
		const observedRendering = observed.render(120);
		expect(observedRendering.join("\n")).toContain("hidden reasoning");

		const patch = install();
		const constructedMessage = thinkingMessage(undefined, undefined, "Constructed answer");
		const constructed = new AssistantMessageComponent(constructedMessage, false);
		const parent = new Container();
		parent.addChild(observed);
		parent.addChild(constructed);
		expect(observed.render(120).join("\n")).not.toContain("hidden reasoning");
		expect(constructed.render(120).join("\n")).not.toContain("hidden reasoning");

		const latestObserved = thinkingMessage(undefined, undefined, "Latest observed answer");
		const latestConstructed = thinkingMessage(undefined, undefined, "Latest constructed answer");
		observed.updateContent(latestObserved);
		constructed.updateContent(latestConstructed);
		parent.removeChild(observed);
		expect(observed.render(120).join("\n")).toContain("hidden reasoning");
		expect(observed.render(120).join("\n")).toContain("Latest observed answer");

		parent.clear();
		expect(constructed.render(120).join("\n")).toContain("hidden reasoning");
		expect(constructed.render(120).join("\n")).toContain("Latest constructed answer");

		parent.addChild(observed);
		observed.updateContent(latestObserved);
		patch.reset();
		expect(observed.render(120).join("\n")).toContain("hidden reasoning");

		parent.addChild(constructed);
		constructed.updateContent(latestConstructed);
		patch.restore();
		expect(constructed.render(120).join("\n")).toContain("hidden reasoning");
		expect(AssistantMessageComponent.prototype.updateContent).toBe(originalUpdateContent);
		expect(AssistantMessageComponent.prototype.render).toBe(originalAssistantRender);
	});

	test("delegates every expanded redraw to the exact original renderer and refreshes collapse cache", () => {
		const exactOriginal = ToolExecutionComponent.prototype.render;
		let originalCalls = 0;
		ToolExecutionComponent.prototype.render = function (width) {
			originalCalls += 1;
			return exactOriginal.call(this, width);
		};
		let computations = 0;
		try {
			install(undefined, undefined, () => {
				computations += 1;
			});
			const parent = new Container();
			const command = component(
				"bash",
				"expanded-cache",
				{ command: "npm run check" },
				createBashToolDefinition(process.cwd()),
			);
			parent.addChild(command);
			command.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
			const collapsed = command.render(120);
			expect(command.render(120)).toBe(collapsed);
			expect(computations).toBe(1);

			command.setExpanded(true);
			command.render(120);
			command.render(120);
			expect(originalCalls).toBe(2);
			expect(computations).toBe(1);

			command.setExpanded(false);
			const refreshed = command.render(120);
			expect(command.render(120)).toBe(refreshed);
			expect(computations).toBe(2);
		} finally {
			activePatch?.restore();
			activePatch = undefined;
			ToolExecutionComponent.prototype.render = exactOriginal;
		}
	});

	test("uses original full tool rendering while expanded and restores grouping when collapsed", () => {
		install();
		const parent = new Container();
		const first = component("read", "read-1", { path: "first.ts" });
		const second = component("read", "read-2", { path: "second.ts" });
		parent.addChild(first);
		parent.addChild(second);
		first.updateResult({ content: [{ type: "text", text: "first result" }], isError: false }, false);
		second.updateResult({ content: [{ type: "text", text: "second result" }], isError: false }, false);

		first.setExpanded(true);
		second.setExpanded(true);
		expect(first.render(120).join("\n")).not.toContain("• Explored");
		expect(second.render(120).length).toBeGreaterThan(0);

		first.setExpanded(false);
		second.setExpanded(false);
		expect(first.render(120)).toEqual(["", "• Explored", "  ├ Read first.ts", "  └ Read second.ts"]);
		expect(second.render(120)).toEqual([]);
	});

	test("labels every collapsed row and expands a standalone tool", () => {
		const patch = install();
		const explorationParent = new Container();
		const read = component("read", "read-1", { path: "first.ts" });
		explorationParent.addChild(read);
		const commandParent = new Container();
		const command = component(
			"bash",
			"bash-1",
			{ command: "npm run check" },
			createBashToolDefinition(process.cwd()),
		);
		commandParent.addChild(command);

		expect(patch.beginSelection()).toEqual(["a", "s"]);
		expect(read.render(120)).toContain("  └ [a] Read first.ts");
		expect(command.render(120)).toContain("• [s] Running $ npm run check");
		expect(patch.expandSelection("s")).toBe(true);
		expect(command.render(120).join("\n")).not.toContain("• Running");
		expect(read.render(120).join("\n")).not.toContain("[a]");
	});

	test("splits an exploration group around a selected middle row", () => {
		const patch = install();
		const parent = new Container();
		const first = component("read", "read-1", { path: "first.ts" });
		const middle = component("read", "read-2", { path: "middle.ts" });
		const last = component("read", "read-3", { path: "last.ts" });
		for (const tool of [first, middle, last]) {
			parent.addChild(tool);
			tool.updateResult({ content: [{ type: "text", text: `${tool === middle ? "middle" : "result"}` }], isError: false }, false);
		}

		expect(patch.beginSelection()).toEqual(["a", "s", "d"]);
		expect(first.render(120)).toContain("  ├ [a] Read first.ts");
		expect(patch.expandSelection("s")).toBe(true);
		expect(first.render(120)).toEqual(["", "• Explored", "  └ Read first.ts"]);
		expect(middle.render(120).join("\n")).toContain("middle");
		expect(middle.render(120).join("\n")).not.toContain("• Explored");
		expect(last.render(120)).toEqual(["", "• Explored", "  └ Read last.ts"]);
	});

	test("labels grouped mutation and remote children", () => {
		const patch = install();
		const mutationParent = new Container();
		const firstEdit = component("edit", "edit-1", { path: "first.ts", edits: [{ oldText: "a", newText: "b" }] });
		const secondEdit = component("edit", "edit-2", { path: "second.ts", edits: [{ oldText: "a", newText: "b" }] });
		mutationParent.addChild(firstEdit);
		mutationParent.addChild(secondEdit);
		const remoteParent = new Container();
		const firstRemote = component("deploy_service", "remote-1", { target: "one" }, customDefinition());
		const secondRemote = component("deploy_service", "remote-2", { target: "two" }, customDefinition());
		remoteParent.addChild(firstRemote);
		remoteParent.addChild(secondRemote);

		expect(patch.beginSelection()).toEqual(["a", "s", "d", "f"]);
		expect(firstEdit.render(120)).toContain("  ├ [a] first.ts (+1 -1)");
		expect(firstEdit.render(120)).toContain("  └ [s] second.ts (+1 -1)");
		expect(firstRemote.render(120)).toContain("  ├ [d] Deploy service one");
		expect(firstRemote.render(120)).toContain("  └ [f] Deploy service two");
	});

	test("splits mutation and remote groups around selected middle rows", () => {
		const patch = install();
		const mutationParent = new Container();
		const edits = ["first.ts", "middle.ts", "last.ts"].map((path, index) =>
			component("edit", `edit-${index}`, { path, edits: [{ oldText: "a", newText: "b" }] }),
		);
		for (const edit of edits) mutationParent.addChild(edit);
		const remoteParent = new Container();
		const remotes = ["one", "two", "three"].map((target, index) =>
			component("deploy_service", `remote-${index}`, { target }, customDefinition()),
		);
		for (const remote of remotes) remoteParent.addChild(remote);

		expect(patch.beginSelection()).toEqual(["a", "s", "d", "f", "g", "h"]);
		expect(patch.expandSelection("s")).toBe(true);
		expect(edits[0]?.render(120)).toContain("• Editing first.ts");
		expect(edits[1]?.render(120).join("\n")).not.toContain("• Editing");
		expect(edits[2]?.render(120)).toContain("• Editing last.ts");

		expect(patch.beginSelection()).toEqual(["a", "s", "d", "f", "g"]);
		expect(patch.expandSelection("f")).toBe(true);
		expect(remotes[0]?.render(120)).toContain("• Calling Deploy service one");
		expect(remotes[1]?.render(120).join("\n")).not.toContain("• Calling");
		expect(remotes[2]?.render(120)).toContain("• Calling Deploy service three");
	});

	test("invalidates cached rows when selection labels change", () => {
		let computations = 0;
		const patch = install(undefined, undefined, () => {
			computations += 1;
		});
		const parent = new Container();
		const first = component("read", "label-cache-1", { path: "first.ts" });
		const second = component("read", "label-cache-2", { path: "second.ts" });
		parent.addChild(first);
		parent.addChild(second);
		first.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
		second.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
		first.render(120);
		expect(computations).toBe(1);

		patch.beginSelection();
		expect(first.render(120).join("\n")).toContain("[a]");
		expect(computations).toBe(2);
		patch.cancelSelection();
		expect(first.render(120).join("\n")).not.toContain("[a]");
		expect(computations).toBe(3);
	});

	test("cancels labels without expanding a target", () => {
		const patch = install();
		const parent = new Container();
		const read = component("read", "read-1", { path: "first.ts" });
		parent.addChild(read);
		patch.beginSelection();
		expect(read.render(120).join("\n")).toContain("[a]");
		patch.cancelSelection();
		expect(read.render(120).join("\n")).not.toContain("[a]");
	});

	test("groups conservatively read-only shell commands with exploration tools", () => {
		install();
		const parent = new Container();
		const first = component("read", "read-1", { path: "first.ts" });
		const shell = component(
			"bash",
			"bash-1",
			{ command: "wc -l first.ts; find . -name '*.ts'" },
			createBashToolDefinition(process.cwd()),
		);
		const last = component("read", "read-2", { path: "second.ts" });
		parent.addChild(first);
		parent.addChild(shell);
		parent.addChild(last);

		expect(first.render(120)).toEqual([
			"",
			"• Exploring",
			"  ├ Read first.ts",
			"  ├ $ wc -l first.ts; find . -name '*.ts'",
			"  └ Read second.ts",
		]);
		expect(shell.render(120)).toEqual([]);
	});

	test("groups Explore subagents and their result retrieval", () => {
		install();
		const parent = new Container();
		const first = component("read", "read-1", { path: "first.ts" });
		const agent = component("Agent", "agent-1", {
			subagent_type: "Explore",
			description: "Locate grouping logic",
		});
		const result = component("get_subagent_result", "result-1", { agent_id: "agent-1" });
		parent.addChild(first);
		parent.addChild(agent);
		parent.addChild(result);

		expect(first.render(120)).toEqual([
			"",
			"• Exploring",
			"  ├ Read first.ts",
			"  ├ Explore Locate grouping logic",
			"  └ Get subagent result agent-1",
		]);
		expect(agent.render(120)).toEqual([]);
		expect(result.render(120)).toEqual([]);
	});

	test("keeps single mutation calls on two lines through pending, success, and failure states", () => {
		install();
		const editParent = new Container();
		const edit = component("edit", "edit-1", {
			path: "src/file.ts",
			edits: [{ oldText: "old", newText: "new\nline" }],
		});
		editParent.addChild(edit);

		expect(edit.render(120)).toEqual(["", "• Editing src/file.ts", "  +2 -1 lines"]);
		edit.updateResult(
			{
				content: [{ type: "text", text: "Successfully replaced one block" }],
				details: { diff: "-1 old\n+1 new\n+2 line" },
				isError: false,
			},
			false,
		);
		expect(edit.render(120)).toEqual(["", "• Edited src/file.ts", "  +2 -1 lines"]);

		const writeParent = new Container();
		const write = component("write", "write-1", { path: "src/new.ts", content: "one\ntwo\n" });
		writeParent.addChild(write);
		expect(write.render(120)).toEqual(["", "• Writing src/new.ts", "  2 lines"]);
		write.updateResult({ content: [{ type: "text", text: "Successfully wrote file" }], isError: false }, false);
		expect(write.render(120)).toEqual(["", "• Wrote src/new.ts", "  2 lines"]);

		write.updateResult({ content: [{ type: "text", text: "permission denied" }], isError: true }, false);
		expect(write.render(120)).toEqual([
			"",
			"• Write failed src/new.ts",
			"  2 lines",
			"  permission denied",
		]);
	});

	test("groups consecutive edits and keeps statistics on each item", () => {
		install();
		const parent = new Container();
		const first = component("edit", "edit-1", {
			path: "src/parser.ts",
			edits: [{ oldText: "old", newText: "new\nline" }],
		});
		const second = component("edit", "edit-2", {
			path: "test/parser.test.ts",
			edits: [{ oldText: "before", newText: "after" }],
		});
		parent.addChild(first);
		parent.addChild(second);

		expect(first.render(120)).toEqual([
			"",
			"• Editing",
			"  ├ src/parser.ts (+2 -1)",
			"  └ test/parser.test.ts (+1 -1)",
		]);
		expect(second.render(120)).toEqual([]);

		first.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
		second.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
		expect(first.render(120)[1]).toBe("• Edited");
	});

	test("groups two edit batches across a tool-call-only assistant row", () => {
		install();
		const parent = new Container();
		const edits = ["first.ts", "second.ts", "third.ts", "fourth.ts"].map((path, index) =>
			component("edit", `edit-${index + 1}`, { path, edits: [{ oldText: "a", newText: "b" }] }),
		);
		parent.addChild(edits[0] as ToolExecutionComponent);
		parent.addChild(edits[1] as ToolExecutionComponent);
		parent.addChild(thinkingComponent("edit-3", "edit"));
		parent.addChild(edits[2] as ToolExecutionComponent);
		parent.addChild(edits[3] as ToolExecutionComponent);

		expect(edits[0]?.render(120)).toEqual([
			"",
			"• Editing",
			"  ├ first.ts (+1 -1)",
			"  ├ second.ts (+1 -1)",
			"  ├ third.ts (+1 -1)",
			"  └ fourth.ts (+1 -1)",
		]);
		for (const edit of edits.slice(1)) expect(edit.render(120)).toEqual([]);
	});

	test("groups edits across a thinking-only assistant row", () => {
		install();
		const parent = new Container();
		const first = component("edit", "edit-1", { path: "first.ts", edits: [{ oldText: "a", newText: "b" }] });
		const second = component("edit", "edit-2", { path: "second.ts", edits: [{ oldText: "a", newText: "b" }] });
		parent.addChild(first);
		parent.addChild(new AssistantMessageComponent(thinkingMessage(), false));
		parent.addChild(second);

		expect(first.render(120)).toEqual([
			"",
			"• Editing",
			"  ├ first.ts (+1 -1)",
			"  └ second.ts (+1 -1)",
		]);
		expect(second.render(120)).toEqual([]);
	});

	test("uses visible assistant prose as a mutation boundary", () => {
		install();
		const parent = new Container();
		const edits = ["first.ts", "second.ts", "third.ts", "fourth.ts"].map((path, index) =>
			component("edit", `edit-${index + 1}`, { path, edits: [{ oldText: "a", newText: "b" }] }),
		);
		parent.addChild(edits[0] as ToolExecutionComponent);
		parent.addChild(edits[1] as ToolExecutionComponent);
		parent.addChild(thinkingComponent("edit-3", "edit", "I will update another batch."));
		parent.addChild(edits[2] as ToolExecutionComponent);
		parent.addChild(edits[3] as ToolExecutionComponent);

		expect(edits[0]?.render(120)).toEqual([
			"",
			"• Editing",
			"  ├ first.ts (+1 -1)",
			"  └ second.ts (+1 -1)",
		]);
		expect(edits[1]?.render(120)).toEqual([]);
		expect(edits[2]?.render(120)).toEqual([
			"",
			"• Editing",
			"  ├ third.ts (+1 -1)",
			"  └ fourth.ts (+1 -1)",
		]);
		expect(edits[3]?.render(120)).toEqual([]);
	});

	test("uses a real non-mutation tool as a boundary and leaves a following write standalone", () => {
		install();
		const parent = new Container();
		const first = component("edit", "edit-1", { path: "first.ts", edits: [{ oldText: "a", newText: "b" }] });
		const second = component("edit", "edit-2", { path: "second.ts", edits: [{ oldText: "a", newText: "b" }] });
		const read = component("read", "read-1", { path: "current.ts" });
		const write = component("write", "write-1", { path: "new.ts", content: "content" });
		for (const child of [first, second, read, write]) parent.addChild(child);

		expect(first.render(120)).toEqual([
			"",
			"• Editing",
			"  ├ first.ts (+1 -1)",
			"  └ second.ts (+1 -1)",
		]);
		expect(second.render(120)).toEqual([]);
		expect(read.render(120)).toEqual(["", "• Exploring", "  └ Read current.ts"]);
		expect(write.render(120)).toEqual(["", "• Writing new.ts", "  1 line"]);
	});

	test("uses Modified for mixed edit and write groups", () => {
		install();
		const parent = new Container();
		const edit = component("edit", "edit-1", {
			path: "src/parser.ts",
			edits: [{ oldText: "old", newText: "new" }],
		});
		const write = component("write", "write-1", { path: "src/types.ts", content: "one\ntwo\n" });
		parent.addChild(edit);
		parent.addChild(write);

		expect(edit.render(120)[1]).toBe("• Modifying");
		edit.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
		write.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
		expect(edit.render(120)).toEqual([
			"",
			"• Modified",
			"  ├ Edited src/parser.ts (+1 -1)",
			"  └ Wrote src/types.ts (2 lines)",
		]);
		expect(write.render(120)).toEqual([]);
	});

	test("keeps failed mutations standalone and splits surrounding groups", () => {
		install();
		const parent = new Container();
		const first = component("edit", "edit-1", { path: "first.ts", edits: [{ oldText: "a", newText: "b" }] });
		const failed = component("edit", "edit-2", { path: "failed.ts", edits: [{ oldText: "a", newText: "b" }] });
		const third = component("edit", "edit-3", { path: "third.ts", edits: [{ oldText: "a", newText: "b" }] });
		const fourth = component("edit", "edit-4", { path: "fourth.ts", edits: [{ oldText: "a", newText: "b" }] });
		for (const mutation of [first, failed, third, fourth]) parent.addChild(mutation);
		failed.updateResult({ content: [{ type: "text", text: "permission denied" }], isError: true }, false);

		expect(first.render(120)[1]).toBe("• Editing first.ts");
		expect(failed.render(120)).toContain("• Edit failed failed.ts");
		expect(third.render(120)).toEqual([
			"",
			"• Editing",
			"  ├ third.ts (+1 -1)",
			"  └ fourth.ts (+1 -1)",
		]);
		expect(fourth.render(120)).toEqual([]);
	});

	test("caches complete settled group and standalone rows across 128 identical redraws", () => {
		let computations = 0;
		install(undefined, undefined, () => {
			computations += 1;
		});
		const parent = new Container();
		const read = component("read", "cache-read", { path: "src/file.ts" });
		const list = component("ls", "cache-list", { path: "src" });
		const command = component(
			"bash",
			"cache-command",
			{ command: "npm run check" },
			createBashToolDefinition(process.cwd()),
		);
		for (const tool of [read, list, command]) {
			parent.addChild(tool);
			tool.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
		}

		const expected = parent.render(120);
		expect(computations).toBe(2);
		for (let redraw = 0; redraw < 128; redraw += 1) expect(parent.render(120)).toEqual(expected);
		expect(computations).toBe(2);
	});

	test("keys complete row caches by width", () => {
		let computations = 0;
		install(undefined, undefined, () => {
			computations += 1;
		});
		const parent = new Container();
		const read = component("read", "width-read", { path: "a/very/long/path.ts" });
		const list = component("ls", "width-list", { path: "a/very/long/directory" });
		parent.addChild(read);
		parent.addChild(list);
		read.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
		list.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);

		const wide = read.render(120);
		expect(read.render(120)).toBe(wide);
		const narrow = read.render(18);
		expect(read.render(18)).toBe(narrow);
		expect(computations).toBe(2);
		expect(narrow).not.toEqual(wide);
	});

	test("invalidates a settled group when a follower result changes", () => {
		let computations = 0;
		install(undefined, undefined, () => {
			computations += 1;
		});
		const parent = new Container();
		const first = component("edit", "result-edit-1", { path: "first.ts", edits: [{ oldText: "a", newText: "b" }] });
		const follower = component("edit", "result-edit-2", { path: "second.ts", edits: [{ oldText: "a", newText: "b" }] });
		parent.addChild(first);
		parent.addChild(follower);
		first.updateResult({ content: [{ type: "text", text: "done" }], details: { diff: "-old\n+new" }, isError: false }, false);
		follower.updateResult({ content: [{ type: "text", text: "done" }], details: { diff: "-old\n+new" }, isError: false }, false);

		const before = first.render(120);
		expect(follower.render(120)).toEqual([]);
		expect(computations).toBe(1);
		follower.updateResult({ content: [{ type: "text", text: "done" }], details: { diff: "-a\n-b\n+c\n+d" }, isError: false }, false);
		const after = first.render(120);
		expect(computations).toBe(2);
		expect(after).not.toBe(before);
		expect(after.join("\n")).toContain("+2 -2");
	});

	test("keeps partial complete rows live, then caches settled rows", () => {
		let computations = 0;
		install(undefined, undefined, () => {
			computations += 1;
		});
		const parent = new Container();
		const command = component(
			"bash",
			"rows-streaming",
			{ command: "npm run check" },
			createBashToolDefinition(process.cwd()),
		);
		parent.addChild(command);
		command.updateResult({ content: [{ type: "text", text: "first" }], isError: false }, true);
		expect(command.render(120)).toContain("  first");
		command.updateResult({ content: [{ type: "text", text: "second" }], isError: false }, true);
		expect(command.render(120)).toContain("  second");
		expect(command.render(120)).toContain("  second");
		expect(computations).toBe(3);

		command.updateResult({ content: [{ type: "text", text: "settled" }], isError: false }, false);
		const settled = command.render(120);
		expect(command.render(120)).toBe(settled);
		expect(computations).toBe(4);

		const groupParent = new Container();
		const read = component("read", "partial-group-read", { path: "file.ts" });
		const list = component("ls", "partial-group-list", { path: "src" });
		groupParent.addChild(read);
		groupParent.addChild(list);
		read.updateResult({ content: [{ type: "text", text: "partial" }], isError: false }, true);
		list.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
		expect(read.render(120)[1]).toBe("• Exploring");
		expect(read.render(120)[1]).toBe("• Exploring");
		expect(computations).toBe(6);
		read.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
		const settledGroup = read.render(120);
		expect(settledGroup[1]).toBe("• Explored");
		expect(read.render(120)).toBe(settledGroup);
		expect(computations).toBe(7);
	});

	test("caches normalized output only for settled command results", () => {
		let normalizations = 0;
		install(undefined, () => {
			normalizations += 1;
		});
		const parent = new Container();
		const successful = component(
			"bash",
			"bash-success",
			{ command: "npm run check" },
			createBashToolDefinition(process.cwd()),
		);
		const failed = component(
			"bash",
			"bash-failure",
			{ command: "npm run lint" },
			createBashToolDefinition(process.cwd()),
		);
		parent.addChild(successful);
		parent.addChild(failed);
		successful.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
		failed.updateResult({ content: [{ type: "text", text: "failed" }], isError: true }, false);

		expect(successful.render(120)).toContain("  done");
		expect(successful.render(120)).toContain("  done");
		expect(failed.render(120)).toContain("  failed");
		expect(failed.render(120)).toContain("  failed");
		expect(normalizations).toBe(2);
	});

	test("keeps 128 idle redraws free of assistant updates, group rebuilds, and normalizations", () => {
		let parentRebuilds = 0;
		let normalizations = 0;
		install(
			() => {
				parentRebuilds += 1;
			},
			() => {
				normalizations += 1;
			},
		);
		const parent = new Container();
		const assistant = new AssistantMessageComponent(undefined, false);
		const read = component("read", "read-1", { path: "src/file.ts" });
		const list = component("ls", "ls-1", { path: "src" });
		const command = component(
			"bash",
			"bash-1",
			{ command: "npm run check" },
			createBashToolDefinition(process.cwd()),
		);
		for (const child of [assistant, read, list, command]) parent.addChild(child);
		let assistantUpdates = 0;
		const updateAssistant = assistant.updateContent.bind(assistant);
		assistant.updateContent = (message: AssistantMessage) => {
			assistantUpdates += 1;
			updateAssistant(message);
		};
		assistant.updateContent(thinkingMessage("read-1", "read", "I inspected the transcript."));
		read.updateResult({ content: [{ type: "text", text: "file contents" }], isError: false }, false);
		list.updateResult({ content: [{ type: "text", text: "file.ts" }], isError: false }, false);
		command.updateResult({ content: [{ type: "text", text: "checks passed" }], isError: false }, false);

		expect(parentRebuilds).toBe(5);
		expect(assistantUpdates).toBe(1);
		const settledOutput = parent.render(120);
		expect(normalizations).toBe(1);

		parentRebuilds = 0;
		normalizations = 0;
		assistantUpdates = 0;
		for (let redraw = 0; redraw < 128; redraw += 1) {
			expect(parent.render(120)).toEqual(settledOutput);
		}
		expect(parentRebuilds).toBe(0);
		expect(normalizations).toBe(0);
		expect(assistantUpdates).toBe(0);
	});

	test("does not cache partial normalized output and renders each update immediately", () => {
		let normalizations = 0;
		install(undefined, () => {
			normalizations += 1;
		});
		const parent = new Container();
		const command = component(
			"bash",
			"bash-streaming",
			{ command: "npm run check" },
			createBashToolDefinition(process.cwd()),
		);
		parent.addChild(command);
		command.updateResult({ content: [{ type: "text", text: "first" }], isError: false }, true);
		expect(command.render(120)).toContain("  first");
		command.updateResult({ content: [{ type: "text", text: "second" }], isError: false }, true);
		expect(command.render(120)).toContain("  second");
		expect(command.render(120)).not.toContain("  first");
		expect(normalizations).toBe(3);
	});

	test("renders commands individually with compact output and lifecycle labels", () => {
		install();
		const parent = new Container();
		const running = component(
			"bash",
			"bash-running",
			{ command: "npm run check" },
			createBashToolDefinition(process.cwd()),
		);
		const failed = component(
			"hypa_shell",
			"shell-failed",
			{ command: "touch protected/file" },
			customDefinition("hypa_shell", "Shell"),
		);
		parent.addChild(running);
		parent.addChild(failed);

		expect(running.render(120)).toEqual(["", "• Running $ npm run check"]);
		running.updateResult(
			{ content: [{ type: "text", text: "first\nsecond\nthird\nfourth" }], isError: false },
			true,
		);
		expect(running.render(120)).toEqual([
			"",
			"• Running $ npm run check",
			"  first",
			"  second",
			"  … (+2 lines)",
		]);
		running.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
		expect(running.render(120)).toEqual(["", "• Ran $ npm run check", "  done"]);

		failed.updateResult({ content: [{ type: "text", text: "permission denied" }], isError: true }, false);
		expect(failed.render(120)).toEqual([
			"",
			"• Command failed $ touch protected/file",
			"  permission denied",
		]);
	});

	test("renders remote MCP and custom actions individually through their lifecycle", () => {
		install();
		const parent = new Container();
		const mcp = component("mcp", "mcp-1", { server: "jira", action: "connect" }, mcpDefinition());
		const custom = component(
			"deploy_service",
			"deploy-1",
			{ target: "payments" },
			customDefinition(),
		);
		parent.addChild(mcp);
		parent.addChild(custom);

		expect(mcp.render(120)).toEqual([
			"",
			"• Calling",
			"  ├ MCP connect jira",
			"  └ Deploy service payments",
		]);
		expect(custom.render(120)).toEqual([]);
		mcp.updateResult({ content: [{ type: "text", text: "connected" }], isError: false }, false);
		custom.updateResult({ content: [{ type: "text", text: "remote rejected request" }], isError: true }, false);
		expect(mcp.render(120)).toEqual(["", "• Called MCP connect jira"]);
		expect(custom.render(120)).toEqual([
			"",
			"• Call failed Deploy service payments",
			"  remote rejected request",
		]);
	});

	test("groups consecutive remote calls and includes Agent descriptions", () => {
		install();
		const parent = new Container();
		const agent = component(
			"Agent",
			"agent-1",
			{ subagent_type: "general-purpose", description: "Review provider behavior" },
			customDefinition("Agent", "Agent"),
		);
		const deploy = component(
			"deploy_service",
			"deploy-1",
			{ target: "payments" },
			customDefinition(),
		);
		parent.addChild(agent);
		parent.addChild(deploy);

		expect(agent.render(120)).toEqual([
			"",
			"• Calling",
			"  ├ Agent Review provider behavior",
			"  └ Deploy service payments",
		]);
		expect(deploy.render(120)).toEqual([]);

		agent.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
		deploy.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
		expect(agent.render(120)).toEqual([
			"",
			"• Called",
			"  ├ Agent Review provider behavior",
			"  └ Deploy service payments",
		]);
	});

	test("keeps failed remote calls standalone and splits surrounding groups", () => {
		install();
		const parent = new Container();
		const first = component("deploy_service", "remote-1", { target: "one" }, customDefinition());
		const failed = component("deploy_service", "remote-2", { target: "two" }, customDefinition());
		const third = component("deploy_service", "remote-3", { target: "three" }, customDefinition());
		const fourth = component("deploy_service", "remote-4", { target: "four" }, customDefinition());
		for (const remote of [first, failed, third, fourth]) parent.addChild(remote);
		failed.updateResult({ content: [{ type: "text", text: "rejected" }], isError: true }, false);

		expect(first.render(120)[1]).toBe("• Calling Deploy service one");
		expect(failed.render(120)).toContain("• Call failed Deploy service two");
		expect(third.render(120)).toEqual([
			"",
			"• Calling",
			"  ├ Deploy service three",
			"  └ Deploy service four",
		]);
		expect(fourth.render(120)).toEqual([]);
	});

	test("semantic rows form exploration boundaries", () => {
		install();
		const parent = new Container();
		const first = component("read", "read-1", { path: "first.ts" });
		const edit = component("edit", "edit-1", { path: "changed.ts", edits: [{ oldText: "a", newText: "b" }] });
		const command = component(
			"bash",
			"bash-1",
			{ command: "printf ok" },
			createBashToolDefinition(process.cwd()),
		);
		const remote = component("mcp", "mcp-1", { action: "connect", server: "jira" }, mcpDefinition());
		const second = component("read", "read-2", { path: "second.ts" });
		for (const child of [first, edit, command, remote, second]) parent.addChild(child);

		expect(first.render(120)).toEqual(["", "• Exploring", "  └ Read first.ts"]);
		expect(edit.render(120)[1]).toBe("• Editing changed.ts");
		expect(command.render(120)[1]).toBe("• Running $ printf ok");
		expect(remote.render(120)[1]).toBe("• Calling MCP connect jira");
		expect(second.render(120)).toEqual(["", "• Exploring", "  └ Read second.ts"]);
	});

	test("refreshes grouped summaries after streamed argument changes", () => {
		install();
		const parent = new Container();
		const read = component("read", "read-1", { path: "before.ts" });
		const list = component("ls", "ls-1", { path: "src" });
		parent.addChild(read);
		parent.addChild(list);

		expect(read.render(120)).toContain("  ├ Read before.ts");
		expect(read.render(120)).toContain("  ├ Read before.ts");
		read.updateArgs({ path: "after.ts" });
		expect(read.render(120)).toContain("  ├ Read after.ts");
		expect(read.render(120)).not.toContain("  ├ Read before.ts");
	});

	test("reclassifies streamed MCP arguments by rebuilding only its parent", () => {
		const rebuilt: object[] = [];
		install((parent) => rebuilt.push(parent));
		const parent = new Container();
		const independentParent = new Container();
		const first = component("read", "read-1", { path: "first.ts" });
		const mcp = component("mcp", "mcp-1", { server: "jira", action: "connect" }, mcpDefinition());
		const last = component("read", "read-2", { path: "last.ts" });
		const independentFirst = component("read", "independent-1", { path: "independent.ts" });
		const independentLast = component("ls", "independent-2", { path: "src" });
		parent.addChild(first);
		parent.addChild(mcp);
		parent.addChild(last);
		independentParent.addChild(independentFirst);
		independentParent.addChild(independentLast);
		expect(first.render(120)[2]).toBe("  └ Read first.ts");
		rebuilt.length = 0;

		mcp.updateArgs({ server: "jira", tool: "get_issue", issue: "ABC-123" });
		expect(rebuilt).toEqual([parent]);
		expect(first.render(120)).toEqual([
			"",
			"• Exploring",
			"  ├ Read first.ts",
			"  ├ MCP get issue jira ABC-123",
			"  └ Read last.ts",
		]);
		expect(mcp.render(120)).toEqual([]);
		expect(last.render(120)).toEqual([]);
		expect(independentFirst.render(120)).toContain("  └ List src");
		expect(independentLast.render(120)).toEqual([]);
	});

	test("cleans memberships and parent associations on remove, clear, and reset", () => {
		const rebuilt: object[] = [];
		const patch = install((parent) => rebuilt.push(parent));
		const parent = new Container();
		const first = component("read", "read-1", { path: "first.ts" });
		const middle = component("read", "read-2", { path: "middle.ts" });
		const last = component("read", "read-3", { path: "last.ts" });
		for (const tool of [first, middle, last]) parent.addChild(tool);
		rebuilt.length = 0;

		parent.removeChild(middle);
		expect(rebuilt).toEqual([parent]);
		expect(first.render(120)).toEqual(["", "• Exploring", "  ├ Read first.ts", "  └ Read last.ts"]);
		expect(middle.render(120).length).toBeGreaterThan(0);
		expect(middle.render(120).join("\n")).not.toContain("• Exploring");

		rebuilt.length = 0;
		parent.clear();
		middle.updateArgs({ path: "changed-middle.ts" });
		first.updateArgs({ path: "changed-first.ts" });
		expect(rebuilt).toEqual([]);
		expect(first.render(120).join("\n")).not.toContain("• Exploring");
		expect(last.render(120).join("\n")).not.toContain("• Exploring");
		expect(patch.beginSelection()).toEqual([]);

		parent.addChild(first);
		parent.addChild(last);
		patch.reset();
		rebuilt.length = 0;
		last.updateArgs({ path: "changed-last.ts" });
		expect(rebuilt).toEqual([]);
		expect(first.render(120).join("\n")).not.toContain("• Exploring");
		expect(last.render(120).join("\n")).not.toContain("• Exploring");
	});

	test("refreshes member indexes after removal and splits around an expanded member", () => {
		const patch = install();
		const parent = new Container();
		const tools = ["first.ts", "second.ts", "third.ts", "fourth.ts"].map((path, index) =>
			component("read", `read-${index}`, { path }),
		);
		for (const tool of tools) parent.addChild(tool);

		parent.removeChild(tools[0] as ToolExecutionComponent);
		expect(tools[1]?.render(120)).toEqual([
			"",
			"• Exploring",
			"  ├ Read second.ts",
			"  ├ Read third.ts",
			"  └ Read fourth.ts",
		]);
		expect(tools[2]?.render(120)).toEqual([]);

		expect(patch.beginSelection()).toEqual(["a", "s", "d"]);
		expect(patch.expandSelection("s")).toBe(true);
		expect(tools[1]?.render(120)).toEqual(["", "• Exploring", "  └ Read second.ts"]);
		expect(tools[2]?.render(120).join("\n")).not.toContain("• Exploring");
		expect(tools[3]?.render(120)).toEqual(["", "• Exploring", "  └ Read fourth.ts"]);
	});

	test("adopts transcript rows created before patch installation once during parent render", () => {
		const originalContainerRender = Container.prototype.render;
		const parent = new Container();
		const leader = component("read", "replay-read", { path: "replay.ts" });
		const follower = component("ls", "replay-ls", { path: "src" });
		parent.addChild(leader);
		parent.addChild(follower);
		let rebuilds = 0;
		install(() => {
			rebuilds += 1;
		});

		expect(Container.prototype.render).not.toBe(originalContainerRender);
		expect(leader.render(120).length).toBeGreaterThan(0);
		expect(follower.render(120).length).toBeGreaterThan(0);
		parent.render(120);
		expect(leader.render(120)).toContain("  └ List src");
		expect(follower.render(120)).toEqual([]);
		expect(rebuilds).toBe(1);
		parent.render(120);
		expect(rebuilds).toBe(1);
	});

	test("replaces cached ANSI rows when the active theme identity changes", () => {
		const themed = (prefix: string) => ({
			bold: (text: string) => text,
			fg: (color: string, text: string) => `${prefix}:${color}:${text}`,
		}) as unknown as Theme;
		let currentTheme = themed("first");
		let computations = 0;
		activePatch = installToolCallGroupingPatch({
			getTheme: () => currentTheme,
			onCustomRowsCompute: () => {
				computations += 1;
			},
		});
		const parent = new Container();
		const command = component(
			"bash",
			"theme-cache",
			{ command: "npm run check" },
			createBashToolDefinition(process.cwd()),
		);
		parent.addChild(command);
		command.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
		expect(command.render(120).join("\n")).toContain("first:success:");
		expect(command.render(120).join("\n")).toContain("first:success:");
		expect(computations).toBe(1);

		currentTheme = themed("second");
		const changed = command.render(120).join("\n");
		expect(changed).toContain("second:success:");
		expect(changed).not.toContain("first:success:");
		expect(computations).toBe(2);
	});

	test("reset and hot reload clear row caches and restore exact tool mutators", () => {
		const originalRender = ToolExecutionComponent.prototype.render;
		const originalUpdateArgs = ToolExecutionComponent.prototype.updateArgs;
		const originalUpdateResult = ToolExecutionComponent.prototype.updateResult;
		const originalSetExpanded = ToolExecutionComponent.prototype.setExpanded;
		let computations = 0;
		const patch = install(undefined, undefined, () => {
			computations += 1;
		});
		const command = component(
			"bash",
			"reset-cache",
			{ command: "npm run check" },
			createBashToolDefinition(process.cwd()),
		);
		command.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
		command.render(120);
		command.render(120);
		expect(computations).toBe(1);
		patch.reset();
		command.render(120);
		expect(computations).toBe(2);

		patch.restore();
		expect(ToolExecutionComponent.prototype.render).toBe(originalRender);
		expect(ToolExecutionComponent.prototype.updateArgs).toBe(originalUpdateArgs);
		expect(ToolExecutionComponent.prototype.updateResult).toBe(originalUpdateResult);
		expect(ToolExecutionComponent.prototype.setExpanded).toBe(originalSetExpanded);

		let reloadComputations = 0;
		activePatch = installToolCallGroupingPatch({
			getTheme: () => undefined,
			onCustomRowsCompute: () => {
				reloadComputations += 1;
			},
		});
		command.render(120);
		command.render(120);
		expect(reloadComputations).toBe(1);
	});

	test("caches settled failure splits as one complete group presentation", () => {
		let computations = 0;
		install(undefined, undefined, () => {
			computations += 1;
		});
		const parent = new Container();
		const remotes = ["one", "two", "three", "four"].map((target, index) =>
			component("deploy_service", `split-cache-${index}`, { target }, customDefinition()),
		);
		for (const [index, remote] of remotes.entries()) {
			parent.addChild(remote);
			remote.updateResult(
				{ content: [{ type: "text", text: index === 1 ? "rejected" : "done" }], isError: index === 1 },
				false,
			);
		}

		expect(remotes[0]?.render(120)).toContain("• Called Deploy service one");
		expect(remotes[1]?.render(120)).toContain("• Call failed Deploy service two");
		expect(remotes[2]?.render(120)).toContain("  └ Deploy service four");
		expect(remotes[3]?.render(120)).toEqual([]);
		expect(computations).toBe(1);
	});

	test("is idempotent, restores exact prototype methods, and supports replay after reset", () => {
		const originalRender = ToolExecutionComponent.prototype.render;
		const originalAssistantRender = AssistantMessageComponent.prototype.render;
		const originalAssistantUpdateContent = AssistantMessageComponent.prototype.updateContent;
		const originalUpdateArgs = ToolExecutionComponent.prototype.updateArgs;
		const originalUpdateResult = ToolExecutionComponent.prototype.updateResult;
		const originalSetExpanded = ToolExecutionComponent.prototype.setExpanded;
		const originalContainerRender = Container.prototype.render;
		const originalAddChild = Container.prototype.addChild;
		const originalRemoveChild = Container.prototype.removeChild;
		const originalClear = Container.prototype.clear;
		const firstPatch = install();
		const wrappedRender = ToolExecutionComponent.prototype.render;
		const secondPatch = installToolCallGroupingPatch({ getTheme: () => undefined });
		expect(secondPatch).toBe(firstPatch);
		expect(ToolExecutionComponent.prototype.render).toBe(wrappedRender);
		expect(AssistantMessageComponent.prototype.render).toBe(originalAssistantRender);
		expect(AssistantMessageComponent.prototype.updateContent).not.toBe(originalAssistantUpdateContent);
		expect(Container.prototype.render).not.toBe(originalContainerRender);
		expect(Container.prototype.addChild).not.toBe(originalAddChild);
		expect(Container.prototype.removeChild).not.toBe(originalRemoveChild);
		expect(Container.prototype.clear).not.toBe(originalClear);

		const parent = new Container();
		const replayLeader = component("read", "replay-read", { path: "replay.ts" });
		const replayFollower = component("ls", "replay-ls", { path: "src" });
		parent.addChild(replayLeader);
		parent.addChild(replayFollower);
		expect(replayLeader.render(120)).toContain("  └ List src");
		expect(replayFollower.render(120)).toEqual([]);

		parent.removeChild(replayFollower);
		expect(replayLeader.render(120)).toEqual(["", "• Exploring", "  └ Read replay.ts"]);
		parent.addChild(replayFollower);
		expect(replayFollower.render(120)).toEqual([]);
		parent.clear();
		expect(firstPatch.beginSelection()).toEqual([]);

		firstPatch.reset();
		parent.addChild(replayLeader);
		parent.addChild(replayFollower);
		expect(replayLeader.render(120)).toContain("  └ List src");
		expect(replayFollower.render(120)).toEqual([]);

		firstPatch.restore();
		expect(ToolExecutionComponent.prototype.render).toBe(originalRender);
		expect(AssistantMessageComponent.prototype.render).toBe(originalAssistantRender);
		expect(AssistantMessageComponent.prototype.updateContent).toBe(originalAssistantUpdateContent);
		expect(ToolExecutionComponent.prototype.updateArgs).toBe(originalUpdateArgs);
		expect(ToolExecutionComponent.prototype.updateResult).toBe(originalUpdateResult);
		expect(ToolExecutionComponent.prototype.setExpanded).toBe(originalSetExpanded);
		expect(Container.prototype.render).toBe(originalContainerRender);
		expect(Container.prototype.addChild).toBe(originalAddChild);
		expect(Container.prototype.removeChild).toBe(originalRemoveChild);
		expect(Container.prototype.clear).toBe(originalClear);
	});

	test("adopts existing rows with the initialized TUI theme after extension reload", async () => {
		type Handler = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;
		const loadExtension = () => {
			const handlers = new Map<string, Handler>();
			toolCallGroupingExtension({
				on(event: string, handler: Handler) {
					handlers.set(event, handler);
				},
				registerShortcut() {},
			} as unknown as ExtensionAPI);
			return handlers;
		};
		const ctx = {
			mode: "tui",
			ui: { theme: activeTheme, setToolsExpanded() {}, notify() {} },
		} as unknown as ExtensionContext;
		const previousHandlers = loadExtension();
		await previousHandlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
		await previousHandlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "reload" }, ctx);

		const reloadedHandlers = loadExtension();
		try {
			const explorationParent = new Container();
			const read = component("read", "read-before-start", { path: "first.ts" });
			explorationParent.addChild(read);
			read.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);

			const commandParent = new Container();
			const command = component(
				"bash",
				"bash-before-start",
				{ command: "npm run check" },
				createBashToolDefinition(process.cwd()),
			);
			commandParent.addChild(command);
			command.updateResult({ content: [{ type: "text", text: "failed" }], isError: true }, false);

			await reloadedHandlers.get("session_start")?.({ type: "session_start", reason: "reload" }, ctx);
			explorationParent.render(120);
			commandParent.render(120);
			const successHeader = read.render(120)[1] ?? "";
			const errorHeader = command.render(120)[1] ?? "";
			expect(successHeader).toContain("Explored");
			expect(successHeader).toContain("\u001b[");
			expect(successHeader).toContain(activeTheme.getFgAnsi("success"));
			expect(errorHeader).toContain("Command failed");
			expect(errorHeader).toContain("\u001b[");
			expect(errorHeader).toContain(activeTheme.getFgAnsi("error"));
		} finally {
			await reloadedHandlers.get("session_shutdown")?.(
				{ type: "session_shutdown", reason: "reload" },
				ctx,
			);
		}
	});

	test("resets, rerenders replayed rows, and restores through extension lifecycle events", async () => {
		type Handler = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;
		const handlers = new Map<string, Handler>();
		const api = {
			on(event: string, handler: Handler) {
				handlers.set(event, handler);
			},
			registerShortcut() {},
		} as unknown as ExtensionAPI;
		const originalRender = ToolExecutionComponent.prototype.render;
		const originalAssistantRender = AssistantMessageComponent.prototype.render;
		let toolsExpanded: boolean | undefined;

		toolCallGroupingExtension(api);
		try {
			const start = handlers.get("session_start");
			expect(start).toBeDefined();
			await start?.({ type: "session_start", reason: "resume" }, {
				mode: "tui",
				ui: {
					theme: undefined,
					getToolsExpanded: () => true,
					setToolsExpanded: (expanded: boolean) => {
						toolsExpanded = expanded;
					},
				},
			} as unknown as ExtensionContext);
			expect(toolsExpanded).toBe(false);
			expect(ToolExecutionComponent.prototype.render).not.toBe(originalRender);
			expect(AssistantMessageComponent.prototype.render).toBe(originalAssistantRender);
			expect(handlers.has("message_end")).toBe(false);

			const parent = new Container();
			const message = thinkingMessage(undefined, undefined, "Completed response");
			const thinking = new AssistantMessageComponent(undefined, true);
			parent.addChild(thinking);
			thinking.updateContent(message);
			expect(thinking.render(120)).toEqual(originalAssistantRender.call(thinking, 120));
		} finally {
			await handlers.get("session_shutdown")?.(
				{ type: "session_shutdown", reason: "resume" },
				{} as ExtensionContext,
			);
		}
		expect(ToolExecutionComponent.prototype.render).toBe(originalRender);
		expect(AssistantMessageComponent.prototype.render).toBe(originalAssistantRender);
	});

	test("ignores non-TUI subagent lifecycle events while the main TUI owns the patch", async () => {
		type Handler = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;
		const originalRender = ToolExecutionComponent.prototype.render;
		const loadExtension = () => {
			const handlers = new Map<string, Handler>();
			toolCallGroupingExtension({
				on(event: string, handler: Handler) {
					handlers.set(event, handler);
				},
				registerShortcut() {},
			} as unknown as ExtensionAPI);
			return handlers;
		};
		const mainHandlers = loadExtension();
		const subagentHandlers = loadExtension();
		const mainContext = {
			mode: "tui",
			ui: { theme: undefined, setToolsExpanded() {}, notify() {} },
		} as unknown as ExtensionContext;
		const subagentContext = { mode: "print", ui: {} } as unknown as ExtensionContext;

		try {
			await mainHandlers.get("session_start")?.({ type: "session_start", reason: "startup" }, mainContext);
			const wrappedRender = ToolExecutionComponent.prototype.render;
			expect(wrappedRender).not.toBe(originalRender);
			const parent = new Container();
			const leader = component("read", "main-read", { path: "main.ts" });
			const follower = component("ls", "main-ls", { path: "src" });
			parent.addChild(leader);
			parent.addChild(follower);
			expect(leader.render(120).join("\n")).toContain("List src");
			expect(follower.render(120)).toEqual([]);

			await subagentHandlers.get("session_start")?.(
				{ type: "session_start", reason: "startup" },
				subagentContext,
			);
			expect(leader.render(120).join("\n")).toContain("List src");
			expect(follower.render(120)).toEqual([]);
			await subagentHandlers.get("session_shutdown")?.(
				{ type: "session_shutdown", reason: "quit" },
				subagentContext,
			);
			expect(ToolExecutionComponent.prototype.render).toBe(wrappedRender);
			expect(leader.render(120).join("\n")).toContain("List src");
			expect(follower.render(120)).toEqual([]);
		} finally {
			await mainHandlers.get("session_shutdown")?.(
				{ type: "session_shutdown", reason: "quit" },
				mainContext,
			);
		}
	});

	test("uses ctrl+shift+l to capture a fixed-width label and cleans up on selection", async () => {
		type Handler = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;
		type ShortcutHandler = (ctx: ExtensionContext) => void | Promise<void>;
		type SelectionComponent = { handleInput?(data: string): void };
		type SelectionFactory = (
			tui: TUI,
			theme: Theme,
			keybindings: { matches(data: string, binding: "tui.select.cancel"): boolean },
			done: (value: string | undefined) => void,
		) => SelectionComponent;
		const handlers = new Map<string, Handler>();
		let shortcut: ShortcutHandler | undefined;
		let shortcutKey: string | undefined;
		let selectionComponent: SelectionComponent | undefined;
		let resolveSelection: ((value: string | undefined) => void) | undefined;
		const api = {
			on(event: string, handler: Handler) {
				handlers.set(event, handler);
			},
			registerShortcut(key: string, options: { handler: ShortcutHandler }) {
				shortcutKey = key;
				shortcut = options.handler;
			},
		} as unknown as ExtensionAPI;

		toolCallGroupingExtension(api);
		const ctx = {
			mode: "tui",
			ui: {
				theme: undefined,
				setToolsExpanded() {},
				notify() {},
				custom(factory: SelectionFactory) {
					return new Promise<string | undefined>((resolve) => {
						resolveSelection = resolve;
						selectionComponent = factory(
							fakeTui(),
							{ fg: (_color: string, text: string) => text } as unknown as Theme,
							{ matches: (data, binding) => binding === "tui.select.cancel" && data === "cancel" },
							resolve,
						);
					});
				},
			},
		} as unknown as ExtensionContext;

		try {
			await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
			const parent = new Container();
			const tools = Array.from({ length: 27 }, (_, index) => component("read", `read-${index}`, { path: `${index}.ts` }));
			for (const tool of tools) parent.addChild(tool);

			expect(shortcutKey).toBe("ctrl+shift+l");
			const selection = Promise.resolve(shortcut?.(ctx));
			expect(tools[0]?.render(120).join("\n")).toContain("[aa]");
			selectionComponent?.handleInput?.("s");
			expect(resolveSelection).toBeDefined();
			selectionComponent?.handleInput?.("a");
			await selection;
			expect(tools[26]?.render(120).join("\n")).not.toContain("• Explored");
			expect(tools[0]?.render(120).join("\n")).not.toContain("[aa]");
		} finally {
			resolveSelection?.(undefined);
			await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);
		}
	});

	test("cancels an active selector during extension shutdown", async () => {
		type Handler = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;
		type ShortcutHandler = (ctx: ExtensionContext) => void | Promise<void>;
		const handlers = new Map<string, Handler>();
		let shortcut: ShortcutHandler | undefined;
		let selectionDone: ((value: string | undefined) => void) | undefined;
		const api = {
			on(event: string, handler: Handler) {
				handlers.set(event, handler);
			},
			registerShortcut(_key: string, options: { handler: ShortcutHandler }) {
				shortcut = options.handler;
			},
		} as unknown as ExtensionAPI;
		const ctx = {
			mode: "tui",
			ui: {
				theme: undefined,
				setToolsExpanded() {},
				notify() {},
				custom(factory: (tui: TUI, theme: Theme, keybindings: { matches(): boolean }, done: (value: string | undefined) => void) => object) {
					return new Promise<string | undefined>((resolve) => {
						selectionDone = resolve;
						factory(fakeTui(), { fg: (_color: string, text: string) => text } as unknown as Theme, { matches: () => false }, resolve);
					});
				},
			},
		} as unknown as ExtensionContext;

		toolCallGroupingExtension(api);
		await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
		const parent = new Container();
		parent.addChild(component("read", "read-1", { path: "first.ts" }));
		const selection = Promise.resolve(shortcut?.(ctx));
		expect(selectionDone).toBeDefined();
		await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "reload" }, ctx);
		await selection;
	});

	test("uses every tool's original full renderer while expanded", () => {
		install();
		const parent = new Container();
		const tools = [
			component("edit", "edit-expanded", {
				path: "expanded.ts",
				edits: [{ oldText: "before", newText: "after" }],
			}),
			component(
				"bash",
				"bash-expanded",
				{ command: "printf expanded" },
				createBashToolDefinition(process.cwd()),
			),
			component(
				"deploy_service",
				"remote-expanded",
				{ target: "payments" },
				customDefinition(),
			),
		];
		for (const tool of tools) parent.addChild(tool);

		for (const tool of tools) {
			const collapsed = tool.render(120).join("\n");
			tool.setExpanded(true);
			const expanded = tool.render(120).join("\n");
			expect(collapsed).toMatch(/• (Editing|Running|Calling)/);
			expect(expanded).not.toMatch(/• (Editing|Running|Calling)/);
			expect(expanded.length).toBeGreaterThan(0);
		}
	});

	test("keeps exploration and semantic rows ANSI-safe and width-safe", () => {
		install();
		const parent = new Container();
		const tools = [
			component("read", "read-long", { path: "a/very/long/path/that/does/not/fit.ts" }),
			component("write", "write-long", {
				path: "a/very/long/path/that/does/not/fit.ts",
				content: "one\ntwo",
			}),
			component(
				"bash",
				"bash-long",
				{ command: "printf a-very-long-command-that-does-not-fit" },
				createBashToolDefinition(process.cwd()),
			),
			component(
				"deploy_service",
				"remote-long",
				{ target: "a-very-long-service-name-that-does-not-fit" },
				customDefinition(),
			),
		];
		for (const tool of tools) parent.addChild(tool);
		tools[2]?.updateResult(
			{ content: [{ type: "text", text: "\u001b[31mvery long output that does not fit\u001b[0m" }], isError: false },
			false,
		);

		for (const tool of tools) {
			const lines = tool.render(18);
			expect(lines.every((line) => visibleWidth(line) <= 18)).toBe(true);
		}
	});
});
