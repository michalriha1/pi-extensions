import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Match the installed Pi runtime, not a sibling monorepo checkout.
const piDirectory = process.env.PI_CODING_AGENT_DIR ?? "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const requireFromPi = createRequire(join(piDirectory, "package.json"));
const directory = fileURLToPath(new URL(".", import.meta.url));

export default {
	root: directory,
	test: { environment: "node", testTimeout: 30000, include: ["*.test.ts"] },
	resolve: {
		alias: [
			{ find: /^@earendil-works\/pi-coding-agent$/, replacement: join(directory, "test-coding-agent.ts") },
			{ find: /^pi-test\/(.+)$/, replacement: `${join(piDirectory, "dist")}/$1.js` },
			{ find: /^@earendil-works\/pi-tui$/, replacement: requireFromPi.resolve("@earendil-works/pi-tui") },
			{ find: /^typebox$/, replacement: requireFromPi.resolve("typebox") },
		],
	},
};
