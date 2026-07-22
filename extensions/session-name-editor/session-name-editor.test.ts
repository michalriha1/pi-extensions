import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { addSessionNameToTopBorder } from "./logic.ts";

const styleLabel = (label: string) => `\x1b[44m${label}\x1b[0m`;
const styleBorder = (border: string) => `\x1b[36m${border}\x1b[0m`;

describe("addSessionNameToTopBorder", () => {
	test("places the session name near the right edge of the top border", () => {
		const lines = ["─".repeat(40), "editor", "─".repeat(40)];
		const result = addSessionNameToTopBorder(lines, 40, "advertisers-filter-mr", styleLabel, styleBorder);

		expect(visibleWidth(result[0] ?? "")).toBe(40);
		expect(result[0]).toContain(" advertisers-filter-mr ");
		expect(result[0]?.endsWith("\x1b[36m──\x1b[0m")).toBe(true);
		expect(result.slice(1)).toEqual(lines.slice(1));
	});

	test("truncates long names while preserving the requested width", () => {
		const result = addSessionNameToTopBorder(
			["─".repeat(20)],
			20,
			"a-very-long-session-name",
			styleLabel,
			styleBorder,
		);

		expect(visibleWidth(result[0] ?? "")).toBe(20);
		expect(result[0]).toContain("…");
	});

	test("preserves an existing scroll indicator on the left", () => {
		const topBorder = "─── ↑ 2 more " + "─".repeat(27);
		const result = addSessionNameToTopBorder([topBorder], 40, "session", styleLabel, styleBorder);

		expect(result[0]).toContain("─── ↑ 2 more ");
		expect(visibleWidth(result[0] ?? "")).toBe(40);
	});

	test("leaves the editor unchanged without a usable session name", () => {
		const lines = ["────────", "editor", "────────"];

		expect(addSessionNameToTopBorder(lines, 8, undefined, styleLabel, styleBorder)).toBe(lines);
		expect(addSessionNameToTopBorder(lines, 8, "", styleLabel, styleBorder)).toBe(lines);
		expect(addSessionNameToTopBorder(lines, 6, "name", styleLabel, styleBorder)).toBe(lines);
	});

	test("removes terminal control characters from the label", () => {
		const result = addSessionNameToTopBorder(["─".repeat(30)], 30, "safe\u001bname", styleLabel, styleBorder);

		expect(result[0]).toContain(" safename ");
		expect(result[0]).not.toContain("safe\u001bname");
	});
});
