import { fileURLToPath } from "node:url";

function source(relativePath: string): string {
	return fileURLToPath(new URL(relativePath, import.meta.url));
}

export default {
	test: { environment: "node", testTimeout: 30000 },
	resolve: {
		alias: [
			{ find: /^@earendil-works\/pi-coding-agent$/, replacement: source("./test-coding-agent.ts") },
			{ find: /^@earendil-works\/pi-ai$/, replacement: source("../../../packages/ai/src/index.ts") },
			{ find: /^@earendil-works\/pi-ai\/compat$/, replacement: source("../../../packages/ai/src/compat.ts") },
			{ find: /^@earendil-works\/pi-ai\/oauth$/, replacement: source("../../../packages/ai/src/oauth.ts") },
			{
				find: /^@earendil-works\/pi-ai\/providers\/(.+)$/,
				replacement: `${source("../../../packages/ai/src/providers")}/$1.ts`,
			},
			{ find: /^@earendil-works\/pi-agent-core$/, replacement: source("../../../packages/agent/src/index.ts") },
			{ find: /^@earendil-works\/pi-tui$/, replacement: source("../../../packages/tui/src/index.ts") },
		],
	},
};
