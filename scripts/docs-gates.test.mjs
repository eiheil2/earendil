import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const budgetsGate = fileURLToPath(new URL("./verify-doc-budgets.mjs", import.meta.url));
const bilingualGate = fileURLToPath(new URL("./verify-doc-bilingual.mjs", import.meta.url));

const ENGLISH = [
	"# Guide",
	"",
	"English | [中文](guide.zh.md)",
	"",
	"Pi runs in a terminal.",
	"",
	"## Setup",
	"",
	"Install it:",
	"",
	"```bash",
	"npm install -g pi",
	"```",
	"",
	"See [Providers](providers.md).",
	"",
].join("\n");

const CHINESE = [
	"# 指南",
	"",
	"[English](guide.md) | 中文",
	"",
	"Pi 运行在终端里。",
	"",
	"## 安装",
	"",
	"安装方式：",
	"",
	"```bash",
	"npm install -g pi",
	"```",
	"",
	"见 [Providers](providers.zh.md)。",
	"",
].join("\n");

async function fixture(t, { docs = {}, manifests = {} } = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-doc-gate-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const files = {
		"scripts/doc-budgets.manifest.json": JSON.stringify({
			defaultWordCeiling: 3200,
			defaultByteCeiling: 32768,
			overrides: {},
		}),
		"scripts/doc-bilingual.manifest.json": JSON.stringify({ pairs: [] }),
		...manifests,
	};
	for (const [path, contents] of Object.entries(files)) {
		await mkdir(join(root, path, ".."), { recursive: true });
		await writeFile(join(root, path), contents);
	}
	for (const [path, contents] of Object.entries(docs)) {
		await mkdir(join(root, path, ".."), { recursive: true });
		await writeFile(join(root, path), contents);
	}
	return root;
}

const run = (script, root, args = []) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });

function pairedDocs(extra = {}) {
	return {
		"packages/coding-agent/docs/guide.md": ENGLISH,
		"packages/coding-agent/docs/guide.zh.md": CHINESE,
		"packages/coding-agent/docs/providers.md": "# Providers\n\nEnglish | [中文](providers.zh.md)\n",
		"packages/coding-agent/docs/providers.zh.md": "# 提供商\n\n[English](providers.md) | 中文\n",
		...extra,
	};
}

const pairManifest = {
	"scripts/doc-bilingual.manifest.json": JSON.stringify({
		pairs: ["packages/coding-agent/docs/guide.md", "packages/coding-agent/docs/providers.md"],
	}),
};

test("accepts a corpus inside both ceilings", async (t) => {
	const root = await fixture(t, { docs: { "packages/coding-agent/docs/guide.md": ENGLISH } });
	const result = run(budgetsGate, root);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /1 pages within ceiling/);
});

test("rejects a page over the word ceiling and over the byte ceiling", async (t) => {
	const root = await fixture(t, {
		docs: { "packages/coding-agent/docs/guide.md": ENGLISH },
		manifests: { "scripts/doc-budgets.manifest.json": JSON.stringify({ defaultWordCeiling: 10, defaultByteCeiling: 32768 }) },
	});
	assert.match(run(budgetsGate, root).stderr, /exceeds the 10-word ceiling/);

	const byteRoot = await fixture(t, {
		docs: { "packages/coding-agent/docs/guide.md": ENGLISH },
		manifests: { "scripts/doc-budgets.manifest.json": JSON.stringify({ defaultWordCeiling: 3200, defaultByteCeiling: 20 }) },
	});
	assert.match(run(budgetsGate, byteRoot).stderr, /exceeds the 20-byte ceiling/);
});

test("rejects a non-positive ceiling instead of silently skipping the page", async (t) => {
	const root = await fixture(t, {
		docs: { "packages/coding-agent/docs/guide.md": ENGLISH },
		manifests: { "scripts/doc-budgets.manifest.json": JSON.stringify({ defaultWordCeiling: 0, defaultByteCeiling: 32768 }) },
	});
	const result = run(budgetsGate, root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /defaultWordCeiling must be a positive integer/);
});

test("--list reports usage without failing", async (t) => {
	const root = await fixture(t, {
		docs: { "packages/coding-agent/docs/guide.md": ENGLISH },
		manifests: { "scripts/doc-budgets.manifest.json": JSON.stringify({ defaultWordCeiling: 10, defaultByteCeiling: 32768 }) },
	});
	const result = run(budgetsGate, root, ["--list"]);
	assert.equal(result.status, 0);
	assert.match(result.stdout, /OVER/);
});

test("accepts a recorded pair and rejects one language drifting ahead", async (t) => {
	const root = await fixture(t, { docs: pairedDocs(), manifests: pairManifest });
	const recorded = run(bilingualGate, root, ["--write", "--all"]);
	assert.equal(recorded.status, 0, recorded.stderr);
	assert.match(await readFile(join(root, "packages/coding-agent/docs/guide.i18n.yaml"), "utf8"), /^\/guide:/m);

	const green = run(bilingualGate, root);
	assert.equal(green.status, 0, green.stderr);
	assert.match(green.stdout, /2 declared pair\(s\) complete and consistent/);

	await writeFile(
		join(root, "packages/coding-agent/docs/guide.zh.md"),
		CHINESE.replace("Pi 运行在终端里。", "Pi 运行在终端中，可以读写本机文件。"),
	);
	const drifted = run(bilingualGate, root);
	assert.equal(drifted.status, 1);
	assert.match(drifted.stderr, /guide\.md: record is out of sync/);
});

test("rejects an incomplete pair", async (t) => {
	const docs = pairedDocs();
	delete docs["packages/coding-agent/docs/providers.zh.md"];
	const root = await fixture(t, { docs, manifests: pairManifest });
	const result = run(bilingualGate, root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /chinese file is missing: packages\/coding-agent\/docs\/providers\.zh\.md/);

	const write = run(bilingualGate, root, ["--write", "--all"]);
	assert.equal(write.status, 1);
	assert.match(write.stderr, /cannot record, missing chinese file/);
});

test("rejects structural drift between the two languages", async (t) => {
	const root = await fixture(t, {
		docs: pairedDocs({ "packages/coding-agent/docs/guide.zh.md": CHINESE.replace("见 [Providers](providers.zh.md)。\n", "") }),
		manifests: pairManifest,
	});
	const result = run(bilingualGate, root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /structural signatures diverge/);
});

test("rejects a translated code block that is not byte-identical", async (t) => {
	const root = await fixture(t, {
		docs: pairedDocs({ "packages/coding-agent/docs/guide.zh.md": CHINESE.replace("npm install -g pi", "npm i -g pi") }),
		manifests: pairManifest,
	});
	assert.match(run(bilingualGate, root).stderr, /structural signatures diverge at entry \d+: fence-body:/);
});

test("rejects a pair that drops the language switcher", async (t) => {
	const root = await fixture(t, {
		docs: pairedDocs({ "packages/coding-agent/docs/guide.zh.md": CHINESE.replace("[English](guide.md) | 中文\n", "") }),
		manifests: pairManifest,
	});
	assert.match(run(bilingualGate, root).stderr, /Chinese page has no language switcher/);
});

test("rejects a link into a paired page that uses the wrong locale", async (t) => {
	const root = await fixture(t, {
		docs: pairedDocs({ "packages/coding-agent/docs/guide.zh.md": CHINESE.replace("providers.zh.md", "providers.md") }),
		manifests: pairManifest,
	});
	assert.match(run(bilingualGate, root).stderr, /Chinese page links to providers\.md, expected providers\.zh\.md/);
});

test("rejects an undeclared translated page", async (t) => {
	const root = await fixture(t, {
		docs: { ...pairedDocs(), "packages/coding-agent/docs/orphan.zh.md": "# 孤儿\n" },
		manifests: pairManifest,
	});
	assert.match(run(bilingualGate, root).stderr, /docs\/orphan\.zh\.md: locale or record file not declared/);
});

test("--list reports pair state without failing", async (t) => {
	const root = await fixture(t, { docs: pairedDocs(), manifests: pairManifest });
	const result = run(bilingualGate, root, ["--list"]);
	assert.equal(result.status, 0);
	assert.match(result.stdout, /PROBLEM .*guide\.md - record file is missing/);
	assert.match(result.stdout, /PROBLEM .*providers\.md/);
});