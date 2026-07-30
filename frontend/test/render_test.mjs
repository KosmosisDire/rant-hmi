/* Headless check of the view's pure half: it starts the real backend, joins over the
 * real protocol, and drives the document mirror, the attribute interpreter, the template
 * renderer (DOM-free: it returns SVG text) and the sidebar reconciler, which gets a DOM small
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
const { parseRich, richMarkup, richUnits } = await import(mod("rich.js"));
const { Panel } = await import(mod("reconcile.js"));
const { inspectorShape, leftShape, renderInspector, renderLeftSidebar } =
  await import(mod("inspector/panel.js"));
const { renderOverlay } = await import(mod("canvas.js"));
const { renderStyleWorkspace, styleShape } = await import(mod("workspaces/style.js"));
const { dataShape, dataSelect, renderDataDetail, renderDataTree } =
  await import(mod("workspaces/data.js"));
const { pageSelectShape, renderPageSelect } = await import(mod("pageselect.js"));

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

/* ---- inline markup (rich.ts), a pure function of the string ---- */
const mutes = (line) => (parseRich(line) ?? []).map((s) => s.mute).join(",");
check(mutes("12.3 _bar_") === "0,1", "an underscore run is the muted secondary scale");
check(mutes("__note__") === "2", "a double underscore is the dimmer step");
check(mutes("_a **b** c_") === "1,1,1", "bold nests inside a muted run");
check(parseRich("feed_name") === null, "an underscore inside a word stays literal");
check(parseRich("motor_1_speed") === null, "so does every underscore of a snake_case path");
check(parseRich("_kg_s") === null, "a closer that would split a word does not close");
check(parseRich("tail_") === null, "an unclosed underscore stays literal");
{
  const mark = richMarkup(parseRich("12.3 _bar_"), 0, 0, 20, "middle", "#fff", 450);
  check(mark.includes(`font-size="12.00" fill-opacity="0.55"`), "the muted run renders smaller and dimmer");
  check(richUnits(parseRich("12.3 _bar_")) < "12.3 bar".length, "and autosizing counts it narrower");
}

function has(svg, needle, what) {
  check(svg.includes(needle), what + " (looking for " + JSON.stringify(needle) + ")");
}

rmSync(DOC, { force: true });
const backend = spawn(exe, ["--port", String(PORT), "--doc", DOC, "--no-mesh"], { stdio: "ignore" });
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
    /* `look` is rearmed from two places (a fresh message, and a fallback poll), and
       must stay armed at most ONCE each way: on a wait slow enough for several "live"
       ticks to land before it settles (the case a registry-changed snapshot adds),
       each tick used to arm a NEW setTimeout on top of whatever was already pending,
       without ever cancelling the old one, so the outstanding pile of timers (and the
       waiters entries they each re-added) grew without bound instead of staying at
       one. Clearing the previous timer before rearming, and never pushing a second
       waiters entry for the same look, keeps exactly one of each in flight. */
    let timer = null;
    const look = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      const at = inbox.findIndex((f) => f.type === type);
      if (at >= 0) return resolve(inbox.splice(at, 1)[0]);
      if (Date.now() > deadline) return reject(new Error("no " + type + " frame"));
      if (waiters.indexOf(look) < 0) waiters.push(look);
      timer = setTimeout(look, 50);
    };
    look();
  });
}

ws.send(JSON.stringify({ type: "hello", proto: 3, client_name: "render_test" }));
const snapshot = await next("snapshot");
check(snapshot.doc.pages.length === 1, "one page in the snapshot");
check(snapshot.registry.types.length === 12, "twelve widget types");
/* the built-ins' editable document form rides beside the derived registry */
check(Array.isArray(snapshot.builtins) && snapshot.builtins.length === 12,
      "the snapshot serves the twelve built-ins' document form");
check(Array.isArray(snapshot.builtins[0]?.parts) && !snapshot.builtins[0]?.template,
      "a served built-in is doc-form: parts with expression text, no compiled template");
const interactionOf = (node) =>
  node?.interact ?? (node?.children ?? []).map(interactionOf).find(Boolean) ?? null;
check(
  interactionOf(snapshot.registry.types.find((type) => type.name === "Slider")?.template)?.primitive ===
    "drag1d",
  "the slider exposes the generic drag primitive",
);

const store = new DocStore();
store.load(snapshot.doc);
const view = { mode: "edit", selection: [], part: "", hover: 0, scale: 1, ghost: null, state: {}, faults: {}, themeMode: "dark" };
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
          /* a part's values nest under the part (spec 2.3) */
          slots: { value: 12.345, reading: { decimals: 1 }, units: { text: "bar" } },
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
    ops: [{ op: "set_prop", node: unfed.id, key: "slots",
            value: { value: 12.345, reading: { decimals: 0 } } }],
  }),
);
const second = await next("ops_applied");
store.apply(second.version, second.ops);
svg = renderContent(store.doc, store.pages()[0], snapshot.registry, snapshot.live, view);
has(svg, ">12<", "decimals 0 rounded the value");
check(!svg.includes(">bar<"), "an empty units slot sheds its part");
/* the REAL backend's version, tracked separately from here on: everything below this
   point simulates most further edits as LOCAL-ONLY echoes (store.apply with no
   ws.send), which is deliberate — it exercises the reconciler without a round trip —
   but it means store.version() drifts far ahead of what the backend actually saw. The
   repeat/path proof near the end of this file needs the real backend to compile a doc
   component, so it sends ops for real and must base them on this, not store.version() */
let backendVersion = second.version;

/* ---- inspector reconciliation ----
   The sidebars are generated from the document, so the question every echo asks is what it
   does to the DOM. An ordinary value must land in the control already standing there:
   same node, new value, no rebuild, and therefore nothing to put back afterwards. A
   structural edit may rebuild, and must then find the user again by document address
   rather than by position in the tree. */

const sidebar = new Element("aside");
sidebar.className = "sidebar right";
const panel = new Panel(sidebar);
const readout = store.pages()[0].widgets[7];
const editor = {
  store,
  registry: snapshot.registry,
  live: { epoch: 1, values: {} },
  mesh: { entities: [], types: [] },
  lang: null,
  builtins: snapshot.builtins ?? [],
  componentSel: null,
  builtinSel: null,
  view,
  page: () => store.pages()[0],
  selectedWidget: () => store.widget(readout.id),
  apply: () => undefined,
  setPage: () => undefined,
  select: () => undefined,
  selectPart: () => undefined,
  selectComponent: () => undefined,
  selectBuiltin: () => undefined,
  forkBuiltin: () => undefined,
  duplicateComponent: () => undefined,
  addComponent: () => undefined,
  addPage: () => undefined,
  reveal: () => undefined,
  setThemeMode: () => undefined,
  refresh: () => undefined,
  diagFor: () => [],
  diagAt: () => [],
  diagNode: () => [],
};
const draw = () => panel.render(inspectorShape(editor), (host) => renderInspector(host, editor));
/* a version arriving from another window, applied to the mirror exactly as onOps does */
const echo = (ops) => {
  store.apply(store.version() + 1, ops);
  draw();
};
const geomField = (at) => sidebar.querySelector(".geom-grid").children[at];
const slotControl = (name) => {
  for (const grid of sidebar.querySelectorAll(".prop-grid")) {
    const kids = grid.children;
    for (let i = 0; i + 1 < kids.length; i++)
      if (kids[i].tagName === "LABEL" && kids[i].textContent === name) return kids[i + 1];
  }
  return null;
};

draw();
check(sidebar.querySelectorAll("input").length > 0, "the inspector built controls");

/* 1. a value echo moves the value and nothing else */
const shapeBefore = inspectorShape(editor);
const widthField = geomField(5);
sidebar.scrollTop = 140;
echo([{ op: "set_prop", node: readout.id, key: "geom", value: { ...readout.geom, w: 321 } }]);
check(inspectorShape(editor) === shapeBefore, "a value echo does not move the inspector's shape");
check(geomField(5) === widthField, "a value echo keeps the very same input node");
check(widthField.value === "321", "a value echo assigns the new value, got " + widthField.value);
check(sidebar.scrollTop === 140, "a value echo leaves scroll alone, got " + sidebar.scrollTop);

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
const labelField = sidebar.querySelector(".inspector-head").children[0];
typeInto(labelField, "half typed");
echo([
  {
    op: "insert",
    parent: readout.id,
    list: "locals",
    node: { id: 9001, name: "tmp", type: "f64", init: 0, persist: false },
  },
]);
const rebuiltLabel = sidebar.querySelector(".inspector-head").children[0];
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
  toggleType.behavior[0].do[0].to?.slot === "value",
  "and it writes the widget's own slot, not a variable",
);
/* the type-specific part is WHERE x COMES FROM, declared on the event, so the default
   itself is the same one step on every value-owning type */
check(
  toggleType.events.find((e) => e.name === "tap")?.value === "!widget.value",
  "the Toggle's tap declares what it proposes",
);
check(
  toggleType.behavior[0].do[0].from?.expr === "x",
  "so its default just takes x, got " + toggleType.behavior[0].do[0].from?.expr,
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
  diagNode: (node) => findingRows.filter((d) => d.node === node),
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
  diagNode: (node) => stepRows.filter((d) => d.node === node),
};
const stepPanel = new Panel(new Element("aside"));
stepPanel.render(inspectorShape(stepEditor), (host) => renderInspector(host, stepEditor));
const flowHead = stepPanel.host.querySelector(".card-head");
check(
  flowHead !== null && flowHead.querySelectorAll(".diag-dot.error").length === 1,
  "a step-level error rolls up on the collapsed flow card",
);

/* a feed is ONE LINE under its slot, and a feed finding marks that line, whichever
   field of the feed the compiler named */
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
  diagNode: (node) => feedRows.filter((d) => d.node === node),
};
const feedPanel2 = new Panel(new Element("aside"));
feedPanel2.render(inspectorShape(feedEditor), (host) => renderInspector(host, feedEditor));
const feedLine = feedPanel2.host.querySelector(".feed-line");
check(
  feedLine !== null && feedLine.querySelectorAll(".diag-dot.error").length === 1,
  "a feed finding marks the feed's one line",
);

view.faults = { [toggle.id]: "error" };
svg = renderContent(store.doc, store.pages()[0], snapshot.registry, snapshot.live, view);
has(svg, 'class="fault error"', "the widget is marked on the canvas");
view.faults = {};
svg = renderContent(store.doc, store.pages()[0], snapshot.registry, snapshot.live, view);
check(!svg.includes('class="fault'), "and unmarked when the finding clears");

/* ---- part identity ----
   Every named template node has a part path (names joined with "." BELOW the template
   root, whose own name adds nothing: the root part IS the widget). A render handed a collector wraps each named node in a data-part group (inside
   any data-act group) and records its laid-out rect per widget; without one the SVG is
   exactly what it always was. */
check(!svg.includes("data-part"), "no collector, no data-part groups");
const partRects = new Map();
svg = renderContent(store.doc, store.pages()[0], snapshot.registry, snapshot.live, view,
                    null, null, partRects);
has(svg, '<g data-act="0"><g data-part="pill">', "a data-part group nests inside its data-act group");
has(svg, '<g data-part="pill.lane.knob">', "the toggle's knob renders as a data-part group");
const toggleParts = partRects.get(toggle.id);
check(toggleParts instanceof Map && toggleParts.has("pill.lane.knob"),
      "part rects are recorded per widget by part path");
{
  const knob = toggleParts.get("pill.lane.knob");
  const g = store.widget(toggle.id).geom;
  check(knob && knob.x >= g.x && knob.y >= g.y &&
        knob.x + knob.w <= g.x + g.w && knob.y + knob.h <= g.y + g.h,
        "a recorded part rect lies inside its widget's tile");
}
/* the slider's scale is hidden (show_scale defaults off), so it records nothing */
check(!partRects.get(slider.id).has("scale"), "a node hidden by `show` records no rect");

/* ---- the Layers tree, part selection and the part-scoped inspector ----
   The left sidebar's tree lists the CURRENT page's widgets and each widget's named
   template parts from the REGISTRY type (all of them, rendered or not); pages live in
   the topbar selector, not here. Selecting a part scopes the inspector to exactly the
   slots the part's subtree consumes, and the overlay rings the part where the last
   render put it. */

const left = new Element("aside");
const leftPanel = new Panel(left);
const drawLeft = () => leftPanel.render(leftShape(editor), (host) => renderLeftSidebar(host, editor));
const rowByKey = (key) =>
  left.querySelectorAll(".layer-row").find((r) => r.getAttribute("data-key") === key) ?? null;

drawLeft();
const toggleRow = rowByKey("w" + toggle.id);
check(toggleRow !== null, "the Layers tree lists the current page's widgets");
check(left.querySelectorAll(".layer-row.page").length === 0, "the Layers tree has no page rows");
check(rowByKey("p" + page.id) === null, "not even the current page's");
/* expanding the widget row (its caret) reveals the type's whole part tree */
fire(toggleRow.children[0], "click");
drawLeft();
check(rowByKey("w" + toggle.id + "/pill.lane.knob") !== null,
      "an expanded widget lists its template parts by path");
fire(rowByKey("w" + slider.id).children[0], "click");
drawLeft();
check(rowByKey("w" + slider.id + "/scale") !== null,
      "a part hidden by `show` is still listed: the tree reads the type, not the render");

/* a selected part scopes the inspector: widget › part head, ONE section, and only the
   properties that part OWNS — not its siblings', not its children's, not the widget's */
const toggleEditor2 = { ...editor, selectedWidget: () => store.widget(toggle.id) };
view.selection = [toggle.id];
view.part = "pill.lane.knob";
const widgetShape = (() => { view.part = ""; const s = inspectorShape(toggleEditor2); view.part = "pill.lane.knob"; return s; })();
check(inspectorShape(toggleEditor2) !== widgetShape, "the selected part moves the inspector's shape");
const partPanel = new Panel(new Element("aside"));
partPanel.render(inspectorShape(toggleEditor2), (host) => renderInspector(host, toggleEditor2));
const partLabels = [];
for (const grid of partPanel.host.querySelectorAll(".prop-grid"))
  for (const kid of grid.children) if (kid.tagName === "LABEL") partLabels.push(kid.textContent);
check(partLabels.includes("handle_color"),
      "the part view lists the property that part owns");
check(!partLabels.includes("fill_color") && !partLabels.includes("track_color"),
      "and not its siblings' slots, got " + partLabels.join(","));
check(partPanel.host.querySelector(".geom-grid") === null,
      "the part view carries no Panel/placement section");
check(partPanel.host.querySelector(".part-name")?.textContent === "knob",
      "the head names the part");

/* ...and the WIDGET view is the other half of the same rule: a property a part owns is
   editable there and NOWHERE else, so the widget's own inspector holds only its own
   (its value, its frame, its placement) */
view.part = "";
const widgetPanel = new Panel(new Element("aside"));
widgetPanel.render(inspectorShape(toggleEditor2), (host) => renderInspector(host, toggleEditor2));
const widgetLabels = [];
for (const grid of widgetPanel.host.querySelectorAll(".prop-grid"))
  for (const kid of grid.children) if (kid.tagName === "LABEL") widgetLabels.push(kid.textContent);
check(!widgetLabels.includes("handle_color") && !widgetLabels.includes("fill_color"),
      "the widget view shows no property a part owns, got " + widgetLabels.join(","));
check(widgetLabels.includes("surface") && widgetLabels.includes("Place"),
      "and keeps the widget's own frame and placement");
{
  /* EVERY part carries its own `shown` switch, so a part is turned off by selecting it
     — and the edit writes NESTED, under the part that owns it */
  check(partLabels.includes("shown"), "a part can be switched off from its own view");
  const applied = [];
  const nested = { ...toggleEditor2, apply: (ops) => applied.push(...ops) };
  view.part = "pill.lane.knob";
  const editPanel = new Panel(new Element("aside"));
  editPanel.render(inspectorShape(nested), (host) => renderInspector(host, nested));
  const pairs = [...editPanel.host.querySelectorAll(".bool-pair")];
  check(pairs.length === 1, "the knob's own view has exactly one switch");
  fire(pairs[0].children[0], "click");   /* the "off" half */
  const slotOp = applied.find((op) => op.key === "slots");
  check(slotOp && slotOp.value?.pill?.lane?.knob?.shown === false,
        "a part's edit writes nested under its part, got " + JSON.stringify(slotOp?.value));
  check(slotOp && slotOp.value.shown === undefined,
        "and never at the widget's top level");
  view.part = "";
}

/* the overlay rings the selected part at its recorded rect; a hidden part has none */
view.part = "pill";
const ringed = renderOverlay(store.pages()[0], view, partRects);
check(ringed.includes('class="part-ring"'), "the overlay rings the selected part");
view.selection = [slider.id];
view.part = "scale";
check(!renderOverlay(store.pages()[0], view, partRects).includes('class="part-ring"'),
      "a part that did not render gets no ring");
view.selection = [];
view.part = "";

/* ---- the Components section: browse built-ins, edit doc components ----
   Below Layers, the left sidebar lists the document's components (their PART trees,
   real doc nodes) and then the built-ins not shadowed by one, browsable from the
   served doc form and carrying a fork affordance. Selecting a part node scopes the
   inspector to that node's attrs, and a component compile finding (addressed to the
   part node, where = the attr) pins to the attr's own row. */

drawLeft();
const builtinToggleRow = rowByKey("b:Toggle");
check(builtinToggleRow !== null, "the Components section lists unshadowed built-ins");
check(builtinToggleRow.querySelectorAll(".layer-menu").length === 1,
      "a built-in row carries the row-level verb menu (Override <Name>, Duplicate as…)");
check(builtinToggleRow.className.includes("builtin"), "and is marked read-only");
fire(builtinToggleRow.children[0], "click");
drawLeft();
/* a built-in is not in the document, so its rows are addressed by name + CHILD-INDEX
   path ("0" is the root part, "0.0.0" the track inside its pill) rather than node id */
check(rowByKey("b:Toggle/0") !== null,
      "an expanded built-in lists its part tree from the served doc form");
check(rowByKey("b:Toggle/0.0.0") !== null, "nested built-in parts too (boxes default open)");

/* the row SELECTS, exactly as a doc component's does: the shipped definitions are
   browsable read-only, which is how a type is read before it is overridden */
const browsed = [];
editor.selectBuiltin = (name, path) => browsed.push(name + ":" + path);
fire(rowByKey("b:Toggle/0.0.0"), "click");
fire(rowByKey("b:Toggle"), "click");
check(browsed.join(" ") === "Toggle:0.0.0 Toggle:",
      "a built-in row browses it by name and part path, got " + JSON.stringify(browsed));

/* the inspector then shows that part's definition, read-only: no field commits, and
   the ADDRESS row says what its properties are called from the outside (spec 2.3) */
const trackEditor = {
  ...editor,
  selectedWidget: () => null,
  builtinSel: { name: "Toggle", path: "0.0.0" },
};
const trackPanel = new Panel(new Element("aside"));
check(inspectorShape(trackEditor) !== inspectorShape(editor),
      "a browsed built-in owns the inspector's shape");
trackPanel.render(inspectorShape(trackEditor), (host) => renderInspector(host, trackEditor));
check(trackPanel.host.querySelector(".head-tag")?.textContent === "built-in",
      "the head marks it as the built-in definition");
const trackAttrs = trackPanel.host.querySelectorAll(".attr-row");
check(trackAttrs.some((row) =>
        row.querySelectorAll("input").some((i) => i.value === "value.pick(fill_color, track_color)")),
      "the attrs table shows each attr's expression text");
check(trackPanel.host.querySelectorAll("input").every((i) => i.getAttribute("readonly")),
      "every field in it is read-only: nothing in the document owns a built-in");
check(trackPanel.host.querySelectorAll(".value-static")
        .some((v) => v.textContent === "pill.track"),
      "and the ADDRESS row names the part's slot-address prefix");
const bodyEditor = { ...trackEditor, builtinSel: { name: "Toggle", path: "0" } };
const bodyPanel = new Panel(new Element("aside"));
bodyPanel.render(inspectorShape(bodyEditor), (host) => renderInspector(host, bodyEditor));
check(bodyPanel.host.querySelectorAll(".value-static")
        .some((v) => v.textContent === "the widget itself"),
      "the ROOT part adds no segment: its properties address bare");
const toggleEditor3 = { ...trackEditor, builtinSel: { name: "Toggle", path: "" } };
const compPanel = new Panel(new Element("aside"));
compPanel.render(inspectorShape(toggleEditor3), (host) => renderInspector(host, toggleEditor3));
check(compPanel.host.querySelectorAll(".dashed-btn")
        .some((b) => b.textContent === "Override Toggle"),
      "the component view offers the fork that makes it editable");

/* a doc component, injected as an echo would deliver it (ids issued) */
store.apply(store.version() + 1, [
  {
    op: "insert",
    parent: 0,
    list: "components",
    node: {
      id: 9200,
      name: "Lamp",
      events: [{ name: "tap", x: "bool" }],
      props: [
        { id: 9201, name: "tint", shape: "color", default: "#ff0000", group: "appearance" },
      ],
      parts: [
        {
          id: 9210,
          kind: "box",
          name: "body",
          dir: "stack",
          attrs: {},
          interact: null,
          children: [
            { id: 9211, kind: "text", name: "label", attrs: { text: "'hi'" },
              interact: null, children: [] },
          ],
        },
      ],
      behavior: [],
    },
  },
]);
drawLeft();
const lampRow = rowByKey("c9200");
check(lampRow !== null, "a doc component appears in the Components tree");
check(lampRow.querySelector(".badge.shadow") === null,
      "a component that shadows nothing carries no override tag");
fire(lampRow.children[0], "click");
drawLeft();
check(rowByKey("c9200/9210") !== null, "an expanded component lists its part nodes");
check(rowByKey("c9200/9211") !== null, "nested parts too (boxes default open)");

/* selecting the component edits the TYPE: name field and the properties table */
const lampEditor = {
  ...editor,
  selectedWidget: () => null,
  componentSel: { component: 9200, node: 9200 },
};
const lampPanel = new Panel(new Element("aside"));
lampPanel.render(inspectorShape(lampEditor), (host) => renderInspector(host, lampEditor));
check(lampPanel.host.querySelector(".inspector-head").children[0].value === "Lamp",
      "a selected component's head edits its name");
check(
  lampPanel.host.querySelectorAll(".propdef").length === 1 &&
    lampPanel.host.querySelectorAll(".propdef")[0].querySelectorAll("input")
      .some((i) => i.value === "tint"),
  "the properties table lists the PropDef rows",
);

/* selecting a part edits its attrs: the expression text in an editable row */
const labelEditor = { ...lampEditor, componentSel: { component: 9200, node: 9211 } };
const labelPanel = new Panel(new Element("aside"));
check(inspectorShape(labelEditor) !== inspectorShape(lampEditor),
      "the selected part node moves the inspector's shape");
labelPanel.render(inspectorShape(labelEditor), (host) => renderInspector(host, labelEditor));
const attrRows = labelPanel.host.querySelectorAll(".attr-row");
check(attrRows.length === 1, "the part view lists one row per attr");
check(attrRows[0].querySelectorAll("input").some((i) => i.value === "'hi'"),
      "with the attr's expression text editable in place");

/* a component finding is addressed to the part node, where = the attr: it pins to
   that attr's own row, exactly as the backend's template_expr diags arrive */
const attrDiagRows = [
  { node: 9211, grade: "error", code: "template_expr", message: "unknown name 'nope'",
    where: "text" },
];
const attrDiagEditor = {
  ...labelEditor,
  diagFor: () => attrDiagRows,
  diagAt: (node, where) =>
    attrDiagRows.filter((d) => d.node === node && (d.where ?? "") === (where ?? "")),
  diagNode: (node) => attrDiagRows.filter((d) => d.node === node),
};
const attrDiagPanel = new Panel(new Element("aside"));
attrDiagPanel.render(inspectorShape(attrDiagEditor), (host) =>
  renderInspector(host, attrDiagEditor));
const diagAttrRow = attrDiagPanel.host.querySelectorAll(".attr-row")[0];
check(diagAttrRow.querySelectorAll(".diag-dot.error").length === 1,
      "a component finding pins to the attr row the compiler named");

/* the doc component SHADOWS a built-in by name: the built-in row folds away, and the
   row now carries a legible override tag, not just a tooltip (spec 3.1) */
store.apply(store.version() + 1, [
  { op: "set_prop", node: 9200, key: "name", value: "Toggle" },
]);
drawLeft();
check(rowByKey("b:Toggle") === null, "a shadowed built-in leaves the built-ins list");
check(rowByKey("c9200").querySelector(".shadows") !== null,
      "and the doc component is marked as overriding it");
check(rowByKey("c9200").querySelector(".badge.shadow") !== null,
      "the override tag is legible in the row itself, not only the tooltip");

/* "Revert to built-in": removing the component that shadows one restores it (the same
   op the row menu's danger-styled Revert entry issues) */
store.apply(store.version() + 1, [{ op: "remove", node: 9200 }]);
drawLeft();
check(rowByKey("b:Toggle") !== null, "reverting a shadowing component restores the built-in row");

/* "Duplicate as…": copies a built-in under a FRESH name, leaving the source alone —
   simulate the echo the real duplicateComponent(name) insert produces (the fresh-name
   derivation itself, "Knob 2" / "Knob 3", is exercised end to end by the Playwright
   drive against the running app, not this in-process test) */
store.apply(store.version() + 1, [
  {
    op: "insert",
    parent: 0,
    list: "components",
    node: {
      id: 9300,
      name: "Knob 2",
      events: [],
      props: [],
      parts: [{ id: 9301, kind: "box", name: "body", dir: "stack", attrs: {},
                interact: null, children: [] }],
      behavior: [],
    },
  },
]);
drawLeft();
check(rowByKey("b:Knob") !== null, "duplicating a built-in leaves the built-in itself listed");
check(rowByKey("c9300") !== null, "and a second component appears under the fresh name");
check(rowByKey("c9300").querySelector(".badge.shadow") === null,
      "the duplicate shadows nothing (a different name), so it carries no override tag");
store.apply(store.version() + 1, [{ op: "remove", node: 9300 }]);
drawLeft();

/* ---- theme tokens (spec 2.10) ----
   The document carries the seeded semantic set; an authored "$name" color slot resolves
   per this VIEW's theme mode, preferring the document over the live echo (the echo is
   the backend's canonical-dark copy, which would defeat per-view theming); the Style
   workspace lists the tokens as an editable table. */

check(Array.isArray(snapshot.doc.tokens) && snapshot.doc.tokens.length === 12,
      "the default document seeds the semantic token set");
const accentToken = snapshot.doc.tokens.find((t) => t.name === "accent");
check(accentToken?.dark === "#4e8ef7", "accent's dark value is the reference palette");
check(typeof accentToken?.light === "string" && accentToken.light.startsWith("#"),
      "and it carries a light counterpart");

/* the Fault lamp is a Panel whose surface we author to a token; its live echo still
   holds the OLD compiled literal, which must not win over the document */
const faultPanel = store.pages()[0].widgets.find((w) => w.label === "Fault");
store.apply(store.version() + 1, [
  { op: "set_prop", node: faultPanel.id, key: "slots", value: { surface: "$accent" } },
]);
view.themeMode = "dark";
svg = renderContent(store.doc, store.pages()[0], snapshot.registry, snapshot.live, view);
check(groupOf(faultPanel.id).includes('fill="' + accentToken.dark + '"'),
      "an authored $accent surface paints the token's dark value in dark mode");
view.themeMode = "light";
svg = renderContent(store.doc, store.pages()[0], snapshot.registry, snapshot.live, view);
check(groupOf(faultPanel.id).includes('fill="' + accentToken.light + '"'),
      "and the light value once the view's mode flips");
check(!groupOf(faultPanel.id).includes('fill="' + accentToken.dark + '"'),
      "the live echo's canonical-dark copy does not defeat the flip");
view.themeMode = "dark";

/* an unknown token paints transparent: opaqueEnough drops it, so the frame vanishes */
store.apply(store.version() + 1, [
  { op: "set_prop", node: faultPanel.id, key: "slots",
    value: { surface: "$nope", border: "$nope" } },
]);
svg = renderContent(store.doc, store.pages()[0], snapshot.registry, snapshot.live, view);
check(!groupOf(faultPanel.id).includes("<rect x"),
      "an unknown token resolves transparent and paints nothing");
store.apply(store.version() + 1, [
  { op: "set_prop", node: faultPanel.id, key: "slots", value: { surface: "#2a2a2a" } },
]);

/* the Style workspace: a token table over the same reconcile idiom */
const stylePanel = new Panel(new Element("main"));
const drawStyle = () =>
  stylePanel.render(styleShape(editor), (host) => renderStyleWorkspace(host, editor));
drawStyle();
const tokenNames = () =>
  stylePanel.host.querySelectorAll("input").filter((i) => !i.className.includes("cpick-hex"));
check(tokenNames().length === 12,
      "the Style workspace lists every seeded token, got " + tokenNames().length);
check(tokenNames().some((i) => i.value === "accent"), "with its name editable in place");
check(stylePanel.host.querySelectorAll(".token-group").length === 2,
      "grouped by the tokens' groups (core, status)");
const styleShapeBefore = styleShape(editor);
store.apply(store.version() + 1, [
  {
    op: "insert",
    parent: 0,
    list: "tokens",
    node: { id: 9100, name: "custom", group: "core", light: "#111111", dark: "#eeeeee" },
  },
]);
check(styleShape(editor) !== styleShapeBefore, "a new token moves the workspace's shape");
drawStyle();
check(tokenNames().some((i) => i.value === "custom"), "and the table lists it");

/* ---- the topbar page selector ----
   Pages moved out of the sidebar: the selector names the current page (a value, moved
   in place by a rename echo), and which pages exist is its shape. */

const pagePanel = new Panel(new Element("div"));
const drawPageSel = () =>
  pagePanel.render(pageSelectShape(editor), (host) => renderPageSelect(host, editor));
drawPageSel();
const pageButton = pagePanel.host.querySelector(".page-select");
check(pageButton !== null, "the topbar page selector built");
check(pageButton.textContent === "Overview",
      "and names the current page, got " + pageButton?.textContent);
store.apply(store.version() + 1, [
  { op: "set_prop", node: page.id, key: "name", value: "Main" },
]);
drawPageSel();
check(pagePanel.host.querySelector(".page-select") === pageButton,
      "a rename echo does not rebuild the selector");
check(pageButton.textContent === "Main", "it moves the name in place");
const pageSelBefore = pageSelectShape(editor);
store.apply(store.version() + 1, [
  { op: "insert", parent: 0, list: "pages", node: { id: 9400, name: "Page 2", widgets: [] } },
]);
check(pageSelectShape(editor) !== pageSelBefore, "a new page moves the selector's shape");

/* ---- the Data workspace: explorer tree, detail pane, where-used ----
   The tree browses the reflected mesh (foldered by / segments), the globals and the
   type table; the detail pane answers what a thing is and where the DOCUMENT uses it.
   A mesh entity has no broadcast value: the only live values shown are the fed cells
   of its consumers, labeled by the widget.slot they arrive through. */

const flowVar = store.globals().find((v) => v.name === "flow");
const meshEditor = {
  ...editor,
  mesh: {
    entities: [
      { kind: "V", name: "plant/temp", type: "", writable: true, forceable: false,
        fields: [{ path: "value", shape: "num" }] },
    ],
    types: [
      { name: "ValveCmd", fields: [{ path: "on", shape: "bool" }],
        entities: [{ kind: "V", name: "plant/valve" }] },
    ],
  },
};
/* a feed consuming the mesh entity, injected as an echo would deliver it */
store.apply(store.version() + 1, [
  {
    op: "insert", parent: toggle.id, list: "feeds",
    node: { id: 9300, slot: "value", src: { kind: "V", name: "plant/temp" },
            path: "value", xf: "", poll_hz: null, stale_ms: null },
  },
]);

const dataTreePanel = new Panel(new Element("aside"));
const drawDataTree = () =>
  dataTreePanel.render(dataShape(meshEditor), (host) => renderDataTree(host, meshEditor));
const dataRow = (key) =>
  dataTreePanel.host.querySelectorAll(".data-row")
    .find((r) => r.getAttribute("data-key") === key) ?? null;
drawDataTree();
check(dataRow("network") !== null, "the explorer tree has the network root");
check(dataRow("d:plant") !== null, "mesh entities folder by their / name segments");
check(dataRow("v:" + flowVar.id) !== null, "the hmi root lists the global variables");
check(dataTreePanel.host.querySelectorAll(".data-add").length === 1,
      "with the + Variable affordance");
check(dataRow("hmi/types") !== null, "and a types folder");

/* a global's live value rides its tree row, moved by the value sync alone */
const treeShapeBefore = dataShape(meshEditor);
meshEditor.live = { epoch: 9, values: { ["v" + flowVar.id]: 3.25 } };
check(dataShape(meshEditor) === treeShapeBefore, "a live frame does not move the tree's shape");
drawDataTree();
const flowLive = dataRow("v:" + flowVar.id).querySelector(".data-live");
check(flowLive.textContent === "3.25",
      "a global's live value renders in its row, got " + flowLive.textContent);

/* the entity detail: head, field table, and the clickable where-used rows */
dataSelect("e:V:plant/temp");
const dataDetailPanel = new Panel(new Element("section"));
const drawDataDetail = () =>
  dataDetailPanel.render(dataShape(meshEditor), (host) => renderDataDetail(host, meshEditor));
drawDataDetail();
check(dataDetailPanel.host.querySelector(".detail-name")?.textContent === "plant/temp",
      "the detail head names the selected entity");
const entityUses = dataDetailPanel.host.querySelectorAll(".used-row");
check(entityUses.length === 1, "where-used finds the one feed consumer, got " + entityUses.length);
check(entityUses[0].textContent.includes("Pump.value"),
      "and names it by widget.slot, got " + entityUses[0].textContent);
meshEditor.live = {
  epoch: 10,
  values: { ["v" + flowVar.id]: 3.25, [toggle.id + ".value"]: true },
};
drawDataDetail();
check(entityUses[0].querySelector(".data-live").textContent === "true",
      "the fed cell's live value rides the consumer row");

/* the global detail: the full card plus its structural uses */
dataSelect("v:" + flowVar.id);
drawDataDetail();
check(dataDetailPanel.host.querySelector(".card") !== null,
      "a selected global shows its variable card");
check(dataDetailPanel.host.querySelector(".now-value")?.textContent === "3.25",
      "with its live value");
const globalUses = dataDetailPanel.host.querySelectorAll(".used-row");
check(globalUses.some((r) => r.textContent.includes("Flow.value")),
      "where-used lists the feed reading the global");
check(globalUses.some((r) => r.textContent.includes("Reset flow: write")),
      "and the flow step writing it");

/* the type detail: fields plus the entities carrying it */
dataSelect("t:ValveCmd");
drawDataDetail();
check(dataDetailPanel.host.querySelector(".detail-name")?.textContent === "ValveCmd",
      "a selected type names itself");
check(dataDetailPanel.host.querySelectorAll(".used-row")
        .some((r) => r.textContent.includes("plant/valve")),
      "and lists its carrier entities");

/* ---- repeat and path (spec 2.3): proved through the real pipeline ----
   Not a unit test of template.ts in isolation: a document component compiled by the
   REAL backend (doc schema -> component compiler -> template-expression compiler ->
   served registry), placed as an ordinary widget and rendered, exactly the path a user
   goes through. `repeat` is what turns "N tick marks around a dial" or "N segments in
   a bar" from one of the nine hard-coded draw generators into an ordinary authored
   part; `path` is the authored shape a repeated node actually draws here, so the same
   round trip proves both at once. A fresh page keeps this SVG free of every other
   widget's own transforms, so the checks below can match on raw substrings without
   scoping to one widget's group. */

ws.send(JSON.stringify({
  type: "apply_ops",
  base_version: backendVersion,
  ops: [
    { op: "insert", parent: 0, list: "pages", node: { id: 9550, name: "Repeat", widgets: [] } },
    {
      op: "insert", parent: 0, list: "components",
      node: {
        name: "Ring", events: [],
        /* `visible` is the STATE base slot every built-in composes (registry.cpp
           state_slots()); a doc component that omits it resolves null with no spec
           to fall back to, and canvas.ts treats a null `visible` as "not rendered"
           (spec 2.3) — so a bare custom component needs it declared to render at all */
        props: [
          { name: "visible", shape: "bool", default: true, group: "config" },
          { name: "enabled", shape: "bool", default: true, group: "config" },
        ],
        parts: [
          {
            kind: "box", name: "dial", dir: "stack", attrs: {}, interact: null,
            children: [
              {
                kind: "path", name: "mark", interact: null, children: [],
                attrs: {
                  /* repeat's count read against the cells the node was handed, its
                     own transform placing each copy: a ring of marks, spec 2.3 */
                  repeat: "4",
                  rotate: "repeat.index * 30 + 15",
                  zoom: "0.1 + repeat.fraction * 0.05",
                  dy: "-0.4",
                  d: "'M0.1 0.9 L0.5 0.1 L0.9 0.9 Z'",
                  fill: "#123456",
                },
              },
            ],
          },
        ],
        behavior: [],
      },
    },
    {
      op: "insert", parent: 0, list: "components",
      node: {
        name: "Bar", events: [],
        props: [
          { name: "visible", shape: "bool", default: true, group: "config" },
          { name: "enabled", shape: "bool", default: true, group: "config" },
        ],
        parts: [
          {
            kind: "box", name: "row", dir: "row", attrs: {}, interact: null,
            children: [
              { kind: "rect", name: "seg", interact: null, children: [],
                attrs: { repeat: "5", fill: "#654321" } },
            ],
          },
        ],
        behavior: [],
      },
    },
  ],
}));
const repeatOpsApplied = await next("ops_applied");
backendVersion = repeatOpsApplied.version;
store.apply(repeatOpsApplied.version, repeatOpsApplied.ops);
/* the component insert changed what the registry derives, so a fresh snapshot follows
   the op echo (app.cpp: ops_applied never carries the registry itself) — requested
   explicitly here with "resync" rather than waited for as a broadcast, since a
   registry-changed snapshot is large (the 12 built-ins alone put it well past a single
   WebSocket frame) and this is the one exchange in the file that needs the compiled
   result back, not just the document echo */
ws.send(JSON.stringify({ type: "resync" }));
const repeatSnapshot = await next("snapshot");
check(
  repeatSnapshot.registry.types.some((t) => t.name === "Ring") &&
    repeatSnapshot.registry.types.some((t) => t.name === "Bar"),
  "the Ring and Bar doc components compiled into the served registry",
);

const repeatPage = store.pages().find((p) => p.id === 9550);
ws.send(JSON.stringify({
  type: "apply_ops",
  base_version: backendVersion,
  ops: [
    { op: "insert", parent: repeatPage.id, list: "widgets",
      node: { type: "Ring", label: "Ring", geom: { x: 0, y: 0, w: 200, h: 200 }, slots: {} } },
    { op: "insert", parent: repeatPage.id, list: "widgets",
      node: { type: "Bar", label: "Bar", geom: { x: 300, y: 0, w: 400, h: 80 }, slots: {} } },
  ],
}));
const repeatWidgetsApplied = await next("ops_applied");
store.apply(repeatWidgetsApplied.version, repeatWidgetsApplied.ops);

const repeatView = { mode: "edit", selection: [], part: "", hover: 0, scale: 1, ghost: null, state: {}, faults: {}, themeMode: "dark" };
const repeatParts = new Map();
const repeatSvg = renderContent(store.doc, store.pages().find((p) => p.id === 9550),
                                repeatSnapshot.registry, snapshot.live, repeatView,
                                null, null, repeatParts);

/* the ring: 4 copies of the SAME named node ("mark", a child of the root "dial" — the
   root itself contributes no path segment, spec 2.3) share one part path, and paint
   the same authored path shape, placed apart only by their own transform */
const markGroups = repeatSvg.match(/data-part="mark">/g) ?? [];
check(markGroups.length === 4, "a repeated stack child renders N copies, got " + markGroups.length);
const marks = repeatSvg.match(/<path d="M0\.1 0\.9 L0\.5 0\.1 L0\.9 0\.9 Z" fill="#123456"\/>/g) ?? [];
check(marks.length === 4, "each copy paints the authored `path` shape once, got " + marks.length);
const rotations = [...repeatSvg.matchAll(/rotate\(([\d.]+) /g)].map((m) => m[1]);
check(rotations.length === 4 && new Set(rotations).size === 4,
      "the 4 copies carry 4 different transforms, got " + JSON.stringify(rotations));
check(JSON.stringify(rotations) === JSON.stringify(["15.00", "45.00", "75.00", "105.00"]),
      "repeat.index reached the rotate expression in copy order, got " + JSON.stringify(rotations));
const zooms = [...repeatSvg.matchAll(/scale\(([\d.]+)\) translate/g)].map((m) => m[1]);
check(new Set(zooms).size === 4,
      "repeat.fraction reached a second expression independently, got " + JSON.stringify(zooms));
/* the ring widget's whole tile records ONE rect for "mark" (recordRepeatRect), not
   whichever of the 4 copies happened to render last */
const ringWidget = repeatPage.widgets.find((w) => w.type === "Ring");
const ringParts = repeatParts.get(ringWidget.id);
check(ringParts instanceof Map && ringParts.size === 1 && ringParts.has("mark"),
      "N copies share one recorded part rect, not one per copy");

/* the bar: 5 copies of a repeated ROW child are separate LAID-OUT siblings (spec 2.3:
   repeat is a layout device there, not a placement one), so they render as 5 ordinary
   rects at 5 different x positions rather than one rect drawn 5 times in place */
const segs = [...repeatSvg.matchAll(/<rect x="([\d.]+)"[^>]*fill="#654321"/g)].map((m) => Number(m[1]));
check(segs.length === 5, "a repeated row child renders N side-by-side rects, got " + segs.length);
check(new Set(segs).size === 5, "and each sits at its own x position, got " + JSON.stringify(segs));
check(segs.every((x, i) => i === 0 || x > segs[i - 1]),
      "the 5 segments are laid out left to right, got " + JSON.stringify(segs));

/* ---- code parts (spec 2.3): the JS-body escape hatch ----
   Proved through the same real pipeline as repeat/path above: a document component
   compiled by the backend, placed as an ordinary widget and rendered. Every `draw.*`
   helper returns markup rather than pushing into a hidden buffer, so one body can mix
   the helpers, hand-written markup and a pasted static SVG in a single return. */

ws.send(JSON.stringify({
  type: "apply_ops",
  base_version: backendVersion,
  ops: [
    { op: "insert", parent: 0, list: "pages", node: { name: "Code", widgets: [] } },
    {
      op: "insert", parent: 0, list: "components",
      node: {
        name: "CodeDemo", events: [],
        props: [
          { name: "visible", shape: "bool", default: true, group: "config" },
          { name: "enabled", shape: "bool", default: true, group: "config" },
          /* a WIDGET-level property: a code part's `props` must carry this by bare
             name too, inherited down from the component root (spec 2.3) */
          { name: "note", shape: "text", default: "hi", group: "value" },
        ],
        parts: [
          {
            kind: "box", name: "body", dir: "stack", attrs: {}, interact: null,
            children: [
              {
                /* (a) renders with draw.rect AND draw.text; (c) `props` carries both
                   this part's OWN property (divisions) and the widget's (note), by
                   bare name; (g) `view.attrs` carries this part's OWN attrs, resolved
                   through the same cells everything else reads through — distinct from
                   `props` above, since a prop and an attr may share a name */
                kind: "code", name: "canvas", attrs: { halo: "'#abc123'" }, interact: null,
                children: [],
                props: [{ name: "divisions", shape: "num", default: 4, group: "config" }],
                code: "return draw.rect({x:0,y:0,w:area.w,h:area.h,fill:'#222222'}) + " +
                      "draw.text(String(props.note) + ':' + String(props.divisions), " +
                      "{x:10,y:10,size:14,fill:'#ffffff'}) + " +
                      "draw.rect({x:0,y:0,w:1,h:1,fill:view.attrs.halo});",
              },
              {
                /* (b) a raw, pasted SVG string renders unchanged: the "just return svg"
                   path, no helpers involved at all */
                kind: "code", name: "raw", attrs: {}, interact: null, children: [], props: [],
                code: "return '<circle cx=\"50\" cy=\"50\" r=\"12\" fill=\"#ff00ff\"/>';",
              },
              {
                /* (d) draw.measure: positive, and grows with the string — the one thing
                   no declarative scale attr can do, which is the whole point */
                kind: "code", name: "measured", attrs: {}, interact: null, children: [], props: [],
                code: "var a = draw.measure('a', 20); var b = draw.measure('abcdefghij', 20); " +
                      "return draw.rect({x:0,y:0,w:1,h:1,fill:(b > a && a > 0) ? '#00ff00' : '#ff0000'});",
              },
              {
                /* (e) throws: draws nothing, and must not take the rest of the render
                   with it — a compile-time-valid body that fails at CALL time */
                kind: "code", name: "broken", attrs: {}, interact: null, children: [], props: [],
                code: "throw new Error('boom');",
              },
              {
                /* proves a throwing SIBLING did not stop the rest of this widget: this
                   part renders after "broken" in the same stack */
                kind: "code", name: "after", attrs: {}, interact: null, children: [], props: [],
                code: "return draw.circle(5,5,3,{fill:'#00ffff'});",
              },
            ],
          },
        ],
        behavior: [],
      },
    },
    {
      op: "insert", parent: 0, list: "components",
      node: {
        name: "CodeRepeat", events: [],
        props: [
          { name: "visible", shape: "bool", default: true, group: "config" },
          { name: "enabled", shape: "bool", default: true, group: "config" },
        ],
        parts: [
          {
            kind: "box", name: "dial", dir: "stack", attrs: {}, interact: null,
            children: [
              {
                /* (f) a code part under `repeat` sees repeat.index change per copy,
                   read off `view.repeat` — the same three cells `repeat:index` etc.
                   resolve to for everyone else (spec 2.3) */
                kind: "code", name: "mark", attrs: { repeat: "3" }, interact: null,
                children: [], props: [],
                code: "return draw.text(String(view.repeat.index), " +
                      "{x:area.x+area.w/2, y:area.y+area.h/2, size:12, fill:'#ffffff'});",
              },
            ],
          },
        ],
        behavior: [],
      },
    },
  ],
}));
const codeOpsApplied = await next("ops_applied");
backendVersion = codeOpsApplied.version;
store.apply(codeOpsApplied.version, codeOpsApplied.ops);
/* the component inserts changed the derivation, so a fresh registry follows (same
   reason the Ring/Bar block above resyncs explicitly rather than waiting on a broadcast).
   A registry change ALSO auto-broadcasts a snapshot the moment ops_applied is sent
   (app.cpp: `if (registry_ != served_before) server_.broadcast(snapshot())`), which can
   already be sitting in `inbox` unconsumed by the time we get here (the Ring/Bar block
   above never drained its own copy of this); draining every snapshot already queued
   before asking again is what keeps the explicit resync below from handing back that
   stale one instead of the fresh registry these ops just produced. */
for (let at = inbox.findIndex((f) => f.type === "snapshot"); at >= 0;
     at = inbox.findIndex((f) => f.type === "snapshot"))
  inbox.splice(at, 1);
ws.send(JSON.stringify({ type: "resync" }));
const codeSnapshot = await next("snapshot");
check(
  codeSnapshot.registry.types.some((t) => t.name === "CodeDemo") &&
    codeSnapshot.registry.types.some((t) => t.name === "CodeRepeat"),
  "the CodeDemo and CodeRepeat doc components compiled into the served registry",
);

/* the served wire node: draw:"code", the body verbatim, and the scope map (bare name ->
   slot address) — served ONLY for a code part, and never run through the
   template-expression compiler */
const canvasNode = codeSnapshot.registry.types.find((t) => t.name === "CodeDemo")
  ?.template?.children?.find((c) => c.name === "canvas");
check(canvasNode?.draw === "code", "a code part serves draw:\"code\"");
check(typeof canvasNode?.code === "string" && canvasNode.code.includes("draw.rect"),
      "the body rides the wire verbatim");
check(
  canvasNode?.scope?.note === "note" && canvasNode?.scope?.divisions === "canvas.divisions",
  "the served scope maps bare names to slot addresses, got " + JSON.stringify(canvasNode?.scope),
);

const codePage = store.pages().find((p) => p.name === "Code");
ws.send(JSON.stringify({
  type: "apply_ops",
  base_version: backendVersion,
  ops: [
    { op: "insert", parent: codePage.id, list: "widgets",
      node: { type: "CodeDemo", label: "CodeDemo", geom: { x: 0, y: 0, w: 200, h: 200 }, slots: {} } },
    { op: "insert", parent: codePage.id, list: "widgets",
      node: { type: "CodeRepeat", label: "CodeRepeat", geom: { x: 300, y: 0, w: 200, h: 200 }, slots: {} } },
  ],
}));
const codeWidgetsApplied = await next("ops_applied");
backendVersion = codeWidgetsApplied.version;
store.apply(codeWidgetsApplied.version, codeWidgetsApplied.ops);

const codeView =
  { mode: "edit", selection: [], part: "", hover: 0, scale: 1, ghost: null, state: {}, faults: {}, themeMode: "dark" };
const codeFaults = new Map();
const codeSvg = renderContent(store.doc, store.pages().find((p) => p.name === "Code"),
                              codeSnapshot.registry, snapshot.live, codeView, null, null, null, codeFaults);

/* (a) a code body using draw.rect/draw.text renders */
has(codeSvg, 'fill="#222222"', "a code body's draw.rect renders");
has(codeSvg, ">hi:4<",
    "(c) props carried both the part's own property (divisions) and the widget's " +
    "(note) by bare name");
/* (b) a body returning a raw SVG string renders it */
has(codeSvg, '<circle cx="50" cy="50" r="12" fill="#ff00ff"/>',
    "a raw returned SVG string renders unchanged");
/* (d) draw.measure returns a positive width that grows with the string */
has(codeSvg, 'fill="#00ff00"', "draw.measure returns a positive width that grows with the string");
/* (g) view.attrs exposes this part's own attrs, resolved through the same cells every
   other draw part's attrs read through */
has(codeSvg, 'fill="#abc123"', "(g) a code body reads one of its own attrs off view.attrs");
/* (e) a throwing part draws nothing, does not break the surrounding render, and
   records a fault naming the widget's part and the JS error */
has(codeSvg, 'fill="#00ffff"', "a sibling AFTER the throwing part still rendered");
has(codeSvg, 'class="fault error"', "the widget carrying the throwing code part shows the fault badge");
has(codeSvg, "boom", "and the badge surfaces the JS error (a title tooltip), not just the console");
const codeDemoWidgetId =
  store.pages().find((p) => p.name === "Code").widgets.find((w) => w.label === "CodeDemo").id;
const faultMsg = codeFaults.get(codeDemoWidgetId);
check(
  typeof faultMsg === "string" && faultMsg.includes("broken") && faultMsg.includes("boom"),
  "a throwing code part records a fault naming the part and the JS error, got " + faultMsg,
);

/* (f) a code part under `repeat` sees repeat.index change per copy */
check(
  codeSvg.includes(">0</text>") && codeSvg.includes(">1</text>") && codeSvg.includes(">2</text>"),
  "a code part under repeat sees repeat.index change per copy",
);

/* trend smoothing is pure math on the drawn copy: noisy input comes out with less
   spread, a null still breaks the run (never bridged), and knobs at 0 pass through */
{
  const { smoothSamples } = await import(mod("template.js"));
  const noisy = [];
  for (let i = 0; i < 60; ++i) noisy.push([50 + (i % 2 ? 8 : -8)]);
  noisy[30] = [null];
  const spread = (rows) => {
    let lo = Infinity, hi = -Infinity;
    for (const [v] of rows.slice(10, 30))
      if (typeof v === "number") { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    return hi - lo;
  };
  const smoothed = smoothSamples(noisy, 1, 0.8, 0.8);
  check(spread(smoothed) < spread(noisy) / 3, "kalman+ema shrink a noisy spread");
  check(smoothed[30][0] === null, "a null sample survives smoothing as a gap");
  check(smoothed[31][0] === noisy[31][0], "the run after a gap restarts from its own sample");
  const identity = smoothSamples(noisy, 1, 0, 0);
  check(
    identity.every((row, i) => row[0] === noisy[i][0]),
    "knobs at 0 pass samples through unchanged",
  );
}

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
