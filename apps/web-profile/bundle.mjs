import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL(".", import.meta.url));
await mkdir(new URL("dist/", import.meta.url), { recursive: true });
await build({
  absWorkingDir: directory,
  entryPoints: ["src/profile.jsx"],
  bundle: true,
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  outfile: "dist/profile.js",
  nodePaths: [fileURLToPath(new URL("node_modules", import.meta.url))],
  alias: {
    "@deepseek-ai/dsh-client-ui-primitives": fileURLToPath(new URL("src/dsh-primitives.js", import.meta.url)),
    "@deepseek-ai/dsh-util-workspace-path": fileURLToPath(new URL("../../vendor/deepseek-web/packages/util/workspace-path/src/index.ts", import.meta.url)),
    "@deepseek-ai/dsh-util-code-language": fileURLToPath(new URL("../../vendor/deepseek-web/packages/util/code-language/src/index.ts", import.meta.url)),
  },
  define: { "process.env.DSH_CLIENT_TITLE": '"Earendil"', "process.env.DSH_CLIENT_VERSION": 'undefined', "process.env.DSH_CLIENT_COMMIT_HASH": 'undefined', "process.env.DSH_CLIENT_GIT_DIRTY": 'undefined', "process.env.NODE_ENV": '"production"' },
  loader: { ".module.css": "local-css", ".woff2": "dataurl", ".woff": "dataurl", ".ttf": "dataurl" },
  tsconfig: "../../tsconfig.json",
  legalComments: "eof",
});
await copyFile(new URL("index.html", import.meta.url), new URL("dist/index.html", import.meta.url));
await copyFile(new URL("../../vendor/deepseek-web/LICENSE", import.meta.url), new URL("dist/LICENSE.deepseek", import.meta.url));
console.log("Web profile bundled into apps/web-profile/dist.");
