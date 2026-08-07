/* Build the view: type-check and strip src/*.ts into dist/, put styles/*.css beside it, and
 * write index.html with a <link> per stylesheet, so dist/ is the whole thing the backend
 * serves.
 *
 *   npm install && node build.mjs            # one <link> per file — devtools name the file
 *   npm install && node build.mjs --release  # one concatenated styles.css, one request
 *
 * The split build is the default because it is the debuggable one: a rule you are looking at
 * in devtools reports the styles/*.css it actually came from, and the line number is the line
 * number in that file. --release trades that away for a single request.
 *
 * tsc is the only tool and the only dependency: no bundler, no runtime library. */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const release = process.argv.includes("--release");

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
  "stage",
  "sections",
  "cards",
  "findings",
  "chips",
  "steps",
  "highlight",
  "fields",
  "value-box",
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

/* Either shape keeps THE ORDER above: concatenated, it is the order of the parts in the one
 * file; split, it is the order of the <link> tags, which is the order the browser cascades
 * them in regardless of the order they finish loading. */
const links = [];
if (release) {
  rmSync(join(dist, "styles"), { recursive: true, force: true });
  const css = STYLES.map((name) => {
    const path = join(here, "styles", name + ".css");
    return "/* ===== styles/" + name + ".css ===== */\n" + readFileSync(path, "utf8").trimEnd();
  }).join("\n\n");
  writeFileSync(join(dist, "styles.css"), css + "\n");
  links.push(`<link rel="stylesheet" href="styles.css" />`);
} else {
  rmSync(join(dist, "styles.css"), { force: true });
  mkdirSync(join(dist, "styles"), { recursive: true });
  for (const name of STYLES) {
    writeFileSync(
      join(dist, "styles", name + ".css"),
      readFileSync(join(here, "styles", name + ".css"), "utf8"),
    );
    links.push(`<link rel="stylesheet" href="styles/${name}.css" />`);
  }
}

/* index.html is a template with exactly one line to fill in; refuse to guess if it moved */
const MARKER = "<!--STYLES-->";
const html = readFileSync(join(here, "index.html"), "utf8");
const marked = html.split("\n").filter((line) => line.trim() === MARKER);
if (marked.length !== 1) {
  throw new Error(`index.html must contain exactly one ${MARKER} line, found ${marked.length}`);
}
const indent = marked[0].slice(0, marked[0].indexOf("<"));
writeFileSync(
  join(dist, "index.html"),
  html.replace(marked[0], indent + links.join("\n" + indent)),
);

console.log(
  release
    ? `built frontend/dist --release (main.js + modules, index.html, styles.css from ${STYLES.length} parts)`
    : `built frontend/dist (main.js + modules, index.html, ${STYLES.length} separate styles/*.css)`,
);
