import type { AssistantMessage } from "@earendil-works/pi-ai";
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
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type TUI, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import piToolDisplayExtension from "./index.ts";
import {
	classifyShellCommand,
	classifyToolPresentation,
	type ExplorationToolDescriptor,
	formatExplorationSummary,
	formatCompletedSummary,
	formatCommandSummary,
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
		"realpath .pi/extensions/pi-tool-display/logic.ts",
		"diff -q logic.ts ../logic.ts && git diff --check && git diff --stat",
		"ls -la node_modules/vitest 2>/dev/null; find node_modules -path '*/vitest/dist/cli.js' -print | head",
		"find . -iname '*tool-call-group*' | head -50 && rg -n 'tool-call-group' .pi packages 2>/dev/null | head -200",
		"find ~/.pi -type f -maxdepth 5 2> /dev/null | rg 'tool-call|group'",
		"sed -n '1,20p' README.md",
		"wc -l .pi/extensions/pi-tool-display/*.ts; find .pi/extensions/pi-tool-display -name '*.json'",
		"find . -iname '*tool*call*group*' -o -path '*pi-tool-display*'; find ../codex -maxdepth 2 -type f | head -80; git status --short",
		'rg -n "decodeTextSignature|parseTextSignature|TextSignatureV1|textSignature" packages/ai/src | head -100; rg -n "textSignature" packages/coding-agent/src | head -80',
		"find ../codex/codex-rs/tui/src -path '*snapshots*' -type f | xargs rg -L 'Running|Ran|Explored|Edited|Added|Deleted' | head -40",
		"find . -type f -print0 | xargs -0 rg needle | head -40",
		"cd ~/workspace/repo && git status --short",
		"cd /tmp",
		"cd - && pwd",
		"cd repo && git branch --show-current && git status --short | head -20 && git remote -v | head -2",
		"git branch -a --merged main",
		"git tag -l 'v1.*'",
		"git remote show origin",
		"git config --get user.email",
		"git stash list",
		"git worktree list",
		"git ls-remote --heads origin",
		"git rev-list --count HEAD",
		'echo "--- section ---"; ls -la',
		'ls missing 2>/dev/null || echo "absent"',
		'for f in a b c; do [ -e "$f" ] && echo "OK $f" || echo "MISSING $f"; done',
		"if git diff --quiet; then echo clean; else echo dirty; fi",
		"ls -la\ngit status --short\nwc -l README.md",
		"ls nonexistent >/dev/null 2>&1; echo \"exit:$?\"",
		"ls -la &>/dev/null; pwd",
		"printf '%s\\n' one two | sort -u",
		"cat package.json | jq '.scripts'",
		"awk '{ print $1 }' data.txt | uniq -c",
		"basename \"$(pwd)\"; dirname README.md; date",
		"env FOO=1 rg needle src",
		"printenv HOME; whoami; uname -a",
		"curl -s https://example.com/api",
		'curl -s -X GET --header "PRIVATE-TOKEN: $TOKEN" "https://gitlab.example.com/api/v4/projects" | jq .',
		"readlink -f logic.ts; shasum logic.ts; base64 logic.ts | head -1",
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
		"git branch new-feature",
		"git branch -D old-feature",
		"git branch -m old new",
		"git tag v1.0.0",
		"git remote add upstream git@example.com:repo.git",
		"git remote rename origin upstream",
		"git stash pop",
		"git worktree add ../wt feature",
		"git config user.email me@example.com",
		"git config --global user.name Me",
		"cd /tmp && touch file",
		"cd /tmp; rm -rf build",
		'cd "$(rm -rf build)"',
		"curl -o page.html https://example.com",
		"curl -X POST https://example.com/api",
		"curl -d 'a=1' https://example.com/api",
		"curl -sO https://example.com/file.tar",
		"echo hi > file",
		"echo hi >> log",
		"env FOO=1 touch file",
		"awk '{ print $1 > \"out.txt\" }' data.txt",
		"awk 'BEGIN { system(\"rm -rf build\") }'",
		"for f in a b; do touch \"$f\"; done",
		"ls -la\ntouch file",
		"ls missing || touch fallback",
		"fd -x rm {}",
	])("rejects potentially mutating shell command: %s", (command) => {
		expect(isReadOnlyShellCommand(command)).toBe(false);
		expect(isExplorationTool({ name: "bash", args: { command } })).toBe(false);
		expect(isExplorationTool({ name: "hypa_shell", args: { command } })).toBe(false);
	});

	test.each([
		["pwd", "read-only"],
		["cd repo && git status --short", "read-only"],
		["rm -rf build", "mutating"],
		["cd /tmp && touch file", "mutating"],
		["git commit -m wip", "mutating"],
		["git branch new-feature", "mutating"],
		["sed -i 's/a/b/' file", "mutating"],
		["echo hi > file", "mutating"],
		["for f in a b; do rm \"$f\"; done", "mutating"],
		["cat data.json | python3 -c 'import sys, json; print(len(sys.stdin.read()))'", "unknown"],
		["node -e 'console.log(1)'", "unknown"],
		["npm ls --depth 0", "unknown"],
		["gh pr view 12", "unknown"],
		["", "unknown"],
	])("assigns a three-state shell verdict: %s", (command, verdict) => {
		expect(classifyShellCommand(command)).toBe(verdict);
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

describe("command summaries", () => {

	test("limits bash command text to thirty characters", () => {
		expect(
			formatCommandSummary({
				name: "bash",
				args: {
					command: "12345678901234567890123456789012345",
					intentKind: "modify",
					intentText: "Copy URL",
				},
			}, 30),
		).toBe("$ 123456789012345678901234567890…");
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
		activePatch = installToolCallGroupingPatch({ hidePending: false,
			getTheme: () => undefined,
			onParentRebuild,
			onCompactTextOutputNormalize,
			onCustomRowsCompute,
		});
		expect(activePatch.installed).toBe(true);
		return activePatch;
	}

	test.each([[true, false], [false, true], [true, true], [false, false]])(
		"colors only the failure count red (first failed: %s, last failed: %s)",
		(firstFailed, lastFailed) => {
			activePatch = installToolCallGroupingPatch({ hidePending: false, getTheme: () => activeTheme });
			const parent = new Container();
			const first = component("read", "color-first", { path: "first.ts" });
			const last = component("read", "color-last", { path: "last.ts" });
			parent.addChild(first);
			parent.addChild(last);
			// Completion order must not override transcript order.
			last.updateResult({ content: [], isError: lastFailed }, false);
			first.updateResult({ content: [], isError: firstFailed }, false);
			const failed = Number(firstFailed) + Number(lastFailed);
			const summary = activeTheme.fg("muted", activeTheme.bold("Read 2 files"));
			const suffix = failed ? activeTheme.fg("error", activeTheme.bold(` · ${failed} failed`)) : "";
			expect(first.render(120)[1]).toBe(`• ${summary}${suffix}`);
		},
	);

	test("counts all tool kinds in first-seen order without arguments or output", () => {
		const names = ["read", "read", "bash", "hypa_shell", "bash", "edit", "write", "codemode", "grep", "find", "web_search", "ls", "ls", "mcp", "unknown"];
		expect(formatCompletedSummary(names.map((name) => ({ name, args: { path: "secret" } })), 2)).toBe(
			"Read 2 files, ran 3 shell commands, edited 1 file, wrote 1 file, ran 1 script, ran 3 searches, listed 2 directories, made 2 tool calls · 2 failed",
		);
	});

	test("collapses mixed completed calls across thinking and tool-only rows, retaining pending output", () => {
		install();
		const parent = new Container();
		const read = component("read", "mixed-read", { path: "secret.ts" });
		const shell = component("bash", "mixed-shell", { command: "npm test" }, createBashToolDefinition(process.cwd()));
		const edit = component("edit", "mixed-edit", { path: "pending.ts", oldText: "a", newText: "b" });
		const remote = component("unknown", "mixed-unknown", { target: "secret" });
		parent.addChild(read);
		parent.addChild(thinkingComponent("mixed-shell", "bash"));
		parent.addChild(shell);
		parent.addChild(new AssistantMessageComponent(thinkingMessage(), true));
		parent.addChild(edit);
		parent.addChild(remote);
		const pendingEdit = edit.render(120);
		read.updateResult({ content: [{ type: "text", text: "secret output" }], isError: true }, false);
		shell.updateResult({ content: [{ type: "text", text: "live output" }] }, true);
		remote.updateResult({ content: [], isError: true }, false);
		expect(read.render(120)).toEqual(["", "• Read 1 file, made 1 tool call · 2 failed"]);
		expect(remote.render(120)).toEqual([]);
		expect(shell.render(120)).toContain("  live output");
		expect(edit.render(120)).toEqual(pendingEdit);
		shell.updateResult({ content: [], isError: false }, false);
		expect(read.render(120)).toEqual(["", "• Read 1 file, ran 1 shell command, made 1 tool call · 2 failed"]);
		expect(shell.render(120)).toEqual([]);
		expect(parent.render(120).join("\n")).not.toContain("secret");
	});

	test("does not collapse error-marked partial results before final completion", () => {
		install();
		const parent = new Container();
		const read = component("read", "partial-failure", { path: "visible.ts" });
		parent.addChild(read);
		read.updateResult({ content: [], isError: true }, true);
		expect(read.render(120)).toEqual(["", "• Exploring", "  └ Read visible.ts"]);
		read.updateResult({ content: [], isError: true }, false);
		expect(read.render(120)).toEqual(["", "• Read 1 file · 1 failed"]);
	});

	test("replays mixed sequences and rebuilds boundaries when assistant prose streams in", () => {
		const parent = new Container();
		const read = component("read", "boundary-read", { path: "one" });
		const assistant = thinkingComponent("boundary-edit", "edit");
		const edit = component("edit", "boundary-edit", { path: "two", edits: [] });
		const last = component("bash", "boundary-shell", { command: "npm test" }, createBashToolDefinition(process.cwd()));
		for (const tool of [read, edit, last]) tool.updateResult({ content: [] }, false);
		parent.addChild(read);
		parent.addChild(assistant);
		parent.addChild(edit);
		parent.addChild(new UserMessageComponent("next request"));
		parent.addChild(last);
		const patch = install();
		parent.render(120);
		expect(read.render(120)).toEqual(["", "• Read 1 file, edited 1 file"]);
		expect(edit.render(120)).toEqual([]);
		expect(last.render(120)).toEqual(["", "• Ran 1 shell command"]);
		assistant.updateContent(thinkingMessage("boundary-edit", "edit", "Visible boundary"));
		expect(read.render(120)).toEqual(["", "• Read 1 file"]);
		expect(edit.render(120)).toEqual(["", "• Edited 1 file"]);
		assistant.updateContent(thinkingMessage("boundary-edit", "edit"));
		expect(read.render(120)).toEqual(["", "• Read 1 file, edited 1 file"]);
		patch.reset();
		parent.render(120);
		expect(read.render(120)).toEqual(["", "• Read 1 file, edited 1 file"]);
	});

	test("moves summary leadership on out-of-order completion, expansion, removal and reparenting", () => {
		const patch = install();
		const parent = new Container();
		const first = component("read", "leader-first", { path: "first" });
		const second = component("bash", "leader-second", { command: "npm test" }, createBashToolDefinition(process.cwd()));
		const third = component("write", "leader-third", { path: "third", content: "x" });
		for (const tool of [first, second, third]) parent.addChild(tool);
		second.updateResult({ content: [{ type: "text", text: "error details" }], isError: true }, false);
		third.updateResult({ content: [] }, false);
		expect(second.render(120)).toEqual(["", "• Ran 1 shell command, wrote 1 file · 1 failed"]);
		first.updateResult({ content: [] }, false);
		expect(second.render(120)).toEqual([]);
		expect(first.render(120)).toEqual(["", "• Read 1 file, ran 1 shell command, wrote 1 file · 1 failed"]);
		expect(patch.beginSelection()).toEqual(["a", "s", "d"]);
		expect(first.render(120)[1]).toContain("[a] [s] [d]");
		expect(patch.expandSelection("s")).toBe(true);
		expect(second.render(120).join("\n")).toContain("error details");
		expect(first.render(120)).toEqual(["", "• Read 1 file, wrote 1 file"]);
		second.setExpanded(false);
		parent.removeChild(first);
		expect(second.render(120)).toEqual(["", "• Ran 1 shell command, wrote 1 file · 1 failed"]);
		const other = new Container();
		parent.removeChild(third);
		other.addChild(third);
		expect(second.render(120)).toEqual(["", "• Ran 1 shell command · 1 failed"]);
		expect(third.render(120)).toEqual(["", "• Wrote 1 file"]);
		other.clear();
		expect(third.render(120)).toEqual(["", "• Wrote 1 file"]);
	});

	test("caches completed subsets during pending redraws and invalidates late failures", () => {
		let computations = 0;
		install(undefined, undefined, () => computations++);
		const parent = new Container();
		const first = component("read", "subset-first", { path: "first" });
		const second = component("read", "subset-second", { path: "second" });
		parent.addChild(first);
		parent.addChild(second);
		first.updateResult({ content: [] }, false);
		const cached = first.render(120);
		for (let i = 0; i < 128; i++) expect(first.render(120)).toBe(cached);
		expect(computations).toBe(1);
		second.updateResult({ content: [], isError: true }, false);
		expect(first.render(120)).toEqual(["", "• Read 2 files · 1 failed"]);
		expect(second.render(120)).toEqual([]);
		expect(computations).toBe(2);
		second.updateResult({ content: [], isError: false }, false);
		expect(first.render(120)).toEqual(["", "• Read 2 files"]);
		second.updateResult({ content: [] }, true);
		expect(first.render(120)).toEqual(["", "• Read 1 file"]);
		expect(second.render(120)).toEqual(["", "• Exploring", "  └ Read second"]);
	});

	test("renders pending exploration details and collapses completion to counts", () => {
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
		expect(read.render(120)[1]).toBe("• Read 1 file, ran 1 search");
	});

	test("adds a sequential pending exploration to the existing group immediately", () => {
		install();
		const parent = new Container();
		const previous = component("read", "read-before-next", { path: "previous.ts" });
		parent.addChild(previous);
		previous.updateResult({ content: [{ type: "text", text: "previous" }], isError: false }, false);

		const next = component("read", "read-next", { path: "next.ts" });
		parent.addChild(next);
		expect(previous.render(120)).toEqual(["", "• Read 1 file"]);
		expect(next.render(120)).toEqual(["", "• Exploring", "  └ Read next.ts"]);

		next.updateResult({ content: [{ type: "text", text: "next" }], isError: false }, false);
		expect(previous.render(120)[1]).toBe("• Read 2 files");
	});

	test("adds a streamed exploration bash call to the existing group immediately", () => {
		install();
		const parent = new Container();
		const previous = component("read", "read-before-bash", { path: "previous.ts" });
		parent.addChild(previous);
		previous.updateResult({ content: [{ type: "text", text: "previous" }], isError: false }, false);
		const command = component(
			"bash",
			"streamed-bash",
			{ command: "sleep 4; pwd" },
			createBashToolDefinition(process.cwd()),
		);
		parent.addChild(command);
		expect(command.render(120)[1]).toContain("Running");

		command.updateArgs({
			command: "sleep 4; pwd",
			intentKind: "explore",
			intentText: "Wait and print working directory",
		});
		expect(previous.render(120)).toEqual(["", "• Read 1 file"]);
		expect(command.render(120)).toEqual(["", "• Running $ sleep 4; pwd"]);
		command.updateResult({ content: [{ type: "text", text: "cwd" }], isError: false }, false);
		parent.addChild(thinkingComponent("next", "read", "Done."));
		expect(previous.render(120)).toEqual(["", "• Read 1 file, ran 1 shell command"]);
		expect(command.render(120)).toEqual([]);
	});


	test("uses distinct lifecycle colors for pending, completed, and failed headers", () => {
		activePatch = installToolCallGroupingPatch({ hidePending: false, getTheme: () => activeTheme });
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
		expect(read.render(120)[1]).toBe(`• ${activeTheme.fg("muted", activeTheme.bold("Read 1 file, listed 1 directory"))}`);
		expect(edit.render(120)[1]).toBe(`• ${activeTheme.fg("muted", activeTheme.bold("Edited 1 file, wrote 1 file"))}`);
		expect(command.render(120)[1]).toBe(
			`• ${activeTheme.fg("muted", activeTheme.bold("Ran 1 shell command"))}`,
		);
		expect(firstRemote.render(120)[1]).toBe(`• ${activeTheme.fg("muted", activeTheme.bold("Made 2 tool calls"))}`);

		const truncatedCommandHeader = command.render(18)[1] ?? "";
		expect(visibleWidth(truncatedCommandHeader)).toBeLessThanOrEqual(18);
		expect(truncatedCommandHeader).toContain(activeTheme.getFgAnsi("muted"));

		command.updateResult({ content: [{ type: "text", text: "failed" }], isError: true }, false);
		expect(command.render(120)[1]).toBe(
			`• ${activeTheme.fg("muted", activeTheme.bold("Ran 1 shell command"))}${activeTheme.fg("error", activeTheme.bold(" · 1 failed"))}`,
		);
	});

	test("uses visible assistant prose as an exploration boundary during replay", () => {
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

		expect(first.render(120)).toEqual(["", "• Exploring", "  └ Read first.ts"]);
		expect(shell.render(120)).toEqual([
			"",
			"• Exploring",
			"  ├ $ git status --short",
			"  └ Find *.ts",
		]);
		expect(last.render(120)).toEqual([]);
	});

	test("uses user messages as exploration boundaries when adopting old sessions", () => {
		const parent = new Container();
		const first = component("read", "old-read-1", { path: "first.ts" });
		const last = component("read", "old-read-2", { path: "last.ts" });
		first.updateResult({ content: [{ type: "text", text: "first" }], isError: false }, false);
		last.updateResult({ content: [{ type: "text", text: "last" }], isError: false }, false);
		parent.addChild(first);
		parent.addChild(new UserMessageComponent("Continue."));
		parent.addChild(last);

		install();
		parent.render(120);
		expect(first.render(120)).toEqual(["", "• Read 1 file"]);
		expect(last.render(120)).toEqual(["", "• Read 1 file"]);
	});

	test("uses an actual non-exploration tool as an exploration boundary", () => {
		install();
		const parent = new Container();
		const first = component("read", "read-1", { path: "first.ts" });
		const command = component(
			"bash",
			"bash-1",
			{ command: "touch changed" },
			createBashToolDefinition(process.cwd()),
		);
		const last = component("ls", "ls-1", { path: "src" });
		parent.addChild(first);
		parent.addChild(command);
		parent.addChild(last);

		expect(first.render(120)).toEqual(["", "• Exploring", "  └ Read first.ts"]);
		expect(command.render(120)).toEqual(["", "• Running $ touch changed"]);
		expect(last.render(120)).toEqual(["", "• Exploring", "  └ List src"]);
	});

	test("filters thinking-only, mixed, and streaming assistant updates without blank rows or input mutation", () => {
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
		expect(first.render(120)).toEqual(["", "• Read 2 files"]);
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

	test("expands a selected completed call while summarizing remaining calls", () => {
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
		expect(first.render(120)).toContain("• Read 3 files [a] [s] [d]");
		expect(patch.expandSelection("s")).toBe(true);
		expect(first.render(120)).toEqual(["", "• Read 2 files"]);
		expect(middle.render(120).join("\n")).toContain("middle");
		expect(middle.render(120).join("\n")).not.toContain("• Explored");
		expect(last.render(120)).toEqual([]);
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

	test("keeps pending mutation statistics and summarizes success and failure", () => {
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
		expect(edit.render(120)).toEqual(["", "• Edited 1 file"]);

		const writeParent = new Container();
		const write = component("write", "write-1", { path: "src/new.ts", content: "one\ntwo\n" });
		writeParent.addChild(write);
		expect(write.render(120)).toEqual(["", "• Writing src/new.ts", "  2 lines"]);
		write.updateResult({ content: [{ type: "text", text: "Successfully wrote file" }], isError: false }, false);
		expect(write.render(120)).toEqual(["", "• Wrote 1 file"]);

		write.updateResult({ content: [{ type: "text", text: "permission denied" }], isError: true }, false);
		expect(write.render(120)).toEqual(["", "• Wrote 1 file · 1 failed"]);
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
		expect(first.render(120)[1]).toBe("• Edited 2 files");
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

	test("counts mixed edit and write groups", () => {
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
		expect(edit.render(120)).toEqual(["", "• Edited 1 file, wrote 1 file"]);
		expect(write.render(120)).toEqual([]);
	});

	test("summarizes failed edits separately from pending edits", () => {
		install();
		const parent = new Container();
		const first = component("edit", "edit-1", { path: "first.ts", edits: [{ oldText: "a", newText: "b" }] });
		const failed = component("edit", "edit-2", { path: "failed.ts", edits: [{ oldText: "a", newText: "b" }] });
		const third = component("edit", "edit-3", { path: "third.ts", edits: [{ oldText: "a", newText: "b" }] });
		const fourth = component("edit", "edit-4", { path: "fourth.ts", edits: [{ oldText: "a", newText: "b" }] });
		for (const mutation of [first, failed, third, fourth]) parent.addChild(mutation);
		failed.updateResult({ content: [{ type: "text", text: "permission denied" }], isError: true }, false);

		expect(first.render(120)).toEqual([
			"",
			"• Editing",
			"  ├ first.ts (+1 -1)",
			"  ├ third.ts (+1 -1)",
			"  └ fourth.ts (+1 -1)",
		]);
		expect(failed.render(120)).toEqual(["", "• Edited 1 file · 1 failed"]);
		for (const mutation of [first, third, fourth]) {
			mutation.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
		}
		expect(first.render(120)[1]).toBe("• Edited 4 files · 1 failed");
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
		expect(computations).toBe(1);
		for (let redraw = 0; redraw < 128; redraw += 1) expect(parent.render(120)).toEqual(expected);
		expect(computations).toBe(1);
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
		expect(after).toEqual(["", "• Edited 2 files"]);
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
		expect(settledGroup[1]).toBe("• Read 1 file, listed 1 directory");
		expect(read.render(120)).toBe(settledGroup);
		expect(computations).toBe(7);
	});

	test("never normalizes hidden completed command output", () => {
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

		expect(successful.render(120)).toEqual(["", "• Ran 2 shell commands · 1 failed"]);
		expect(successful.render(120)).toEqual(["", "• Ran 2 shell commands · 1 failed"]);
		expect(failed.render(120)).toEqual([]);
		expect(failed.render(120)).toEqual([]);
		expect(normalizations).toBe(0);
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
		expect(normalizations).toBe(0);

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
		expect(running.render(120)).toEqual(["", "• Ran 1 shell command"]);

		failed.updateResult({ content: [{ type: "text", text: "permission denied" }], isError: true }, false);
		expect(failed.render(120)).toEqual([]);
		expect(running.render(120)).toEqual(["", "• Ran 2 shell commands · 1 failed"]);
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
		expect(mcp.render(120)).toEqual(["", "• Made 2 tool calls · 1 failed"]);
		expect(custom.render(120)).toEqual([]);
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
		expect(agent.render(120)).toEqual(["", "• Called 1 subagent, made 1 tool call"]);
	});

	test("summarizes failed remote calls and retains pending remote grouping", () => {
		install();
		const parent = new Container();
		const first = component("deploy_service", "remote-1", { target: "one" }, customDefinition());
		const failed = component("deploy_service", "remote-2", { target: "two" }, customDefinition());
		const third = component("deploy_service", "remote-3", { target: "three" }, customDefinition());
		const fourth = component("deploy_service", "remote-4", { target: "four" }, customDefinition());
		for (const remote of [first, failed, third, fourth]) parent.addChild(remote);
		failed.updateResult({ content: [{ type: "text", text: "rejected" }], isError: true }, false);

		expect(first.render(120)).toEqual(["", "• Calling", "  ├ Deploy service one", "  ├ Deploy service three", "  └ Deploy service four"]);
		expect(failed.render(120)).toContain("• Made 1 tool call · 1 failed");
		expect(third.render(120)).toEqual([]);
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
			{ command: "touch changed" },
			createBashToolDefinition(process.cwd()),
		);
		const remote = component("mcp", "mcp-1", { action: "connect", server: "jira" }, mcpDefinition());
		const second = component("read", "read-2", { path: "second.ts" });
		for (const child of [first, edit, command, remote, second]) parent.addChild(child);

		expect(first.render(120)).toEqual(["", "• Exploring", "  └ Read first.ts"]);
		expect(edit.render(120)[1]).toBe("• Editing changed.ts");
		expect(command.render(120)[1]).toBe("• Running $ touch changed");
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
		activePatch = installToolCallGroupingPatch({ hidePending: false,
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
		expect(command.render(120).join("\n")).toContain("first:muted:");
		expect(command.render(120).join("\n")).toContain("first:muted:");
		expect(computations).toBe(1);

		currentTheme = themed("second");
		const changed = command.render(120).join("\n");
		expect(changed).toContain("second:muted:");
		expect(changed).not.toContain("first:muted:");
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
		activePatch = installToolCallGroupingPatch({ hidePending: false,
			getTheme: () => undefined,
			onCustomRowsCompute: () => {
				reloadComputations += 1;
			},
		});
		command.render(120);
		command.render(120);
		expect(reloadComputations).toBe(1);
	});

	test("caches completed remote failures as one count summary", () => {
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

		expect(remotes[0]?.render(120)).toContain("• Made 4 tool calls · 1 failed");
		expect(remotes[1]?.render(120)).toEqual([]);
		expect(remotes[2]?.render(120)).toEqual([]);
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
		const secondPatch = installToolCallGroupingPatch({ hidePending: false, getTheme: () => undefined });
		expect(secondPatch).toBe(firstPatch);
		expect(ToolExecutionComponent.prototype.render).toBe(wrappedRender);
		// Pi now owns this renderer; the patch only wraps updateContent.
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
			piToolDisplayExtension({
				on(event: string, handler: Handler) {
					handlers.set(event, handler);
				},
				registerShortcut() {},
				getAllTools: () => [],
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
			expect(successHeader).toContain("Read 1 file");
			expect(successHeader).toContain("\u001b[");
			expect(successHeader).toContain(activeTheme.getFgAnsi("muted"));
			expect(errorHeader).toContain("Ran 1 shell command");
			expect(errorHeader).toContain(" · 1 failed");
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
			getAllTools: () => [],
		} as unknown as ExtensionAPI;
		const originalRender = ToolExecutionComponent.prototype.render;
		const originalAssistantRender = AssistantMessageComponent.prototype.render;
		let toolsExpanded: boolean | undefined;

		piToolDisplayExtension(api);
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
			expect(toolsExpanded).toBeUndefined();
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
			piToolDisplayExtension({
				on(event: string, handler: Handler) {
					handlers.set(event, handler);
				},
				registerShortcut() {},
				getAllTools: () => [],
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
			leader.updateResult({ content: [], isError: false }, false);
			follower.updateResult({ content: [], isError: false }, false);
			expect(leader.render(120).join("\n")).toContain("listed 1 directory");
			expect(follower.render(120)).toEqual([]);

			await subagentHandlers.get("session_start")?.(
				{ type: "session_start", reason: "startup" },
				subagentContext,
			);
			expect(leader.render(120).join("\n")).toContain("listed 1 directory");
			expect(follower.render(120)).toEqual([]);
			await subagentHandlers.get("session_shutdown")?.(
				{ type: "session_shutdown", reason: "quit" },
				subagentContext,
			);
			expect(ToolExecutionComponent.prototype.render).toBe(wrappedRender);
			expect(leader.render(120).join("\n")).toContain("listed 1 directory");
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
			getAllTools: () => [],
		} as unknown as ExtensionAPI;

		piToolDisplayExtension(api);
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
			for (const tool of tools) { parent.addChild(tool); tool.updateResult({ content: [], isError: false }, false); }

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
			getAllTools: () => [],
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

		piToolDisplayExtension(api);
		await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
		const parent = new Container();
		const ready = component("read", "read-1", { path: "first.ts" });
		ready.updateResult({ content: [], isError: false }, false);
		parent.addChild(ready);
		const selection = Promise.resolve(shortcut?.(ctx));
		expect(selectionDone).toBeDefined();
		await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "reload" }, ctx);
		await selection;
	});


	test("invalidates summary hit regions on resize and resets mouse expansion", () => {
		const patch = install();
		const parent = new Container();
		const tool = component("read", "mouse-reset", { path: "file.ts" });
		parent.addChild(tool);
		tool.updateResult({ content: [{ type: "text", text: "full detail" }], isError: false }, false);
		const event = (width: number): TuiMouseEvent => ({
			type: "click", button: "left", x: 3, y: 1, screenX: 3, screenY: 1,
			width, height: 2, shift: false, alt: false, ctrl: false,
		});
		const collapsed = parent.render(120);
		expect(tool.handleMouse(event(80))).toBeUndefined();
		tool.invalidate();
		expect(tool.handleMouse(event(120))).toBeUndefined();
		parent.render(80);
		expect(tool.handleMouse(event(80))).toMatchObject({ handled: true, render: true });
		expect(parent.render(80).join("\n")).toContain("full detail");
		patch.reset();
		expect(tool.handleMouse(event(80))).toBeUndefined();
		expect(parent.render(120)).toEqual(collapsed);
		expect(tool.handleMouse(event(120))).toMatchObject({ handled: true, render: true });
		parent.render(120);
		parent.removeChild(tool);
		parent.addChild(tool);
		expect(parent.render(120)).toEqual(collapsed);
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
				{ command: "touch expanded" },
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

describe("completed section interactions (default configuration)", () => {
	const result = (isError = false) => ({ content: [{ type: "text" as const, text: Array.from({ length: 40 }, (_, i) => `output ${i}`).join("\n") }], isError });
	function click(tool: ToolExecutionComponent, x: number, y = 1, width = 120) {
		return tool.handleMouse({ type: "click", button: "left", x, y, screenX: x, screenY: y, width, height: 100, shift: false, alt: false, ctrl: false });
	}
	test("hides every pending and partial call, even expanded; only completed calls get keyboard labels", () => {
		activePatch = installToolCallGroupingPatch({ getTheme: () => undefined });
		const parent = new Container();
		for (const name of ["read", "edit", "write", "bash", "codemode", "unknown"]) {
			const tool = component(name, name, { command: "pwd", path: "a", code: "return 1" });
			parent.addChild(tool);
			tool.setExpanded(true);
			expect(tool.render(120)).toEqual([]);
			tool.updateResult(result(true), true);
			expect(tool.render(120)).toEqual([]);
		}
		expect(parent.render(120)).toEqual([]);
		expect(activePatch.beginSelection()).toEqual([]);
	});

	test("switches read/edit/shell/failure sections, uses native collapsed details, closes by section or detail", () => {
		const nativeRender = ToolExecutionComponent.prototype.render;
		const nativeMouse = ToolExecutionComponent.prototype.handleMouse;
		activePatch = installToolCallGroupingPatch({ getTheme: () => activeTheme });
		const parent = new Container();
		parent.addChild(new Text("offset", 0, 0));
		const tools = [component("read", "r", { path: "世界.ts" }), component("edit", "e", { path: "e", oldText: "a", newText: "b" }), component("bash", "b", { command: "false" }, createBashToolDefinition(process.cwd()))];
		tools.forEach((tool, i) => { parent.addChild(tool); tool.updateResult(result(i !== 0), false); });
		const native = tools.map(tool => nativeRender.call(tool, 120));
		const summary = parent.render(120);
		const first = tools[0]!;
		// Container translates screen rows into component-local rows.
		expect(parent.handleMouse({ type: "click", button: "left", x: 3, y: 2, screenX: 3, screenY: 2, width: 120, height: summary.length, shift: false, alt: false, ctrl: false })).toMatchObject({ handled: true });
		parent.render(120);
		expect(first.render(120).slice(2)).toEqual(native[0]);
		expect(tools[1]!.render(120)).toEqual([]);
		expect(tools[2]!.render(120)).toEqual([]);
		const plain = "• Read 1 file, edited 1 file, ran 1 shell command · 2 failed";
		for (const [segment, indices] of [["edited", [1]], ["ran", [2]], ["2 failed", [1, 2]]] as const) {
			expect(click(first, plain.indexOf(segment))).toMatchObject({ handled: true });
			parent.render(120);
			tools.forEach((tool, i) => expect(i === 0 ? tool.render(120).slice(2) : tool.render(120)).toEqual((indices as readonly number[]).includes(i) ? native[i] : []));
		}
		expect(click(first, plain.indexOf("2 failed"))).toMatchObject({ handled: true });
		expect(parent.render(120)).toEqual(summary);
		click(first, plain.indexOf("ran")); parent.render(120);
		expect(click(tools[2]!, 3, 2)).toMatchObject({ handled: true });
		expect(parent.render(120)).toEqual(summary);
		click(first, 3); parent.render(120);
		expect(activePatch.beginSelection()).toEqual(["a", "s", "d"]);
		expect(activePatch.expandSelection("a")).toBe(true);
		expect(first.render(120)).toEqual(nativeRender.call(first, 120));
		activePatch.restore();
		expect(ToolExecutionComponent.prototype.handleMouse).toBe(nativeMouse);
	});

	test("uses visible columns under ANSI, excludes separators, padding, ellipsis and clipped sections", () => {
		activePatch = installToolCallGroupingPatch({ getTheme: () => activeTheme });
		const parent = new Container();
		const read = component("read", "r", { path: "emoji-😀" });
		const shell = component("bash", "b", { command: "false" });
		for (const tool of [read, shell]) { parent.addChild(tool); tool.updateResult(result(true), false); }
		parent.render(120);
		for (const x of [0, 1, 13, 119]) expect(click(read, x)).toBeUndefined();
		parent.render(16);
		expect(click(read, 15, 1, 16)).toBeUndefined();
		expect(click(read, 16, 1, 16)).toBeUndefined();
		expect(click(read, 3, 1, 120)).toBeUndefined();
		expect(click(read, 3, 1, 16)).toMatchObject({ handled: true });
		parent.render(16);
		expect(shell.render(16)).toEqual([]);
		activePatch.reset();
		expect(click(read, 3, 1, 16)).toBeUndefined();
		expect(parent.render(16)).toHaveLength(2);
	});

	test("does not inject schemas/prompts and ignores legacy intent metadata", () => {
		const events: string[] = [];
		piToolDisplayExtension({ on: (name: string) => events.push(name), registerShortcut() {}, getAllTools() { throw new Error("must not inspect schemas"); } } as unknown as ExtensionAPI);
		expect(events).not.toContain("before_agent_start");
		expect(isExplorationTool({ name: "read", args: { intentKind: "modify" } })).toBe(true);
		expect(isExplorationTool({ name: "bash", args: { command: "python3 -c 'print(1)'", intentKind: "explore" } })).toBe(false);
		expect(formatExplorationSummary({ name: "bash", args: { command: "pwd", intentText: "Ignore me" } })).toBe("$ pwd");
		expect(formatCommandSummary({ name: "codemode", args: { code: "// Ignore me\nreturn 1" } })).toBe("codemode");
	});
});

describe("subagent summaries and hover", () => {
	const done = (error = false) => ({ content: [{ type: "text" as const, text: "done" }], isError: error });
	const move = (x: number, y = 1, width = 120): TuiMouseEvent => ({ type: "move", button: "none", x, y, screenX: x, screenY: y, width, height: 100, shift: false, alt: false, ctrl: false });
	const plain = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

	test.each(["Agent", "agent", "AGENT", "subagent", "SubAgent"])("counts %s as a launch", name => {
		expect(formatCompletedSummary([{ name }])).toBe("Called 1 subagent");
		expect(formatCompletedSummary([{ name }, { name }])).toBe("Called 2 subagents");
	});
	test.each(["AgentStatus", "MessageAgent", "StopAgent", "get_subagent_result", "launch_agent_maybe"])("does not infer launches from %s", name => {
		expect(formatCompletedSummary([{ name }])).toBe("Made 1 tool call");
	});
	test("codemode containing agent calls remains a script", () => {
		expect(formatCompletedSummary([{ name: "codemode", args: { code: 'await tools.Agent({})' } }])).toBe("Ran 1 script");
	});
	test("subagent category filters native collapsed previews independently of management and scripts", () => {
		const native = ToolExecutionComponent.prototype.render;
		activePatch = installToolCallGroupingPatch({ getTheme: () => undefined });
		const parent = new Container();
		const tools = ["Agent", "subagent", "AgentStatus", "codemode"].map(name => component(name, name, {}, customDefinition(name)));
		tools.forEach(tool => { parent.addChild(tool); tool.updateResult(done(), false); });
		expect(parent.render(120)).toEqual(["", "• Called 2 subagents, made 1 tool call, ran 1 script"]);
		expect(tools[0]!.handleMouse({ ...move(3), type: "click", button: "left" })).toMatchObject({ handled: true });
		parent.render(120);
		expect(tools[0]!.render(120).slice(2)).toEqual(native.call(tools[0], 120));
		expect(tools[1]!.render(120)).toEqual(native.call(tools[1], 120));
		expect(tools[2]!.render(120)).toEqual([]);
		expect(tools[3]!.render(120)).toEqual([]);
	});
	test("enter/change/leave, other component and blank area; no recompute on repeated moves", () => {
		let computes = 0;
		activePatch = installToolCallGroupingPatch({ getTheme: () => activeTheme, onCustomRowsCompute: () => computes++ });
		const parent = new Container();
		const tool = component("read", "hover", { path: "世界😀" });
		const agent = component("Agent", "agent", {}, customDefinition("Agent"));
		for (const t of [tool, agent]) { parent.addChild(t); t.updateResult(done(t === agent), false); }
		parent.addChild(new Text("other transcript component", 0, 0));
		const initial = parent.render(120);
		expect(parent.handleMouse(move(3))).toMatchObject({ render: true });
		let lines = parent.render(120);
		expect(lines[1]).toContain(activeTheme.getFgAnsi("text") + "Read 1 file");
		expect(lines[1]).toContain(activeTheme.getFgAnsi("muted") + ", called 1 subagent");
		const afterEnter = computes;
		expect(parent.handleMouse(move(4))).toBeUndefined();
		parent.render(120);
		expect(computes).toBe(afterEnter);
		const agentX = plain(lines[1]!).indexOf("called");
		expect(parent.handleMouse(move(agentX))).toMatchObject({ render: true });
		lines = parent.render(120);
		expect(lines[1]).not.toContain(activeTheme.getFgAnsi("text") + "Read");
		expect(lines[1]).toContain(activeTheme.getFgAnsi("text") + "called 1 subagent");
		expect(lines[1]).toContain(activeTheme.fg("error", activeTheme.bold(" · 1 failed")));
		const failureX = plain(lines[1]!).indexOf("1 failed");
		parent.handleMouse(move(failureX));
		lines = parent.render(120);
		expect(lines[1]).toContain(activeTheme.getFgAnsi("text") + "1 failed");
		expect(lines[1]).not.toContain("\x1b[4m");
		expect(lines.every(line => visibleWidth(line) <= 120)).toBe(true);
		for (const event of [move(3, 2), move(110), move(3, 99), move(13)]) {
			parent.handleMouse(move(3)); parent.render(120);
			expect(parent.handleMouse(event)).toMatchObject({ render: true });
			expect(parent.render(120)).toEqual(initial);
		}
		parent.handleMouse(move(3)); parent.render(120);
		const narrow = parent.render(10);
		expect(narrow.every(line => visibleWidth(line) <= 10)).toBe(true);
		expect(narrow.join("")).not.toContain(activeTheme.getFgAnsi("text"));
		expect(parent.handleMouse(move(9, 1, 10))).toBeUndefined(); // ellipsis
		expect(parent.handleMouse(move(3, 1, 10))).toMatchObject({ render: true });
		parent.render(10);
		activePatch.reset();
		expect(parent.render(10).join("")).not.toContain(activeTheme.getFgAnsi("text"));
	});
	test("owning fullscreen router clears outside containers, on wheel/keyboard scroll/resize, and restores instance hooks", () => {
		let renders = 0;
		let scrollTop = 0;
		const ui = {
			terminal: { columns: 120, rows: 40 },
			getPrimaryScrollView: () => ({ scrollTop }),
			requestRender() { renders++; },
			createMouseEvent: (_type: string, _button: number, x: number, y: number) => move(x, y),
		};
		const originalMouse = ui.createMouseEvent;
		const originalRender = ui.requestRender;
		const originalContainerMouse = Container.prototype.handleMouse;
		activePatch = installToolCallGroupingPatch({ getTheme: () => activeTheme });
		const tool = new ToolExecutionComponent("read", "owned", { path: "x" }, {}, undefined, ui as unknown as TUI, process.cwd());
		tool.updateResult(done(), false);
		tool.render(120);
		const enter = () => { tool.handleMouse(move(3)); tool.render(120); };
		enter();
		const count = renders;
		ui.createMouseEvent("move", 35, 4, 1);
		expect(renders).toBe(count);
		ui.createMouseEvent("move", 35, 3, 35); // outside transcript entirely
		expect(renders).toBe(count + 1);
		expect(tool.render(120).join("")).not.toContain(activeTheme.getFgAnsi("text"));
		enter(); scrollTop++; ui.requestRender();
		expect(tool.render(120).join("")).not.toContain(activeTheme.getFgAnsi("text"));
		enter(); ui.terminal.rows++; ui.requestRender();
		expect(tool.render(120).join("")).not.toContain(activeTheme.getFgAnsi("text"));
		for (const event of [{ ...move(3), type: "wheel" as const, wheelDelta: 1 }, { ...move(3), type: "drag" as const, button: "left" as const }, { ...move(3), type: "click" as const, button: "right" as const }]) {
			enter();
			expect(tool.handleMouse(event)).toBeUndefined();
			expect(tool.render(120).join("")).not.toContain(activeTheme.getFgAnsi("text"));
		}
		activePatch.reset();
		expect(ui.createMouseEvent).toBe(originalMouse);
		expect(ui.requestRender).toBe(originalRender);
		tool.render(120); // reattach after reset
		expect(ui.createMouseEvent).not.toBe(originalMouse);
		activePatch.restore(); activePatch.restore();
		expect(ui.createMouseEvent).toBe(originalMouse);
		expect(ui.requestRender).toBe(originalRender);
		expect(Container.prototype.handleMouse).toBe(originalContainerMouse);
	});
});
