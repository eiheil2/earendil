import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
	},
	resolve: {
		conditions: ["source"],
		alias: [
			{
				find: /^@earendil-works\/chord$/,
				replacement: fileURLToPath(new URL("../chord/src/index.ts", import.meta.url)),
			},
			{
				find: /^@earendil-works\/chord\/context$/,
				replacement: fileURLToPath(new URL("../chord/src/context/index.ts", import.meta.url)),
			},
			{
				find: /^@earendil-works\/pi-protocol$/,
				replacement: fileURLToPath(new URL("../protocol/src/index.ts", import.meta.url)),
			},
			{
				find: /^@earendil-works\/pi-server$/,
				replacement: fileURLToPath(new URL("../server/src/index.ts", import.meta.url)),
			},
		],
	},
});
