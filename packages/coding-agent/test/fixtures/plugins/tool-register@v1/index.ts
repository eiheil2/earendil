/**
 * Compatibility fixture: registers one tool with a typebox parameter schema.
 *
 * It exists to pin two things at once. The registration surface - `registerTool` keeps its name, its
 * arity and the required fields of a tool definition - and the `typebox` allowlist entry, because the
 * repository uses both the bare and the `@sinclair/` spelling and the boundary script must keep
 * allowing both.
 *
 * Only the SDK and a declared dependency are imported. `check-plugin-boundary.mjs` fails this file if
 * that ever stops being true, which is what makes the fixture a reference shape rather than a snapshot
 * of whatever the loader happened to tolerate.
 */
import type { ExtensionApi } from "@earendil-works/pi-plugin-sdk";
import { Type } from "typebox";

export default function activate(pi: ExtensionApi): void {
	pi.registerTool({
		name: "fixture_echo",
		label: "Fixture Echo",
		description: "Echoes its input back. Compatibility fixture, not a real tool.",
		parameters: Type.Object({
			text: Type.String({ description: "Text to echo." }),
			times: Type.Optional(Type.Number({ description: "How many times to repeat it." })),
		}),
		async execute(_toolCallId, params) {
			const text = (params as { text: string; times?: number }).text;
			const times = (params as { times?: number }).times ?? 1;
			return {
				content: [{ type: "text" as const, text: text.repeat(times) }],
				details: { times },
			};
		},
	});
}
