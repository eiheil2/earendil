// Test script to load plugins and see behavior
import * as fs from "node:fs";
import * as os from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions, loadExtensions } from "./packages/coding-agent/src/core/extensions/loader.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plugin-test-"));
const extensionsDir = path.join(tempDir, "extensions");
fs.mkdirSync(extensionsDir);

// Copy the three plugins to the temp extensions dir
const plugins = [
  { src: path.join(__dirname, "good-plugin"), name: "good-plugin" },
  { src: path.join(__dirname, "bad-plugin-throw"), name: "bad-plugin-throw" },
  { src: path.join(__dirname, "bad-plugin-badmanifest"), name: "bad-plugin-badmanifest" },
];

for (const p of plugins) {
  const dest = path.join(extensionsDir, p.name);
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true });
  fs.cpSync(p.src, dest, { recursive: true });
}

console.log("Extensions directory:", extensionsDir);
console.log("---");

async function testPlugin(pluginName) {
  const extPath = path.join(extensionsDir, pluginName);
  try {
    const result = await discoverAndLoadExtensions([], tempDir, tempDir);
    console.log(`\n${pluginName}:`);
    console.log(`  errors: ${result.errors.length}`);
    console.log(`  extensions: ${result.extensions.length}`);
    if (result.errors.length > 0) {
      result.errors.forEach(e => console.log(`  error: ${e.error}`));
    }
    if (result.extensions.length > 0) {
      const ext = result.extensions[0];
      console.log(`  commands: ${Array.from(ext.commands.keys()).join(", ")}`);
      console.log(`  tools: ${Array.from(ext.tools.keys()).join(", ")}`);
    }
    return result;
  } catch (e) {
    console.log(`\n${pluginName}: THROWN - ${e}`);
    return { errors: [{ path: extPath, error: String(e) }], extensions: [] };
  }
}

await testPlugin("good-plugin");
await testPlugin("bad-plugin-throw");  
await testPlugin("bad-plugin-badmanifest");

// Cleanup
fs.rmSync(tempDir, { recursive: true, force: true });