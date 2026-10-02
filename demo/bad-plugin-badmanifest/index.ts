import { registerCommand } from "@earendil-works/pi-coding-agent";

registerCommand("demo-hello", {
	description: "Should never be reached - bad manifest",
	handler: async () => {
		return { content: [{ type: "text", text: "Should not appear" }] };
	},
});