import { fileURLToPath } from "node:url";

function source(relativePath: string): string {
	return fileURLToPath(new URL(relativePath, import.meta.url));
}

export default {
	test: {
		environment: "node",
		include: ["extensions/pi-session-name/**/*.test.ts"],
	},
	resolve: {
		alias: [{ find: /^@earendil-works\/pi-tui$/, replacement: source("../../../packages/tui/src/index.ts") }],
	},
};
