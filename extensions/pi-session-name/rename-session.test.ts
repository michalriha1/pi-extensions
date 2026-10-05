import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import extension from "./index.ts";

vi.mock("@earendil-works/pi-coding-agent", () => ({ CustomEditor: class {} }));

function setup(initialName?: string) {
	let name = initialName;
	const tools: ToolDefinition[] = [];
	const pi = {
		on: vi.fn(),
		registerTool: vi.fn((tool: ToolDefinition) => tools.push(tool)),
		setSessionName: vi.fn((value: string) => { name = value; }),
		getSessionName: vi.fn(() => name),
	};
	extension(pi as unknown as ExtensionAPI);
	const execute = (value: unknown, signal?: AbortSignal) => {
		const tool = tools.find((tool) => tool.name === "rename_session");
		expect(tool).toBeDefined();
		return tool!.execute("call", { name: value }, signal, undefined, {} as ExtensionContext);
	};
	return { pi, tools, execute };
}

describe("rename_session", () => {
	test("registers without assigning a default name", () => {
		const { pi, tools } = setup();
		expect(tools.map((tool) => tool.name)).toEqual(["rename_session"]);
		expect(pi.setSessionName).not.toHaveBeenCalled();
	});

	test("trims, sets and verifies the name through Pi", async () => {
		const { pi, execute } = setup("old name");
		const result = await execute("  Workday 2026-09-15  ");
		expect(pi.setSessionName).toHaveBeenCalledExactlyOnceWith("Workday 2026-09-15");
		expect(pi.getSessionName).toHaveBeenCalledOnce();
		expect(result.details).toEqual({ success: true, name: "Workday 2026-09-15" });
		expect(result.content).toEqual([{ type: "text", text: 'Session renamed to "Workday 2026-09-15".' }]);
	});

	test.each(["", "   ", "\t\n", "x".repeat(201), "bad\nname", "bad\u001bname", "bad\u007fname", "bad\u0085name", "bad\u2028name", 12, null, undefined])("rejects invalid input %j before mutation", async (value) => {
		const { pi, execute } = setup();
		await expect(execute(value)).rejects.toThrow(/name/i);
		expect(pi.setSessionName).not.toHaveBeenCalled();
	});

	test.each(["分析 🚀", "x".repeat(200)])("preserves valid names %s", async (name) => {
		const { execute } = setup();
		expect((await execute(name)).details).toEqual({ success: true, name });
	});

	test("does not report success when verification fails", async () => {
		const { pi, execute } = setup();
		pi.getSessionName.mockReturnValue("different");
		await expect(execute("requested")).rejects.toThrow(/verif/i);
	});

	test("propagates API failure", async () => {
		const { pi, execute } = setup();
		pi.setSessionName.mockImplementation(() => { throw new Error("Session unavailable"); });
		await expect(execute("requested")).rejects.toThrow("Session unavailable");
		expect(pi.getSessionName).not.toHaveBeenCalled();
	});

	test("does not mutate after cancellation", async () => {
		const { pi, execute } = setup();
		const controller = new AbortController();
		controller.abort();
		await expect(execute("requested", controller.signal)).rejects.toThrow();
		expect(pi.setSessionName).not.toHaveBeenCalled();
	});
});
