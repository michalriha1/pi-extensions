import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const MINIMUM_BORDER_PREFIX = 4;
const RIGHT_BORDER_MARGIN = 2;

function sanitizeSessionName(name: string): string {
	return [...name]
		.filter((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code > 31 && (code < 127 || code > 159);
		})
		.join("")
		.trim();
}

export function addSessionNameToTopBorder(
	lines: string[],
	width: number,
	sessionName: string | undefined,
	styleLabel: (label: string) => string,
	styleBorder: (border: string) => string,
): string[] {
	if (lines.length === 0 || width <= 0 || !sessionName) return lines;

	const sanitized = sanitizeSessionName(sessionName);
	const maximumNameWidth = width - MINIMUM_BORDER_PREFIX - RIGHT_BORDER_MARGIN - 2;
	if (!sanitized || maximumNameWidth < 1) return lines;

	const name = truncateToWidth(sanitized, maximumNameWidth, "…");
	const plainLabel = ` ${name} `;
	const labelWidth = visibleWidth(plainLabel);
	const prefixWidth = width - labelWidth - RIGHT_BORDER_MARGIN;
	if (prefixWidth < MINIMUM_BORDER_PREFIX) return lines;

	const originalTopBorder = lines[0] ?? "";
	const prefix = truncateToWidth(originalTopBorder, prefixWidth, "");
	const prefixPadding = "─".repeat(Math.max(0, prefixWidth - visibleWidth(prefix)));
	const suffix = "─".repeat(RIGHT_BORDER_MARGIN);
	const topBorder = `${prefix}${styleBorder(prefixPadding)}${styleLabel(plainLabel)}${styleBorder(suffix)}`;

	return [topBorder, ...lines.slice(1)];
}
