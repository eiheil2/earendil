import { describe, expect, it } from "vitest";
import { EXTENSION_CAPABILITIES, isExtensionCapability } from "../src/capabilities.ts";
import { LEGACY_API_VERSION, PLUGIN_API_VERSION, SUPPORTED_API_VERSIONS } from "../src/version.ts";

describe("contract version", () => {
	it("is a single integer major, independent from the transport protocol version", () => {
		expect(PLUGIN_API_VERSION).toBe(1);
		expect(Number.isInteger(PLUGIN_API_VERSION)).toBe(true);
	});

	it("accepts the legacy tier and the current version", () => {
		expect(SUPPORTED_API_VERSIONS).toEqual([LEGACY_API_VERSION, String(PLUGIN_API_VERSION)]);
		expect(SUPPORTED_API_VERSIONS).toEqual(["0", "1"]);
	});

	it("does not accept a version from the future or a malformed one", () => {
		expect(SUPPORTED_API_VERSIONS).not.toContain("2");
		expect(SUPPORTED_API_VERSIONS).not.toContain("1.0.0");
		expect(SUPPORTED_API_VERSIONS).not.toContain("");
	});
});

describe("capabilities", () => {
	it("is a closed enumeration taken from the host registration surface", () => {
		expect(EXTENSION_CAPABILITIES).toEqual([
			"event.subscribe",
			"tool.register",
			"command.register",
			"shortcut.register",
			"flag.register",
			"provider.register",
			"mcp.register",
			"virtualModel.register",
			"eventbus.publish",
		]);
	});

	it("does not claim ui capabilities, which cannot be observed at load time", () => {
		expect(EXTENSION_CAPABILITIES.some((capability) => capability.startsWith("ui."))).toBe(false);
	});

	it("recognizes its own values and nothing else", () => {
		for (const capability of EXTENSION_CAPABILITIES) {
			expect(isExtensionCapability(capability)).toBe(true);
		}
		expect(isExtensionCapability("experimental.ui.widget")).toBe(false);
		expect(isExtensionCapability("tool.register.extra")).toBe(false);
	});
});
