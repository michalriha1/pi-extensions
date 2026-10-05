import { createRequire } from "node:module";
import { join } from "node:path";

// Test against the installed Pi API; override for non-Homebrew installations.
const piDirectory = process.env.PI_CODING_AGENT_DIR ?? "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const requireFromPi = createRequire(join(piDirectory, "package.json"));

export default {
	test: {
		environment: "node",
		include: ["extensions/pi-session-name/**/*.test.ts"],
	},
	resolve: {
		alias: [
			{ find: /^@earendil-works\/pi-tui$/, replacement: requireFromPi.resolve("@earendil-works/pi-tui") },
			{ find: /^@earendil-works\/pi-coding-agent$/, replacement: join(piDirectory, "dist/index.js") },
			{ find: /^typebox$/, replacement: requireFromPi.resolve("typebox") },
		],
	},
};
