/* Build the view: type-check and strip src/*.ts into dist/, concatenate styles/*.css into
 * one stylesheet beside it, and copy index.html, so dist/ is the whole thing the backend
 * serves.
 *
 *   npm install && node build.mjs
 *   ../bin/hmi_designer --statics frontend/dist
 *
 * tsc is the only tool and the only dependency: no bundler, no runtime library. */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
mkdirSync(dist, { recursive: true });

const tsc = join(here, "node_modules", "typescript", "bin", "tsc");
execFileSync(process.execPath, [tsc, "--project", join(here, "tsconfig.json")], {
  stdio: "inherit",
});

/* THE ORDER IS THE POINT, which is why it is written out here rather than globbed.
 *
 * CSS resolves ties by source order, so a rule further down beats an equally specific one
 * above it — and two of these files depend on exactly that:
 *
 *   - `base` first: it defines the custom properties every other file reads.
 *   - `input-floor` SECOND, and never later. It denies every native gesture on every
 *     surface, then whitelists by [data-input]. Component rules below it deliberately win
 *     at equal specificity; move it down the list and it starts overriding them instead,
 *     silently switching selection and scrolling back off wherever a component turned
 *     them on.
 *
 * The rest are independent and grouped by the surface they dress; they are listed in
 * roughly the order the eye meets them (frame, then workspaces, then the parts that fill
 * a sidebar, then the overlays that open on top). */
const STYLES = [
  "base",
  "input-floor",
  "topbar",
  "workspace",
  "workspace-style",
  "workspace-design",
  "workspace-data",
  "shell",
  "sections",
  "cards",
  "findings",
  "chips",
  "steps",
  "highlight",
  "fields",
  "layers",
  "components",
  "inspector",
  "inspector-component",
  "menu",
  "banner",
  "colorpicker",
  "theme-tokens",
  "align-grid",
  "bound-slots",
  "source-tree",
];

/* a file on disk that nobody listed is a file that silently never ships, so say so */
const present = readdirSync(join(here, "styles")).filter((f) => f.endsWith(".css"));
const listed = new Set(STYLES.map((n) => n + ".css"));
const stray = present.filter((f) => !listed.has(f));
if (stray.length) throw new Error("styles/ has unlisted files: " + stray.join(", "));

const css = STYLES.map((name) => {
  const path = join(here, "styles", name + ".css");
  return "/* ===== styles/" + name + ".css ===== */\n" + readFileSync(path, "utf8").trimEnd();
}).join("\n\n");
writeFileSync(join(dist, "styles.css"), css + "\n");

copyFileSync(join(here, "index.html"), join(dist, "index.html"));

console.log(
  `built frontend/dist (main.js + modules, index.html, styles.css from ${STYLES.length} parts)`,
);
