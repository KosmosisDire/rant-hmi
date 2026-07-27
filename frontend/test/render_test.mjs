/* Headless check of the view's pure half: it starts the real backend, joins over the
 * real protocol, and drives the document mirror, the attribute interpreter and the
 * template renderer (all DOM-free: the renderer returns SVG text). What it cannot cover
 * is pixels and gestures; that is what a browser is for.
 *
 *   node test/render_test.mjs        (after `node build.mjs` and a backend build) */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rmSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
const exe = join(here, "..", "..", "bin", "hmi_designer" + (process.platform === "win32" ? ".exe" : ""));
const PORT = 7593;
const DOC = join(here, "render_test.tmp.json");

const mod = (name) => pathToFileURL(join(dist, name)).href;
const { DocStore } = await import(mod("doc.js"));
const { renderArtboard } = await import(mod("canvas.js"));
const { run } = await import(mod("program.js"));

let failures = 0;
let checks = 0;
function check(ok, what) {
  checks++;
  if (!ok) {
    failures++;
    console.log("FAIL " + what);
  }
}
function has(svg, needle, what) {
  check(svg.includes(needle), what + " (looking for " + JSON.stringify(needle) + ")");
}

rmSync(DOC, { force: true });
const backend = spawn(exe, ["--port", String(PORT), "--doc", DOC], { stdio: "ignore" });
process.on("exit", () => backend.kill());

async function connect() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/sync");
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
      });
      return ws;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("backend did not come up");
}

const ws = await connect();
const inbox = [];
const waiters = [];
ws.onmessage = (ev) => {
  const frame = JSON.parse(ev.data);
  inbox.push(frame);
  for (const waiter of waiters.splice(0)) waiter();
};
function next(type, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const look = () => {
      const at = inbox.findIndex((f) => f.type === type);
      if (at >= 0) return resolve(inbox.splice(at, 1)[0]);
      if (Date.now() > deadline) return reject(new Error("no " + type + " frame"));
      waiters.push(look);
      setTimeout(look, 50);
    };
    look();
  });
}

ws.send(JSON.stringify({ type: "hello", proto: 1, client_name: "render_test" }));
const snapshot = await next("snapshot");
check(snapshot.doc.pages.length === 1, "one page in the snapshot");
check(snapshot.registry.types.length === 8, "eight widget types");

const store = new DocStore();
store.load(snapshot.doc);
const view = { mode: "edit", selection: [], hover: 0, scale: 1, ghost: null, state: {} };
const page = store.pages()[0];
let svg = renderArtboard(store.doc, page, snapshot.registry, snapshot.live, view);

has(svg, 'class="island"', "the fused island surface");
has(svg, 'class="grid"', "the edit-mode grid");
has(svg, "Line 1 Overview", "the label's text part");
check((svg.match(/<g class="widget/g) ?? []).length === 7, "seven widget groups");

/* the toggle is on, so PICK resolved its fill to the on colour */
has(svg, "#4e8ef7", "the toggle's on colour from a PICK program");
/* the slider's bar is 62% of its track: norm() and CLAMP01 ran over three slots. Scope the
   search to the slider's own group: the accent colour is on several widgets. */
const groupOf = (id) => {
  const at = svg.indexOf('data-id="' + id + '"');
  return at < 0 ? "" : svg.slice(at, svg.indexOf("</g>", at));
};
const slider = page.widgets.find((w) => w.type === "Slider");
const sliderSvg = groupOf(slider.id);
const width = (color) => {
  const found = sliderSvg.match(new RegExp('<rect [^>]*width="([0-9.]+)"[^>]*fill="' + color + '"'));
  return found ? Number(found[1]) : 0;
};
const fraction = width("#4e8ef7") / (width("#242424") || 1);
check(Math.abs(fraction - 0.62) < 0.01, "the slider bar is 62 percent of its track, got " + fraction);
/* the readout's value slot has a feed and no live value: UNKNOWN, never a number */
has(svg, "--", "the fed readout renders UNKNOWN");
check(!svg.includes("42.5"), "a fed slot never shows its authored value");

/* an edit round trip: insert an unfed Readout and watch TO_FIXED format it */
ws.send(
  JSON.stringify({
    type: "apply_ops",
    base_version: snapshot.version,
    ops: [
      {
        op: "insert",
        parent: page.id,
        list: "widgets",
        node: {
          type: "Readout",
          label: "Unfed",
          geom: { x: 1200, y: 60, w: 180, h: 120 },
          slots: { value: 12.345, decimals: 1, units: "bar" },
        },
      },
    ],
  }),
);
const applied = await next("ops_applied");
check(applied.version === snapshot.version + 1, "the version advanced by one");
store.apply(applied.version, applied.ops);
check(store.pages()[0].widgets.length === 8, "the insert reached the mirror");

svg = renderArtboard(store.doc, store.pages()[0], snapshot.registry, snapshot.live, view);
has(svg, ">12.3<", "TO_FIXED formatted an unfed value");
has(svg, ">bar<", "the units part rendered");

/* a text slot that is empty hides its part through the `show` attribute */
const unfed = store.pages()[0].widgets[7];
ws.send(
  JSON.stringify({
    type: "apply_ops",
    base_version: store.version(),
    ops: [{ op: "set_prop", node: unfed.id, key: "slots", value: { value: 12.345, decimals: 0 } }],
  }),
);
const second = await next("ops_applied");
store.apply(second.version, second.ops);
svg = renderArtboard(store.doc, store.pages()[0], snapshot.registry, snapshot.live, view);
has(svg, ">12<", "decimals 0 rounded the value");
check(!svg.includes(">bar<"), "an empty units slot sheds its part");

/* the interpreter's own rules: Nil poisons, division by zero is Nil, not a trap */
check(run({ code: [{ op: "CONST", v: null }, { op: "CONST", v: 2 }, { op: "MUL" }] }, () => null) === null,
      "Nil poisons arithmetic");
check(run({ code: [{ op: "CONST", v: 1 }, { op: "CONST", v: 0 }, { op: "DIV" }] }, () => null) === null,
      "division by zero is Nil");
check(run({ code: [{ op: "LOAD", cell: "slot:x" }] }, () => 5) === 5, "LOAD reads a cell");
check(run({ code: [{ op: "WAT" }] }, () => null) === null, "an unknown opcode is UNKNOWN");

ws.close();
backend.kill();
rmSync(DOC, { force: true });
console.log(`render_test: ${checks} checks, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
