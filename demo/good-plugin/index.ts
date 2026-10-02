import { registerCommand } from "@earendil-works/pi-coding-agent";

registerCommand("demo-hello", {
	description: "A harmless demo command from a good plugin",
	handler: async () => {
		return { content: [{ type: "text", text: "Hello from demo plugin!" }] };
	},
});