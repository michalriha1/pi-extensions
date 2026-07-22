import { fileURLToPath } from "node:url";

function source(relativePath: string): string {
	return fileURLToPath(new URL(relativePath, import.meta.url));
}

export default {
	test: {
		environment: "node",
		include: [".pi/extensions/session-name-editor/**/*.test.ts"],
	},
	resolve: {
		alias: [{ find: /^@earendil-works\/pi-tui$/, replacement: source("../../../packages/tui/src/index.ts") }],
	},
};
