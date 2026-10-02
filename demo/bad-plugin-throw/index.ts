import { registerCommand } from "@earendil-works/pi-coding-agent";

throw new Error("This plugin deliberately fails during load - bad-plugin-throw");

registerCommand("demo-hello", {
	description: "Should never be reached",
	handler: async () => {
		return { content: [{ type: "text", text: "Should not appear" }] };
	},
});