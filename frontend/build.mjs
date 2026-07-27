/* Build the view: type-check and strip src/*.ts into dist/, then copy the two static
 * files next to it, so dist/ is the whole thing the backend serves.
 *
 *   npm install && node build.mjs
 *   ../bin/hmi_designer --statics frontend/dist
 *
 * tsc is the only tool and the only dependency: no bundler, no runtime library. */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
mkdirSync(dist, { recursive: true });

const tsc = join(here, "node_modules", "typescript", "bin", "tsc");
execFileSync(process.execPath, [tsc, "--project", join(here, "tsconfig.json")], {
  stdio: "inherit",
});

for (const file of ["index.html", "styles.css"]) copyFileSync(join(here, file), join(dist, file));

console.log("built frontend/dist (main.js + modules, index.html, styles.css)");
