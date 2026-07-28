/* Headless check of the view's pure half: it starts the real backend, joins over the
 * real protocol, and drives the document mirror, the attribute interpreter, the template
 * renderer (DOM-free: it returns SVG text) and the rail reconciler, which gets a DOM small
 * enough to run in-process (dom_shim.mjs). What none of it covers is pixels and gestures;
 * that is what a browser is for.
 *
 *   node test/render_test.mjs        (after `node build.mjs` and a backend build) */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rmSync } from "node:fs";
import { Element, fire, installDom, typeInto } from "./dom_shim.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
const exe = join(here, "..", "..", "bin", "hmi_designer" + (process.platform === "win32" ? ".exe" : ""));
const PORT = 7593;
const DOC = join(here, "render_test.tmp.json");

installDom();

const mod = (name) => pathToFileURL(join(dist, name)).href;
const { DocStore } = await import(mod("doc.js"));
const { renderContent } = await import(mod("canvas.js"));
const { run } = await import(mod("program.js"));
const { unionPath } = await import(mod("islands.js"));
const { syncUrl } = await import(mod("endpoint.js"));
const { Panel } = await import(mod("reconcile.js"));
const { inspectorShape, renderInspector } = await import(mod("inspector/panel.js"));

let failures = 0;
let checks = 0;
function check(ok, what) {
  checks++;
  if (!ok) {
    failures++;
    console.log("FAIL " + what);
  }
}

check(
  syncUrl({
    protocol: "http:",
    hostname: "localhost",
    port: "7500",
    host: "localhost:7500",
  }) === "ws://127.0.0.1:7500/sync",
  "localhost sync uses the IPv4 listener",
);
check(
  syncUrl({
    protocol: "https:",
    hostname: "hmi.example",
    port: "",
    host: "hmi.example",
  }) === "wss://hmi.example/sync",
  "remote sync keeps the page origin",
);

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
const interactionOf = (node) =>
  node?.interact ?? (node?.children ?? []).map(interactionOf).find(Boolean) ?? null;
check(
  interactionOf(snapshot.registry.types.find((type) => type.name === "Slider")?.template)?.primitive ===
    "drag1d",
  "the slider exposes the generic drag primitive",
);

const store = new DocStore();
store.load(snapshot.doc);
const view = { mode: "edit", selection: [], hover: 0, scale: 1, ghost: null, state: {}, faults: {} };
const page = store.pages()[0];
let svg = renderContent(store.doc, page, snapshot.registry, snapshot.live, view);

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
/* the local feed is now evaluated by the scheduler before this view joins */
has(svg, ">0.0<", "the fed readout renders the runtime value");
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

svg = renderContent(store.doc, store.pages()[0], snapshot.registry, snapshot.live, view);
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
svg = renderContent(store.doc, store.pages()[0], snapshot.registry, snapshot.live, view);
has(svg, ">12<", "decimals 0 rounded the value");
check(!svg.includes(">bar<"), "an empty units slot sheds its part");

/* ---- inspector reconciliation ----
   The rails are generated from the document, so the question every echo asks is what it
   does to the DOM. An ordinary value must land in the control already standing there:
   same node, new value, no rebuild, and therefore nothing to put back afterwards. A
   structural edit may rebuild, and must then find the user again by document address
   rather than by position in the tree. */

const rail = new Element("aside");
rail.className = "rail right";
const panel = new Panel(rail);
const readout = store.pages()[0].widgets[7];
const editor = {
  store,
  registry: snapshot.registry,
  live: { epoch: 1, values: {} },
  view,
  page: () => store.pages()[0],
  selectedWidget: () => store.widget(readout.id),
  apply: () => undefined,
  setPage: () => undefined,
  select: () => undefined,
  refresh: () => undefined,
  diagFor: () => [],
  diagAt: () => [],
};
const draw = () => panel.render(inspectorShape(editor), (host) => renderInspector(host, editor));
/* a version arriving from another window, applied to the mirror exactly as onOps does */
const echo = (ops) => {
  store.apply(store.version() + 1, ops);
  draw();
};
const geomField = (at) => rail.querySelector(".geom-grid").children[at];
const slotControl = (name) => {
  for (const grid of rail.querySelectorAll(".prop-grid")) {
    const kids = grid.children;
    for (let i = 0; i + 1 < kids.length; i++)
      if (kids[i].tagName === "LABEL" && kids[i].textContent === name) return kids[i + 1];
  }
  return null;
};

draw();
check(rail.querySelectorAll("input").length > 0, "the inspector built controls");

/* 1. a value echo moves the value and nothing else */
const shapeBefore = inspectorShape(editor);
const widthField = geomField(5);
rail.scrollTop = 140;
echo([{ op: "set_prop", node: readout.id, key: "geom", value: { ...readout.geom, w: 321 } }]);
check(inspectorShape(editor) === shapeBefore, "a value echo does not move the inspector's shape");
check(geomField(5) === widthField, "a value echo keeps the very same input node");
check(widthField.value === "321", "a value echo assigns the new value, got " + widthField.value);
check(rail.scrollTop === 140, "a value echo leaves scroll alone, got " + rail.scrollTop);

/* 2. the bug the old focus restore caused: a remote change to the field you are standing
      in was overwritten by the stale local copy, so the inspector looked frozen */
widthField.focus();
echo([{ op: "set_prop", node: readout.id, key: "geom", value: { ...readout.geom, w: 654 } }]);
check(widthField.value === "654", "a remote change reaches a FOCUSED field, got " + widthField.value);
check(document.activeElement === widthField, "and the field keeps focus");

/* 3. An UNFED slot's field edits the document, so it shows the document. The runtime keeps
      its own compiled copy of that slot, and a field that read it back would fight whatever
      the user just typed: this is the "changing a value does nothing" bug. */
const valueInput = slotControl("value").children[0];
const authored = valueInput.value;
editor.live = { epoch: 2, values: { [readout.id + ".value"]: 99.5 } };
draw();
check(slotControl("value").children[0] === valueInput, "a live frame does not rebuild the slot editor");
check(
  valueInput.value === authored,
  "an unfed slot's field ignores the runtime cell, got " + valueInput.value,
);
echo([{ op: "set_prop", node: readout.id, key: "slots", value: { value: 5.5, decimals: 0 } }]);
check(valueInput.value === "5.5", "an unfed slot's field follows the document, got " + valueInput.value);

/* 4. a FED slot has no authored value to show, so it IS the runtime: live drives it, and
      UNKNOWN until something arrives. Widget 10's `value` is fed in the seeded document. */
const fedWidget = store.pages()[0].widgets.find((w) => (w.feeds ?? []).some((f) => f.slot === "value"));
const fedPanel = new Panel(new Element("aside"));
const fedEditor = { ...editor, selectedWidget: () => store.widget(fedWidget.id) };
const drawFed = () =>
  fedPanel.render(inspectorShape(fedEditor), (host) => renderInspector(host, fedEditor));
fedEditor.live = { epoch: 3, values: {} };
drawFed();
const fedCell = (() => {
  for (const grid of fedPanel.host.querySelectorAll(".prop-grid")) {
    const kids = grid.children;
    for (let i = 0; i + 1 < kids.length; i++)
      if (kids[i].tagName === "LABEL" && kids[i].textContent === "value") return kids[i + 1];
  }
  return null;
})();
const fedInput = fedCell.children[0];
check(fedInput.value === "", "a fed slot with nothing delivered reads UNKNOWN, got " + fedInput.value);
check(fedInput.getAttribute("placeholder") === "--", "and says so with the UNKNOWN placeholder");
fedEditor.live = { epoch: 4, values: { [fedWidget.id + ".value"]: 4.25 } };
drawFed();
check(fedCell.children[0] === fedInput, "a live frame does not rebuild a fed slot editor");
check(fedInput.value === "4.25", "a live frame drives a fed slot, got " + fedInput.value);

/* 4. uncommitted text is held under the document address, so a rebuild caused by an edit
      somewhere else gives it back, and focus follows the key rather than the tree position */
const labelField = rail.querySelector(".inspector-head").children[0];
typeInto(labelField, "half typed");
echo([
  {
    op: "insert",
    parent: readout.id,
    list: "locals",
    node: { id: 9001, name: "tmp", type: "f64", init: 0, persist: false },
  },
]);
const rebuiltLabel = rail.querySelector(".inspector-head").children[0];
check(rebuiltLabel !== labelField, "a structural edit does rebuild the inspector");
check(rebuiltLabel.value === "half typed", "uncommitted text survives it, got " + rebuiltLabel.value);
check(document.activeElement === rebuiltLabel, "focus lands on the same control by key");
fire(rebuiltLabel, "change");

/* 5. an insert that puts controls ABOVE the focused one must not redirect focus into a
      different control, which is exactly what a numeric DOM path would do */
const heightField = geomField(7);
heightField.focus();
echo([
  {
    op: "insert",
    parent: readout.id,
    list: "locals",
    node: { id: 9002, name: "tmp2", type: "f64", init: 0, persist: false },
  },
]);
check(geomField(7) !== heightField, "the second insert rebuilt the inspector");
check(document.activeElement === geomField(7), "focus follows the key past inserted controls");
check(
  document.activeElement.getAttribute("type") === "number",
  "and lands on the same kind of control",
);

/* 6. the same batch changes the focused field AND the structure. Restoring the caret must
      not restore the VALUE with it: the field was not dirty, so what the echo carries wins */
const focusedWidth = geomField(5);
focusedWidth.focus();
echo([
  { op: "set_prop", node: readout.id, key: "geom", value: { ...readout.geom, w: 777 } },
  {
    op: "insert",
    parent: readout.id,
    list: "locals",
    node: { id: 9003, name: "tmp3", type: "f64", init: 0, persist: false },
  },
]);
check(geomField(5) !== focusedWidth, "the mixed batch rebuilt the inspector");
check(
  geomField(5).value === "777",
  "a rebuild with focus held still shows the echoed value, got " + geomField(5).value,
);
check(document.activeElement === geomField(5), "and the caret is still in that field");
document.activeElement = null;

/* merging does not depend on the grid: two touching off-grid widgets are ONE island, and
   two separated ones are two (one closed loop per island) */
const loops = (path) => (path.match(/Z/g) ?? []).length;
const offGridA = { x: 103, y: 57, w: 100, h: 60 };
const offGridB = { x: 203, y: 57, w: 100, h: 60 };
const fused = unionPath([offGridA, offGridB], 16);
check(loops(fused) === 1, "two touching off-grid widgets fuse into one island, got " + loops(fused));
check(fused.includes("303.0") && fused.includes("103.0"), "the fused outline spans both widgets");
const apart = unionPath([offGridA, { ...offGridB, x: 260 }], 16);
check(loops(apart) === 2, "two separated widgets stay two islands, got " + loops(apart));

/* the interpreter's own rules: Nil poisons, division by zero is Nil, not a trap */
check(run({ code: [{ op: "CONST", v: null }, { op: "CONST", v: 2 }, { op: "MUL" }] }, () => null) === null,
      "Nil poisons arithmetic");
check(run({ code: [{ op: "CONST", v: 1 }, { op: "CONST", v: 0 }, { op: "DIV" }] }, () => null) === null,
      "division by zero is Nil");
check(run({ code: [{ op: "LOAD", cell: "slot:x" }] }, () => 5) === 5, "LOAD reads a cell");
check(run({ code: [{ op: "CONST", v: -3 }, { op: "ABS" }] }, () => null) === 3,
      "the full scalar interpreter runs ABS");
check(run({ code: [{ op: "CONST", v: 7 }, { op: "CONST", v: 3 }, { op: "MOD" }] }, () => null) === 1,
      "the full scalar interpreter runs MOD");
check(run({ code: [{ op: "WAT" }] }, () => null) === null, "an unknown opcode is UNKNOWN");

/* ---- default behavior and diagnostics ----
   A control has to work the moment it is placed, and the view has to be able to say why
   when it does not. Both are served as data: the type's `behavior` flows, and the compile
   findings the snapshot carries. */

const toggleType = snapshot.registry.types.find((type) => type.name === "Toggle");
check(
  (toggleType.behavior ?? []).length === 1,
  "the Toggle ships one default flow, got " + (toggleType.behavior ?? []).length,
);
check(
  toggleType.behavior[0].do[0].var === "widget.value",
  "and it writes the widget's own slot, not a variable",
);
/* the type-specific part is WHERE x COMES FROM, declared on the event, so the default
   itself is the same one step on every value-owning type */
check(
  toggleType.events.find((e) => e.name === "tap")?.value === "!widget.value",
  "the Toggle's tap declares what it proposes",
);
check(
  toggleType.behavior[0].do[0].a === "x",
  "so its default just takes x, got " + toggleType.behavior[0].do[0].a,
);
check(
  !snapshot.registry.types.find((t) => t.name === "Slider").events.find((e) => e.name === "input")
    ?.value,
  "a slider's drag already carries its own value, so it declares none",
);
check(
  (snapshot.registry.types.find((t) => t.name === "Button").behavior ?? []).length === 0,
  "a Button owns no value, so it ships no default",
);
check(Array.isArray(snapshot.diag?.compile), "the snapshot carries the compile findings");

/* the type's defaults are the control working as expected, so the inspector does not
   list them: the Behavior section holds only what this instance authors */
const toggle = store.pages()[0].widgets.find((w) => w.type === "Toggle");
const togglePanel = new Panel(new Element("aside"));
const toggleEditor = { ...editor, selectedWidget: () => store.widget(toggle.id) };
togglePanel.render(inspectorShape(toggleEditor), (host) => renderInspector(host, toggleEditor));
check(
  togglePanel.host.querySelectorAll(".default-flow").length === 0,
  "the inspector does not list the type's default flow",
);

/* A slot the RUNTIME writes reads live in the inspector too, not just on the artboard.
   The document's value is only where that cell started, so a field showing it would sit
   there saying `false` while the toggle on screen is plainly on. */
const toggleValue = (host) => {
  for (const grid of host.querySelectorAll(".prop-grid")) {
    const kids = grid.children;
    for (let i = 0; i + 1 < kids.length; i++)
      if (kids[i].tagName === "LABEL" && kids[i].textContent === "value") return kids[i + 1];
  }
  return null;
};
const liveToggleEditor = {
  ...toggleEditor,
  /* the document seeds this toggle ON; the runtime has since been toggled OFF */
  live: { epoch: 5, values: { [toggle.id + ".value"]: false } },
};
const livePanel = new Panel(new Element("aside"));
livePanel.render(inspectorShape(liveToggleEditor), (host) =>
  renderInspector(host, liveToggleEditor),
);
const valueCell = toggleValue(livePanel.host);
check(valueCell !== null, "the toggle's value row exists");
check(
  valueCell.className.includes("driven"),
  "a runtime-written slot is marked as such, got " + valueCell?.className,
);
const [offButton, onButton] = valueCell.querySelectorAll("button");
check(
  offButton.className.includes("on") && !onButton.className.includes("on"),
  "and its field follows the live cell, not the document",
);
check(
  store.widget(toggle.id).slots.value === true,
  "while the document still holds the value the runtime started from",
);

/* the Readout above is the other half of the rule, and still holds: nothing writes its
   value, so its field shows the document and typing into it is never fought */

/* a finding lands as a mark on the row it names, not in a list: one addressed to the
   widget itself sits on the head, one narrowed to a slot sits on that slot's label */
const findingRows = [
  { node: toggle.id, grade: "error", code: "widget_type", message: "unknown type" },
  { node: toggle.id, grade: "error", code: "value_shape", message: "slot 'value' is bool", where: "value" },
];
const findingEditor = {
  ...toggleEditor,
  diagFor: () => findingRows,
  diagAt: (node, where) =>
    findingRows.filter((d) => d.node === node && (d.where ?? "") === (where ?? "")),
};
const findingPanel = new Panel(new Element("aside"));
findingPanel.render(inspectorShape(findingEditor), (host) => renderInspector(host, findingEditor));
check(
  findingPanel.host.querySelectorAll(".finding").length === 0,
  "there is no findings list any more",
);
const findingHead = findingPanel.host.querySelector(".inspector-head");
check(
  findingHead !== null && findingHead.querySelectorAll(".diag-dot.error").length === 1,
  "a widget-level error marks the inspector head",
);
const valueLabel = (() => {
  for (const grid of findingPanel.host.querySelectorAll(".prop-grid"))
    for (const kid of grid.children)
      if (kid.tagName === "LABEL" && kid.textContent === "value") return kid;
  return null;
})();
check(
  valueLabel !== null && valueLabel.querySelectorAll(".diag-dot.error").length === 1,
  "a slot-level error marks the slot's own label",
);

/* a finding inside a flow is addressed to the STEP, so it traces to the exact line; a
   collapsed card cannot show that line yet, so its head carries the rollup */
const reset = store.pages()[0].widgets.find((w) => w.label === "Reset");
const stepId = reset.flows[0].do[0].id;
const stepRows = [{ node: stepId, grade: "error", code: "expression", message: "unknown name" }];
const stepEditor = {
  ...editor,
  selectedWidget: () => store.widget(reset.id),
  diagFor: () => stepRows,
  diagAt: (node, where) =>
    stepRows.filter((d) => d.node === node && (d.where ?? "") === (where ?? "")),
};
const stepPanel = new Panel(new Element("aside"));
stepPanel.render(inspectorShape(stepEditor), (host) => renderInspector(host, stepEditor));
const flowHead = stepPanel.host.querySelector(".card-head");
check(
  flowHead !== null && flowHead.querySelectorAll(".diag-dot.error").length === 1,
  "a step-level error rolls up on the collapsed flow card",
);

/* a feed finding is addressed to its row ("src", "path", "xf"); collapsed, the card's
   head carries the rollup the same way a flow's does */
const readoutW = store.pages()[0].widgets.find((w) => w.type === "Readout");
const feedId = readoutW.feeds[0].id;
const feedRows = [
  { node: feedId, grade: "error", code: "feed_source", message: "HMI variable 'flow' is unresolved", where: "src" },
];
const feedEditor = {
  ...editor,
  selectedWidget: () => store.widget(readoutW.id),
  diagFor: () => feedRows,
  diagAt: (node, where) =>
    feedRows.filter((d) => d.node === node && (d.where ?? "") === (where ?? "")),
};
const feedPanel2 = new Panel(new Element("aside"));
feedPanel2.render(inspectorShape(feedEditor), (host) => renderInspector(host, feedEditor));
const feedHead = feedPanel2.host.querySelector(".card-head");
check(
  feedHead !== null && feedHead.querySelectorAll(".diag-dot.error").length === 1,
  "a source-row error rolls up on the collapsed feed card",
);

view.faults = { [toggle.id]: "error" };
svg = renderContent(store.doc, store.pages()[0], snapshot.registry, snapshot.live, view);
has(svg, 'class="fault error"', "the widget is marked on the canvas");
view.faults = {};
svg = renderContent(store.doc, store.pages()[0], snapshot.registry, snapshot.live, view);
check(!svg.includes('class="fault'), "and unmarked when the finding clears");

ws.close();
backend.kill();
if (backend.exitCode === null)
  await new Promise((resolve) => {
    backend.once("exit", resolve);
    setTimeout(resolve, 1000);
  });
rmSync(DOC, { force: true });
console.log(`render_test: ${checks} checks, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
