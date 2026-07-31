/* Headless check of the view's pure half: it starts the real backend, joins over the real
 * protocol, and drives the document mirror, the attribute interpreter and the sidebar
 * reconcilers, which get a DOM small enough to run in-process (dom_shim.mjs).
 *
 * It no longer RENDERS anything. The SVG template renderer this file was named for is
 * being removed: pages and component internals both become DOM, so what a widget looks
 * like stops being a string this process can assert on and becomes a layout only a
 * browser computes. Every such check left with the code it pinned; verifying appearance
 * is now a Playwright drive's job. What survives here is everything that was never about
 * pixels — boot, sync, ops round trips, reconciliation, the four workspaces' panels —
 * which is exactly the safety net the rest of the strip needs.
 *
 *   node test/view_test.mjs        (after `node build.mjs` and a backend build) */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rmSync } from "node:fs";
import { Element, fire, installDom, typeInto } from "./dom_shim.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
const exe = join(here, "..", "..", "bin", "hmi_designer" + (process.platform === "win32" ? ".exe" : ""));
const PORT = 7593;
const DOC = join(here, "view_test.tmp.json");

installDom();

const mod = (name) => pathToFileURL(join(dist, name)).href;
const { DocStore } = await import(mod("doc.js"));
const { run } = await import(mod("program.js"));
const { syncUrl } = await import(mod("endpoint.js"));
const { Panel } = await import(mod("reconcile.js"));
const { inspectorShape, leftShape, renderInspector, renderLeftSidebar } =
  await import(mod("inspector/panel.js"));
const { designInspectorShape, designShape, renderDesignInspector, renderDesignTree } =
  await import(mod("workspaces/design.js"));
const { renderStyleWorkspace, styleShape } = await import(mod("workspaces/style.js"));
const { dataShape, dataSelect, renderDataDetail, renderDataTree } =
  await import(mod("workspaces/data.js"));
const { pageSelectShape, renderPageSelect } = await import(mod("pageselect.js"));
const { renderStage } = await import(mod("stage.js"));
const { boundaryAt, dropAtPageEnd, dropPlan, dropZone, gapIndex, resizeAt, settle, withoutHeld } =
  await import(mod("arrange.js"));

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

ws.send(JSON.stringify({ type: "hello", proto: 8, client_name: "view_test" }));
const snapshot = await next("snapshot");
check(snapshot.doc.pages.length === 1, "one page in the snapshot");
check(snapshot.registry.types.length === 12, "twelve widget types");
/* the built-ins' editable document form rides beside the derived registry */
check(Array.isArray(snapshot.builtins) && snapshot.builtins.length === 12,
      "the snapshot serves the twelve built-ins' document form");
/* the closed attr vocabulary: served once, next to `lang`, never changing at runtime —
   the node inspector's Attrs section reads exactly this */
check(Array.isArray(snapshot.attr_table?.kinds) &&
        ["frame", "text", "icon", "path"].every((k) => snapshot.attr_table.kinds.includes(k)),
      "the snapshot serves the four node kinds");
check(Array.isArray(snapshot.attr_table?.common) &&
        snapshot.attr_table.common.some((a) => a.name === "rotate"),
      "and the common attrs honoured on every kind");
check(Array.isArray(snapshot.attr_table?.perKind?.text) &&
        snapshot.attr_table.perKind.text.some((a) => a.name === "size" && a.default === 13),
      "and each kind's own attrs, with its default");
check(Array.isArray(snapshot.builtins[0]?.children) && !snapshot.builtins[0]?.template,
      "a served built-in is doc-form: children with expression text, no compiled template");
/* EVERY PAGE NODE'S ATTRS ARE COMPILED TOO: the same programs a component's are, which is
   what lets one renderer draw a page and a widget's internals */
const headerNode = snapshot.doc.pages[0].children[0];
check(snapshot.node_attrs?.[String(headerNode.id)]?.attrs?.surface?.code?.[0]?.op === "LOAD",
      "a page node's own attrs arrive compiled, keyed by node id");
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
const slider = store.widgetsOn(page).find((w) => w.type === "Slider");

/* ---- frames: the page is a TREE of them now — a header band over a body that splits
   between a main column and a side column of panes — so the default document exercises
   nesting, grow shares and surfaces the moment it opens. What those numbers RESOLVE to
   is the browser's arithmetic and so Playwright's question, not this file's. */
const frameNamed = (node, name) => {
  for (const child of node.children ?? []) {
    if (child.name === name) return child;
    const found = frameNamed(child, name);
    if (found) return found;
  }
  return null;
};
check(page.children.length === 2, "the page is a header over a body, nothing loose");
/* EVERY FIELD IS EXPRESSION TEXT, a literal being the degenerate case: the place a
   column takes and the token it is painted with live in one map, and are read the same */
check(frameNamed(page, "Main")?.attrs?.grow === "2" &&
        frameNamed(page, "Side")?.attrs?.grow === "1",
      "the body splits two-to-one between its columns");
check(frameNamed(page, "Main")?.attrs?.surface === "$surface",
      "a pane is dressed with a theme token, not a literal");
const statusFrame = frameNamed(page, "Status group");
check(statusFrame !== null, "the default document seeds a demo frame");
check(
  statusFrame.children.length === 2 && statusFrame.children.every((c) => c.type),
  "the frame groups two instances — a widget is a frame that names a component",
);

const toggleChild = statusFrame.children.find((c) => c.type === "Toggle");

/* the Layers tree shows the frame nesting: a frame row, its own children indented
   beneath it exactly like a widget's part tree */
{
  const treeHost = new Element("aside");
  const treePanel = new Panel(treeHost);
  const treeEditor = {
    store, registry: snapshot.registry, view,
    page: () => page,
    diagFor: () => [], diagAt: () => [], diagNode: () => [],
    select: () => undefined, selectPart: () => undefined,
  };
  treePanel.render(leftShape(treeEditor), (host) => renderLeftSidebar(host, treeEditor));
  const rows = treeHost.querySelectorAll(".layer-row");
  check(
    rows.some((r) => r.getAttribute("data-key") === "n" + statusFrame.id),
    "the Layers tree lists a row for the frame",
  );
  check(
    rows.some((r) => r.getAttribute("data-key") === "n" + toggleChild.id),
    "and a row for the instance inside it: ONE kind of row, for one kind of node",
  );
}

/* an edit round trip: insert an unfed Readout and watch TO_FIXED format it */
ws.send(
  JSON.stringify({
    type: "apply_ops",
    base_version: snapshot.version,
    ops: [
      {
        op: "insert",
        parent: page.id,
        list: "children",
        node: {
          kind: "frame",
          type: "Readout",
          name: "Unfed",
          /* a nested node's values nest under its name */
          slots: { value: 12.345, reading: { decimals: 1 }, units: { text: "bar" } },
        },
      },
    ],
  }),
);
const applied = await next("ops_applied");
check(applied.version === snapshot.version + 1, "the version advanced by one");
store.apply(applied.version, applied.ops);
/* the header, the body, and the freshly appended Readout beside them */
check(store.pages()[0].children.length === 3, "the insert reached the mirror");

const unfed = store.pages()[0].children[2];
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
/* everything below this point simulates further edits as LOCAL-ONLY echoes (store.apply
   with no ws.send), which is deliberate — it exercises the reconciler without a round
   trip — so store.version() drifts far ahead of what the backend actually saw. */

/* ---- inspector reconciliation ----
   The sidebars are generated from the document, so the question every echo asks is what it
   does to the DOM. An ordinary value must land in the control already standing there:
   same node, new value, no rebuild, and therefore nothing to put back afterwards. A
   structural edit may rebuild, and must then find the user again by document address
   rather than by position in the tree. */

const sidebar = new Element("aside");
sidebar.className = "sidebar right";
const panel = new Panel(sidebar);
const readout = store.pages()[0].children[2];
const editor = {
  store,
  registry: snapshot.registry,
  live: { epoch: 1, values: {} },
  mesh: { entities: [], types: [] },
  lang: null,
  attrTable: snapshot.attr_table ?? { kinds: [], common: [], perKind: {} },
  builtins: snapshot.builtins ?? [],
  componentSel: null,
  builtinSel: null,
  view,
  page: () => store.pages()[0],
  selectedNode: () => store.nodeAt(readout.id),
  selectedNode: () => store.nodeAt(readout.id), selectedWidget: () => store.widget(readout.id),
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
/* The x/y/w/h grid these checks used to drive is gone with manual geometry, so they now
   drive two ordinary NUMBER SLOTS instead (radius and pad, base frame slots every type
   carries). Nothing about what is being proved changes: these are reconciliation rules —
   same node, new value, no rebuild; focus found by document address rather than tree
   position — and they need any two standing numeric controls, not those two in
   particular. Each echo spreads the CURRENT slots so an earlier check's write survives. */
const slotInput = (name) => slotControl(name).children[0];
const slotsNow = () => store.widget(readout.id).slots ?? {};
const echoSlot = (name, value) =>
  echo([{ op: "set_prop", node: readout.id, key: "slots",
          value: { ...slotsNow(), [name]: value } }]);
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
const widthField = slotInput("radius");
sidebar.scrollTop = 140;
echoSlot("radius", 321);
check(inspectorShape(editor) === shapeBefore, "a value echo does not move the inspector's shape");
check(slotInput("radius") === widthField, "a value echo keeps the very same input node");
check(widthField.value === "321", "a value echo assigns the new value, got " + widthField.value);
check(sidebar.scrollTop === 140, "a value echo leaves scroll alone, got " + sidebar.scrollTop);

/* 2. the bug the old focus restore caused: a remote change to the field you are standing
      in was overwritten by the stale local copy, so the inspector looked frozen */
widthField.focus();
echoSlot("radius", 654);
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
const fedWidget = store.widgetsOn(store.pages()[0]).find((w) => (w.feeds ?? []).some((f) => f.slot === "value"));
const fedPanel = new Panel(new Element("aside"));
const fedEditor = { ...editor, selectedNode: () => store.nodeAt(fedWidget.id), selectedWidget: () => store.widget(fedWidget.id) };
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
const heightField = slotInput("pad");
heightField.focus();
echo([
  {
    op: "insert",
    parent: readout.id,
    list: "locals",
    node: { id: 9002, name: "tmp2", type: "f64", init: 0, persist: false },
  },
]);
check(slotInput("pad") !== heightField, "the second insert rebuilt the inspector");
check(document.activeElement === slotInput("pad"), "focus follows the key past inserted controls");
check(
  document.activeElement.getAttribute("type") === "number",
  "and lands on the same kind of control",
);

/* 6. the same batch changes the focused field AND the structure. Restoring the caret must
      not restore the VALUE with it: the field was not dirty, so what the echo carries wins */
const focusedWidth = slotInput("radius");
focusedWidth.focus();
echo([
  { op: "set_prop", node: readout.id, key: "slots", value: { ...slotsNow(), radius: 777 } },
  {
    op: "insert",
    parent: readout.id,
    list: "locals",
    node: { id: 9003, name: "tmp3", type: "f64", init: 0, persist: false },
  },
]);
check(slotInput("radius") !== focusedWidth, "the mixed batch rebuilt the inspector");
check(
  slotInput("radius").value === "777",
  "a rebuild with focus held still shows the echoed value, got " + slotInput("radius").value,
);
check(document.activeElement === slotInput("radius"), "and the caret is still in that field");
document.activeElement = null;

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
const toggle = store.widgetsOn(store.pages()[0]).find((w) => w.type === "Toggle");
const togglePanel = new Panel(new Element("aside"));
const toggleEditor = { ...editor, selectedNode: () => store.nodeAt(toggle.id), selectedWidget: () => store.widget(toggle.id) };
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
const reset = store.widgetsOn(store.pages()[0]).find((w) => w.name === "Reset");
const stepId = reset.flows[0].do[0].id;
const stepRows = [{ node: stepId, grade: "error", code: "expression", message: "unknown name" }];
const stepEditor = {
  ...editor,
  selectedNode: () => store.nodeAt(reset.id), selectedWidget: () => store.widget(reset.id),
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
const readoutW = store.widgetsOn(store.pages()[0]).find((w) => w.type === "Readout");
const feedId = readoutW.feeds[0].id;
const feedRows = [
  { node: feedId, grade: "error", code: "feed_source", message: "HMI variable 'flow' is unresolved", where: "src" },
];
const feedEditor = {
  ...editor,
  selectedNode: () => store.nodeAt(readoutW.id), selectedWidget: () => store.widget(readoutW.id),
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

/* ...and the same finding ATTRIBUTES UP to the widget that owns the feed. The shell's
   diagFor and the topbar findings chip both walk a finding's node to its widget through
   store.owningWidget, and the Layers tree's per-widget badge is what that walk feeds. It
   silently returned 0 for every node once already (it identified a widget by a `geom`
   field that no node carries any more), so the walk is pinned here through the shape the
   badge actually depends on rather than in isolation. */
check(
  leftShape({
    ...editor,
    diagFor: (w) => feedRows.filter((d) => store.owningWidget(d.node) === w),
  }).includes(readoutW.id + ":feed_source:"),
  "a feed's finding attributes to its widget, so the Layers row badge exists",
);

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

/* the Design workspace's own tree, with its own fold state and its own panel */
const designHost = new Element("aside");
const designPanel = new Panel(designHost);
const drawDesign = () =>
  designPanel.render(designShape(editor), (host) => renderDesignTree(host, editor));
const designRow = (key) =>
  designHost.querySelectorAll(".layer-row").find((r) => r.getAttribute("data-key") === key) ?? null;

drawLeft();
const toggleRow = rowByKey("n" + toggle.id);
check(toggleRow !== null, "the Layers tree lists the current page's widgets");
check(left.querySelectorAll(".layer-row.page").length === 0, "the Layers tree has no page rows");
check(rowByKey("p" + page.id) === null, "not even the current page's");
/* a widget row is a LEAF here now: its parts belong to the component that defines them,
   so they are listed by the Design tree and no longer expand out of this one */
check(rowByKey("n" + toggle.id + "/pill.knob") === null,
      "a widget's parts are not listed in the Layers tree");
check(rowByKey("n" + slider.id + "/scale") === null, "not even a part hidden by `show`");

/* a selected part scopes the inspector: widget › part head, ONE section, and only the
   properties that part OWNS — not its siblings', not its children's, not the widget's */
const toggleEditor2 = { ...editor, selectedNode: () => store.nodeAt(toggle.id), selectedWidget: () => store.widget(toggle.id) };
view.selection = [toggle.id];
view.part = "pill.knob";
const widgetShape = (() => { view.part = ""; const s = inspectorShape(toggleEditor2); view.part = "pill.knob"; return s; })();
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
check(widgetLabels.includes("surface"), "and keeps the widget's own frame slots");
/* PLACE IS NOT A SLOT and not a prop: an instance is a node, so how its container gives
   it room is the same attr row a plain frame gets, through the same commit */
const widgetAttrNames = widgetPanel.host.querySelectorAll(".attr-row")
  .map((row) => row.querySelector(".attr-name")?.textContent);
check(widgetAttrNames.includes("grow") && widgetAttrNames.includes("min"),
      "the widget view places the instance, got " + widgetAttrNames.join(","));
{
  /* EVERY part carries its own `shown` switch, so a part is turned off by selecting it
     — and the edit writes NESTED, under the part that owns it */
  check(partLabels.includes("shown"), "a part can be switched off from its own view");
  const applied = [];
  const nested = { ...toggleEditor2, apply: (ops) => applied.push(...ops) };
  view.part = "pill.knob";
  const editPanel = new Panel(new Element("aside"));
  editPanel.render(inspectorShape(nested), (host) => renderInspector(host, nested));
  const pairs = [...editPanel.host.querySelectorAll(".bool-pair")];
  check(pairs.length === 1, "the knob's own view has exactly one switch");
  fire(pairs[0].children[0], "click");   /* the "off" half */
  const slotOp = applied.find((op) => op.key === "slots");
  check(slotOp && slotOp.value?.pill?.knob?.shown === false,
        "a part's edit writes nested under its part, got " + JSON.stringify(slotOp?.value));
  check(slotOp && slotOp.value.shown === undefined,
        "and never at the widget's top level");
  view.part = "";
}

view.selection = [];
view.part = "";

/* ---- the Components section: browse built-ins, edit doc components ----
   Below Layers, the left sidebar lists the document's components (their PART trees,
   real doc nodes) and then the built-ins not shadowed by one, browsable from the
   served doc form and carrying a fork affordance. Selecting a part node scopes the
   inspector to that node's attrs, and a component compile finding (addressed to the
   part node, where = the attr) pins to the attr's own row. */

/* the Components tree moved OUT of the left sidebar and into the Design workspace:
   Layers is page composition, a component's internals belong to the type */
drawLeft();
check(rowByKey("b:Toggle") === null && rowByKey("c9200") === null,
      "the left sidebar lists no components: Layers is page composition alone");
drawDesign();
const builtinToggleRow = designRow("b:Toggle");
check(builtinToggleRow !== null, "the Components section lists unshadowed built-ins");
check(builtinToggleRow.querySelectorAll(".layer-menu").length === 1,
      "a built-in row carries the row-level verb menu (Override <Name>, Duplicate as…)");
check(builtinToggleRow.className.includes("builtin"), "and is marked read-only");
fire(builtinToggleRow.children[0], "click");
drawDesign();
/* a built-in is not in the document, so its rows are addressed by name + CHILD-INDEX
   path ("0" is the root part, "0.0.0" the track inside its pill) rather than node id */
/* THE COMPONENT IS THE ROOT NODE, so index 0 is its first CHILD (the pill), not a
   wrapper box standing in for the component itself */
check(designRow("b:Toggle/0") !== null,
      "an expanded built-in lists its node tree from the served doc form");
check(designRow("b:Toggle/0.0") !== null, "nested nodes too (frames default open)");

/* the row SELECTS, exactly as a doc component's does: the shipped definitions are
   browsable read-only, which is how a type is read before it is overridden */
const browsed = [];
editor.selectBuiltin = (name, path) => browsed.push(name + ":" + path);
fire(designRow("b:Toggle/0.0"), "click");
fire(designRow("b:Toggle"), "click");
check(browsed.join(" ") === "Toggle:0.0 Toggle:",
      "a built-in row browses it by name and part path, got " + JSON.stringify(browsed));

/* the inspector then shows that part's definition, read-only: no field commits, and
   the ADDRESS row says what its properties are called from the outside (spec 2.3) */
const trackEditor = {
  ...editor,
  selectedNode: () => null,
  selectedWidget: () => null,
  /* the pill: index 0 of the component's own children, since the component IS the root */
  builtinSel: { name: "Toggle", path: "0" },
};
const trackPanel = new Panel(new Element("aside"));
check(designInspectorShape(trackEditor) !== designInspectorShape(editor),
      "a browsed built-in owns the Design inspector's shape");
check(inspectorShape(trackEditor) === "empty",
      "and does NOT reach the Content inspector, which is instances only");
trackPanel.render(designInspectorShape(trackEditor),
                  (host) => renderDesignInspector(host, trackEditor));
check(trackPanel.host.querySelector(".head-tag")?.textContent === "built-in",
      "the head marks it as the built-in definition");
const trackAttrs = trackPanel.host.querySelectorAll(".attr-row");
check(trackAttrs.some((row) =>
        row.querySelectorAll("input").some((i) => i.value === "value.pick(fill_color, track_color)")),
      "the attrs table shows each attr's expression text");
check(trackPanel.host.querySelectorAll("input").every((i) => i.getAttribute("readonly")),
      "every field in it is read-only: nothing in the document owns a built-in");
check(trackPanel.host.querySelectorAll(".value-static")
        .some((v) => v.textContent === "pill"),
      "and the ADDRESS row names the node's slot-address prefix");
/* THE COMPONENT IS THE ROOT, and it adds no segment: its own properties address bare,
   which is why an instance's `value` is `value` and never `body.value` */
const bodyEditor = { ...trackEditor, builtinSel: { name: "Toggle", path: "" } };
const bodyPanel = new Panel(new Element("aside"));
bodyPanel.render(designInspectorShape(bodyEditor), (host) => renderDesignInspector(host, bodyEditor));
check(bodyPanel.host.querySelector(".head-tag")?.textContent === "built-in",
      "the component's own view is the root: its properties address bare");
const toggleEditor3 = { ...trackEditor, builtinSel: { name: "Toggle", path: "" } };
const compPanel = new Panel(new Element("aside"));
compPanel.render(designInspectorShape(toggleEditor3), (host) => renderDesignInspector(host, toggleEditor3));
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
      /* the component IS the root frame: its own layout and attrs, holding its children */
      layout: "free",
      attrs: {},
      children: [
        {
          id: 9210,
          kind: "frame",
          name: "body",
          layout: "free",
          attrs: {},
          interact: null,
          children: [
            { id: 9211, kind: "text", name: "label", attrs: { text: "'hi'" } },
          ],
        },
      ],
      behavior: [],
    },
  },
]);
drawDesign();
const lampRow = designRow("c9200");
check(lampRow !== null, "a doc component appears in the Components tree");
check(lampRow.querySelector(".badge.shadow") === null,
      "a component that shadows nothing carries no override tag");
fire(lampRow.children[0], "click");
drawDesign();
check(designRow("c9200/9210") !== null, "an expanded component lists its part nodes");
check(designRow("c9200/9211") !== null, "nested nodes too (frames default open)");

/* selecting the component edits the TYPE: name field and the properties table */
const lampEditor = {
  ...editor,
  selectedNode: () => null,
  selectedWidget: () => null,
  componentSel: { component: 9200, node: 9200 },
};
const lampPanel = new Panel(new Element("aside"));
lampPanel.render(designInspectorShape(lampEditor), (host) => renderDesignInspector(host, lampEditor));
check(lampPanel.host.querySelector(".inspector-head").children[0].value === "Lamp",
      "a selected component's head edits its name");
check(
  lampPanel.host.querySelectorAll(".propdef").length === 1 &&
    lampPanel.host.querySelectorAll(".propdef")[0].querySelectorAll("input")
      .some((i) => i.value === "tint"),
  "the properties table lists the PropDef rows",
);

/* selecting a part edits its attrs: the CLOSED vocabulary (spec 2.3) lists every attr
   the "text" kind declares — own attrs first, then the common set — set or not, not
   just the one this "label" part happens to author */
const labelEditor = { ...lampEditor, componentSel: { component: 9200, node: 9211 } };
const labelPanel = new Panel(new Element("aside"));
check(designInspectorShape(labelEditor) !== designInspectorShape(lampEditor),
      "the selected part node moves the inspector's shape");
labelPanel.render(designInspectorShape(labelEditor), (host) => renderDesignInspector(host, labelEditor));
/* EVERY attr the kind declares, and exactly ONE of the two placement vocabularies: the
   parent decides which, so offering both would be offering a field that does nothing half
   the time — which is the sort of dead row this table exists to prevent */
const attrRows = labelPanel.host.querySelectorAll(".attr-row");
const MEASURED = ["x", "y", "w", "h", "origin_x", "origin_y", "rotate"];
const ARRANGED = ["grow", "min"];
const textVocabCount = editor.attrTable.perKind.text.length +
  editor.attrTable.common.filter((a) => !ARRANGED.includes(a.name)).length;
check(attrRows.length === textVocabCount,
      "the part view lists the kind's attrs and the placement half that applies, got " +
        attrRows.length + " expected " + textVocabCount);
const attrNamed = (rows, name) =>
  rows.find((row) => row.querySelector(".attr-name")?.textContent === name);
check(MEASURED.every((name) => attrNamed(attrRows, name) !== undefined),
      "a child of a FREE frame places itself: x/y/w/h are offered");
check(ARRANGED.every((name) => attrNamed(attrRows, name) === undefined),
      "and the share its parent would have given it is not");
const attrRowNamed = (rows, name) =>
  rows.find((row) => row.querySelector(".attr-name")?.textContent === name);
check(attrRowNamed(attrRows, "text").querySelectorAll("input")
        .some((i) => i.value === "'hi'"),
      "the set attr's expression text is editable in place");
check(labelPanel.host.querySelectorAll(".attr-name.static").length === attrRows.length,
      "every attr name is a static label now, never a typed field");
const unsetColor = attrRowNamed(attrRows, "color");
check(unsetColor.querySelectorAll("input")
        .some((i) => i.value === "" && i.getAttribute("placeholder") === "$ink"),
      "an unset attr shows its own default as the placeholder, unfilled");
check(labelPanel.host.querySelectorAll(".dashed-btn")
        .filter((b) => b.textContent === "+ Attr").length === 0,
      "the closed vocabulary offers nothing to add: no + Attr button on a text leaf");

/* clearing a SET attr's field removes the key from the committed attrs object rather
   than writing "": the document keeps only what was actually authored. `apply` is
   captured rather than routed through the store (which the rest of this fixture never
   mutates through `apply`, a no-op stub) so the committed op is inspectable directly. */
{
  const clearOps = [];
  const clearEditor = { ...labelEditor, apply: (ops) => clearOps.push(...ops) };
  const clearPanel = new Panel(new Element("aside"));
  clearPanel.render(designInspectorShape(clearEditor),
    (host) => renderDesignInspector(host, clearEditor));
  const clearRows = clearPanel.host.querySelectorAll(".attr-row");
  const textInput = attrRowNamed(clearRows, "text").querySelectorAll("input")
    .find((i) => i.value === "'hi'");
  typeInto(textInput, "");
  fire(textInput, "change");
  check(clearOps.length === 1 && clearOps[0].op === "set_prop" && clearOps[0].key === "attrs",
        "clearing the field commits a set_prop on attrs");
  check(clearOps[0] && !("text" in (clearOps[0].value ?? {})),
        "and the committed attrs object has the key removed, not set to \"\"");
}

/* A key the document carries that this kind's vocabulary does NOT declare (a hand-edited
   document, or an attr the table dropped). The compiler flags it, so it must have a row
   of its own: generated rows come from the vocabulary, and this name is not in it, which
   would otherwise mean an error the author can neither see nor remove. */
{
  store.apply(store.version() + 1, [
    { op: "set_prop", node: 9211, key: "attrs",
      value: { text: "'hi'", rotation: "45" } },   /* `rotation` — the classic typo */
  ]);
  const strayPanel = new Panel(new Element("aside"));
  strayPanel.render(designInspectorShape(labelEditor),
    (host) => renderDesignInspector(host, labelEditor));
  const strayRow = attrRowNamed(strayPanel.host.querySelectorAll(".attr-row"), "rotation");
  check(strayRow !== null && strayRow !== undefined,
        "an undeclared key the document carries still gets a row");
  check(strayRow.querySelector(".attr-name.unknown") !== null,
        "marked as one this kind does not read");
  check(strayRow.querySelectorAll("button").length === 1,
        "and carrying a delete, so the finding is actionable");
  /* it is STRUCTURE: adding or removing a stray changes which rows exist, so the shape
     string has to move with it or the panel would never rebuild */
  const withStray = designInspectorShape(labelEditor);
  store.apply(store.version() + 1, [
    { op: "set_prop", node: 9211, key: "attrs", value: { text: "'hi'" } },
  ]);
  check(designInspectorShape(labelEditor) !== withStray,
        "a stray coming and going moves the inspector's shape");
}

/* THERE IS NO OPEN KIND ANY MORE: `code` parts are gone, so every attr on every node is
   checked against the one table. What the document carries that the vocabulary does NOT
   name still gets a row of its own — visible and removable, never an error with nowhere
   to land. */
store.apply(store.version() + 1, [
  { op: "set_prop", node: 9211, key: "attrs", value: { text: "'hi'", rotaton: "1" } },
]);
const strayPanel = new Panel(new Element("aside"));
strayPanel.render(designInspectorShape(labelEditor),
                  (host) => renderDesignInspector(host, labelEditor));
const strayRow = strayPanel.host.querySelectorAll(".attr-row")
  .find((row) => row.querySelector(".attr-name")?.textContent === "rotaton");
check(strayRow !== undefined, "an attr the kind does not read still gets a row");
check(strayPanel.host.querySelectorAll(".row-label")
        .some((l) => l.textContent === "NOT READ BY THIS KIND"),
      "under a heading that says so");
store.apply(store.version() + 1, [
  { op: "set_prop", node: 9211, key: "attrs", value: { text: "'hi'" } },
]);

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
attrDiagPanel.render(designInspectorShape(attrDiagEditor), (host) =>
  renderDesignInspector(host, attrDiagEditor));
const diagAttrRow = attrDiagPanel.host.querySelectorAll(".attr-row")[0];
check(diagAttrRow.querySelectorAll(".diag-dot.error").length === 1,
      "a component finding pins to the attr row the compiler named");

/* the doc component SHADOWS a built-in by name: the built-in row folds away, and the
   row now carries a legible override tag, not just a tooltip (spec 3.1) */
store.apply(store.version() + 1, [
  { op: "set_prop", node: 9200, key: "name", value: "Toggle" },
]);
drawDesign();
check(designRow("b:Toggle") === null, "a shadowed built-in leaves the built-ins list");
check(designRow("c9200").querySelector(".shadows") !== null,
      "and the doc component is marked as overriding it");
check(designRow("c9200").querySelector(".badge.shadow") !== null,
      "the override tag is legible in the row itself, not only the tooltip");

/* "Revert to built-in": removing the component that shadows one restores it (the same
   op the row menu's danger-styled Revert entry issues) */
store.apply(store.version() + 1, [{ op: "remove", node: 9200 }]);
drawDesign();
check(designRow("b:Toggle") !== null, "reverting a shadowing component restores the built-in row");

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
drawDesign();
check(designRow("b:Knob") !== null, "duplicating a built-in leaves the built-in itself listed");
check(designRow("c9300") !== null, "and a second component appears under the fresh name");
check(designRow("c9300").querySelector(".badge.shadow") === null,
      "the duplicate shadows nothing (a different name), so it carries no override tag");
store.apply(store.version() + 1, [{ op: "remove", node: 9300 }]);
drawDesign();

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

/* How a "$name" slot RESOLVES per view mode was asserted against the SVG renderer and
   goes with it; the rule itself (document over live echo, per-view dark/light) is
   Playwright's to re-pin once tokens are CSS custom properties. */

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
  { op: "insert", parent: 0, list: "pages", node: { id: 9400, name: "Page 2", children: [] } },
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

/* ---- the stage: a page as real DOM ----
   STRUCTURE ONLY. This process has no layout engine, so what a weight RESOLVES to is a
   browser's arithmetic and a Playwright drive's question; what is asserted here is the
   mapping — which document prop lands in which style, what nests inside what, which live
   cell a picture depends on. */

const stageStore = new DocStore();
stageStore.load({
  version: 1,
  next_id: 999,
  globals: [],
  tokens: snapshot.doc.tokens,
  components: [],
  pages: [{
    id: 900,
    name: "Stage",
    children: [
      { id: 901, kind: "frame", name: "Row", layout: "row", type: "", attrs: {}, children: [
          { id: 903, kind: "frame", type: "Panel", name: "Lamp", attrs: {},
            slots: { surface: "#123456" }, locals: [], feeds: [], flows: [] },
          { id: 904, kind: "frame", type: "Label", name: "", attrs: {},
            slots: { text: "hi" }, locals: [], feeds: [], flows: [] },
        ] },
      { id: 902, kind: "frame", name: "Deck", layout: "free", type: "", attrs: {}, children: [
          { id: 905, kind: "frame", type: "Panel", name: "Under", attrs: {},
            slots: {}, locals: [], feeds: [], flows: [] },
        ] },
    ],
  }],
});

/* A PAGE NODE'S FIELDS ARE PROGRAMS, exactly like a component's — the backend compiles
   both with the same compiler, and this is the wire form it serves them in. A literal is
   the degenerate program, which is why one CONST covers most of a page. */
const prog = (v) => ({ code: [{ op: "CONST", v }] });
const loads = (cell) => ({ code: [{ op: "LOAD", cell }] });
const stageAttrs = {
  "901": { attrs: { grow: prog(2), min: prog(40), gap: prog(6), pad: prog(4),
                    radius: prog(3), align: prog("center"), justify: prog("between"),
                    surface: loads("theme:accent") } },
  "902": { attrs: { grow: prog(1) } },
  "903": { attrs: { grow: prog(1) } },
  "904": { attrs: { grow: prog(3) } },
  "905": { attrs: {} },
};

const stageHost = new Element("section");
const stageView = { mode: "edit", selection: [], part: "", hover: 0, state: {}, faults: {} };
const stageEditor = {
  store: stageStore,
  registry: snapshot.registry,
  nodeAttrs: stageAttrs,
  live: { epoch: 1, values: {} },
  view: stageView,
  page: () => stageStore.pages()[0],
  select: (ids) => { stageView.selection = ids; },
};
const drawStage = () => renderStage(stageHost, stageEditor);
const stageNode = (cls, id) =>
  stageHost.querySelectorAll("." + cls).find((n) => n.getAttribute("data-id") === String(id)) ?? null;

drawStage();
const stagePage = stageHost.querySelector(".page");
check(stagePage !== null, "the stage renders a page element");
const row = stageNode("frame", 901);
const deck = stageNode("frame", 902);
check(row !== null && deck !== null, "each frame is a div carrying its own id");
check(row.parentElement === stagePage && deck.parentElement === stagePage,
      "the page's frames are its own children");
check(stageNode("leaf", 903)?.parentElement === row, "and a frame's widgets nest inside it");
check(row.style.display === "flex" && row.style.flexDirection === "row",
      "a row lays out as a flex row");
/* FREE is measurement space: the box is the origin, and a child with nothing said about
   its x/y/w/h pins to all four edges — which is what "stack" used to mean before it
   dissolved into the general rule */
check(deck.style.position === "relative", "a free frame is its children's origin");
check(stageNode("leaf", 905).style.position === "absolute" &&
        stageNode("leaf", 905).style.left === "0" &&
        stageNode("leaf", 905).style.right === "0",
      "and an unplaced free child fills it");
check(row.style.alignItems === "center" && row.style.justifyContent === "space-between",
      "align is the cross axis and justify the main one");
check(stageNode("leaf", 903).style.flex === "1 1 0" &&
        stageNode("leaf", 904).style.flex === "3 1 0",
      "grow is a flex weight over a zero basis");
check(stageNode("leaf", 903).style.minWidth === "0" &&
        stageNode("leaf", 903).style.minHeight === "0",
      "and every child is free to shrink below its content");
/* `min` is a floor on the CONTAINER's main axis, so the same number on the same node
   means a height under the page's column and a width under a row */
check(row.style.minHeight === "40px" && row.style.minWidth === "0",
      "an authored min floors the container's main axis");
check(row.style.gap === "6px" && row.style.padding === "4px" && row.style.borderRadius === "3px",
      "gap, pad and radius reach the style");
check(stagePage.style["--t-accent"] === "#4e8ef7",
      "the document's tokens are emitted as custom properties on the page");
check(row.style.background === "var(--t-accent)",
      "so a $token surface is an ordinary var(), resolved by the browser");
check(stageNode("leaf", 903).style.background === "#123456",
      "an instance paints the surface it authors, through its component's own attr");
check(stageNode("leaf", 905).style.background === "var(--t-surface)",
      "and falls back to the served type's own default");
/* AN INSTANCE RENDERS ITS COMPONENT: the Label's own text leaf is real DOM inside it,
   reading the slot this placement authored */
const labelInk = stageNode("leaf", 904).querySelector(".ink-text");
check(labelInk !== null && labelInk.textContent === "hi",
      "an instance renders its component's own nodes, reading this placement's slots");

/* LIVE FIRST: the cell the runtime publishes outranks what the instance authored, which
   is the whole of a lamp — a Panel with a bound surface lights up. The EPOCH stays put
   across these: it moves on a recompile, not on a tick (app.cpp). */
stageEditor.live = { epoch: 1, values: { "903.surface": "#ff0000" } };
drawStage();
check(stageNode("leaf", 903).style.background === "#ff0000",
      "a live cell paints over the authored surface");

/* ...and the price of that is paid ONCE per change, not thirty times a second: a live
   frame that moves no cell this picture read leaves the very same nodes standing */
const heldRow = stageNode("frame", 901);
stageEditor.live = { epoch: 1, values: { "903.surface": "#ff0000", "999.value": 7 } };
drawStage();
check(stageNode("frame", 901) === heldRow, "a live frame touching no consumed cell rebuilds nothing");
stageEditor.live = { epoch: 1, values: { "903.surface": "#00ff00" } };
drawStage();
check(stageNode("frame", 901) !== heldRow, "and one that moves a consumed cell rebuilds the page");

/* A COMPILE REBUILDS IT REGARDLESS. Editing an attr leaves the tree identical and changes
   the PROGRAM the field evaluates to, and the new programs arrive in the snapshot that
   follows the echo — so the epoch is what says "the same document means something else
   now". Without this a boundary drag commits its number and redraws the old one. */
const heldAgain = stageNode("frame", 901);
stageAttrs["901"].attrs.grow = prog(5);
drawStage();
check(stageNode("frame", 901) === heldAgain,
      "fresh programs alone do not rebuild: nothing told the view they were fresh");
stageEditor.live = { epoch: 2, values: { "903.surface": "#00ff00" } };
drawStage();
check(stageNode("frame", 901) !== heldAgain && stageNode("frame", 901).style.flex === "5 1 0",
      "a new compile epoch rebuilds the page from the programs it just received");

/* ---- the node inspector ----
   A page's frame is a NODE, so it is inspected the way a component's node is: two
   structural fields (what it is, how it places its children) and then every attr its kind
   declares, generated from the served vocabulary. There is no hand-written field list for
   a page frame and a second one for a component's frame, because there is one node. */
{
  const group = frameNamed(store.pages()[0], "Status group");
  const applied = [];
  const frameEditor = {
    ...editor,
    selectedNode: () => store.nodeAt(group.id),
    selectedWidget: () => null,
    apply: (ops) => applied.push(...ops),
  };
  const framePanel = new Panel(new Element("aside"));
  framePanel.render(inspectorShape(frameEditor), (host) => renderInspector(host, frameEditor));
  const cellFor = (name) => {
    for (const grid of framePanel.host.querySelectorAll(".prop-grid")) {
      const kids = grid.children;
      for (let i = 0; i + 1 < kids.length; i++)
        if (kids[i].tagName === "LABEL" && kids[i].textContent === name) return kids[i + 1];
    }
    return null;
  };
  const options = cellFor("layout").querySelectorAll("option").map((o) => o.value);
  check(options.join(",") === "free,row,col,grid",
        "layout offers the four modes, got " + options.join(","));

  const attrRowFor = (name) =>
    framePanel.host.querySelectorAll(".attr-row")
      .find((row) => row.querySelector(".attr-name")?.textContent === name) ?? null;
  /* the frame's own dressing, and the placement half that applies: this frame sits in a
     COLUMN, so it is arranged by a share and a floor and places itself nowhere */
  for (const name of ["gap", "pad", "align", "justify", "surface", "border", "border_w",
                      "radius", "grow", "min", "aspect"])
    check(attrRowFor(name) !== null, "the node inspector edits " + name);
  for (const name of ["x", "y", "w", "h", "rotate"])
    check(attrRowFor(name) === null,
          "and does not offer " + name + ", which its parent's layout ignores");

  /* editing one writes the WHOLE attrs map, exactly as a component's node does */
  const gapField = attrRowFor("gap").querySelectorAll("input")[0];
  gapField.value = "12";
  fire(gapField, "change");
  const op = applied.find((o) => o.key === "attrs");
  check(op && op.op === "set_prop" && op.node === group.id && op.value.gap === "12",
        "editing an attr writes one set_prop of the map, got " + JSON.stringify(op));
  /* and clearing it back to empty REMOVES the key rather than storing "" */
  applied.length = 0;
  const surfaceField = attrRowFor("surface").querySelectorAll("input")[0];
  surfaceField.value = "";
  fire(surfaceField, "change");
  const cleared = applied.find((o) => o.key === "attrs");
  check(cleared && !("surface" in cleared.value),
        "clearing an attr drops the key, so the document keeps only what was authored");
}

/* ---- moving a node: the mirror's half, and the drop arithmetic ----
   A move echo always carries the whole placement (node, parent, list, index), so the mirror
   has ONE path for a reorder, a reparent and a page shuffle alike. Everything below the
   mirror block is arrange.ts, which is pure on purpose: a browser decides where the rows
   ARE, but which parent and which index a drop means is arithmetic, and it is the part that
   makes tree dragging feel right or maddening. */
{
  const leaf = (id, name) => ({ id, kind: "frame", type: "Label", name,
                                 attrs: { grow: "1", min: "0" }, slots: {}, locals: [], feeds: [], flows: [] });
  const frame = (id, name, children) => ({ id, kind: "frame", name, layout: "col", gap: 0, pad: 0,
                                           align: "stretch", justify: "start", surface: "",
                                           border: "", border_w: 1, radius: 0, attrs: { grow: "1", min: "0" },
                                           children });
  /* Left[ A, Inner[ E ] ], Right[ C ], D */
  const movePage = () => ({
    id: 700,
    name: "Move",
    children: [
      frame(710, "Left", [leaf(711, "A"), frame(715, "Inner", [leaf(716, "E")])]),
      frame(720, "Right", [leaf(721, "C")]),
      leaf(730, "D"),
    ],
  });
  const ids = (list) => (list ?? []).map((n) => n.id).join(",");

  const moveStore = new DocStore();
  moveStore.load({ version: 1, next_id: 900, globals: [], tokens: [], components: [],
                   pages: [movePage(), { id: 800, name: "Second", children: [] }] });

  moveStore.apply(2, [{ op: "move", node: 711, parent: 720, list: "children", index: 0 }]);
  check(ids(moveStore.nodeAt(710).children) === "715", "a reparent echo takes the node out of its old frame");
  check(ids(moveStore.nodeAt(720).children) === "711,721", "and splices it in where the echo says");
  check(moveStore.parentOf(711)?.id === 720, "and the mirror re-indexes it under its new parent");
  /* what the shell's selectable() filter reads after every echo: a selected node that only
     MOVED must still resolve, or the inspector empties under the author's hands */
  check(Boolean(moveStore.widget(711) ?? moveStore.nodeAt(711)),
        "a selected node survives its own reparent echo");

  moveStore.apply(3, [{ op: "move", node: 700, parent: 0, list: "pages", index: 1 }]);
  check(ids(moveStore.pages()) === "800,700", "a page echo reorders the one list hanging off the root");

  moveStore.apply(4, [{ op: "move", node: 711, index: 1 }]);
  check(ids(moveStore.nodeAt(720).children) === "721,711",
        "and an echo with no parent at all reorders where the node already is");

  /* the wrap echo: an insert of an EMPTY frame, then one addressed move per node, so the
     mirror never holds the same widget in two places */
  moveStore.apply(5, [
    { op: "insert", parent: 700, list: "children", index: 0,
      node: frame(750, "Row", []) },
    { op: "move", node: 710, parent: 750, list: "children", index: 0 },
    { op: "move", node: 720, parent: 750, list: "children", index: 1 },
  ]);
  check(ids(moveStore.page(700).children) === "750,730", "the wrap echo lands the frame where the nodes were");
  check(ids(moveStore.nodeAt(750).children) === "710,720", "with both of them inside it");
  check(moveStore.parentOf(710)?.id === 750 && moveStore.parentOf(720)?.id === 750,
        "and nowhere else");

  /* ---- arrange.ts ---- */
  const tree = movePage();
  const at = (drag, target, zone, open) => {
    const plan = dropPlan(tree, drag, target, zone, open);
    return plan ? plan.parent + ":" + plan.index : "none";
  };

  check(at(730, 720, "into") === "720:1", "dropping INTO a frame appends to it");
  check(at(730, 711, "before") === "710:0", "before a row is that row's own place in its parent");
  check(at(730, 711, "after") === "710:1", "and after it is one past");
  check(at(716, 730, "after") === "700:3", "a top-level row's parent is the page");

  /* THE ERASE-FIRST SHIFT, in the smallest case there is: children [A,B,C], A dropped
     after B, is index 1 — the list the server inserts into is [B,C]. */
  const abc = { id: 600, name: "ABC", children: [leaf(601, "A"), leaf(602, "B"), leaf(603, "C")] };
  const abcAt = (drag, target, zone) => {
    const plan = dropPlan(abc, drag, target, zone);
    return plan ? plan.parent + ":" + plan.index : "none";
  };
  check(abcAt(601, 602, "after") === "600:1", "dragging A after B sends index 1, not 2");
  check(abcAt(601, 603, "after") === "600:2", "and past C sends 2, not 3");
  check(abcAt(603, 601, "before") === "600:0", "while dragging the other way needs no shift");
  check(abcAt(603, 602, "before") === "600:1", "nor does landing between the two above it");

  /* the gap under an OPEN frame row is the gap above its first child */
  check(at(730, 710, "after", true) === "710:0", "after an open frame means into it, at the top");
  check(at(730, 710, "after", false) === "700:1", "while a folded one keeps its own place in the page");
  check(at(730, 720, "after", true) === "720:0", "an open frame with children, the same way");

  /* refusals: a frame into its own subtree, a row onto itself, and a drop that moves nothing */
  check(at(710, 715, "into") === "none", "a frame cannot be dropped inside its own child");
  check(at(710, 716, "before") === "none", "nor beside anything within it");
  check(at(710, 710, "into") === "none", "nor into itself");
  check(at(730, 730, "before") === "none", "a row is never its own target");
  check(at(711, 715, "before") === "none", "and the place it already occupies is not a move");
  check(at(721, 721, "after") === "none", "the only child of a frame, dropped after itself");
  check(at(999, 710, "into") === "none", "an id the page does not hold plans nothing");
  check(at(730, 999, "into") === "none", "and neither does a target it does not hold");
  check(at(730, 711, "into") === "none", "a widget row has no inside to drop into");

  /* the empty room under the last row: the end of the page */
  const end = dropAtPageEnd(tree, 711);
  check(end?.parent === 700 && end?.index === 3, "the space below the tree appends to the page");
  check(dropAtPageEnd(tree, 730) === null, "unless the node is already the last thing on it");

  /* the zone the pointer names, from the row's own proportions */
  check(dropZone(true, 0.2) === "before" && dropZone(true, 0.5) === "into" &&
          dropZone(true, 0.8) === "after",
        "a frame row means INSIDE through its middle, and a gap at either edge");
  check(dropZone(false, 0.4) === "before" && dropZone(false, 0.6) === "after",
        "a widget row has no middle: it splits at the halfway mark");

  /* ---- the stage's own geometry ----
     The tree names a row and a zone; the stage names a container and a pointer. The midpoint
     rule turns the second into an index, and both then go through settle(), which is why a
     drop means the same thing on this page however it was aimed. */

  check(gapIndex([], 50) === 0, "an empty container takes the only slot there is");
  check(gapIndex([10, 30, 50], 5) === 0, "before every midpoint is the front");
  check(gapIndex([10, 30, 50], 20) === 1 && gapIndex([10, 30, 50], 40) === 2,
        "between two midpoints is the gap between them");
  check(gapIndex([10, 30, 50], 99) === 3, "and past the last is the end");
  check(gapIndex([10], 10) === 0, "a pointer exactly on a midpoint has not passed it yet");

  /* read against the PREVIEW, which already holds the dragged node */
  check(withoutHeld(2, 0) === 1 && withoutHeld(3, 1) === 2,
        "a slot past the held node is one too far");
  check(withoutHeld(1, 1) === 1 && withoutHeld(0, 2) === 0, "a slot at or before it is not");
  check(withoutHeld(2, -1) === 2, "and a container the node is not in shifts nothing");

  /* settle(), reached the way the stage reaches it: a container and an index, no row and no
     zone in between, but the same legality and the same erase-first shift */
  check(settle(tree, 730, { parent: 720, index: 1 })?.index === 1, "a plain append settles as itself");
  check(settle(tree, 711, { parent: 710, index: 2 })?.index === 1,
        "a slot further down its own list still loses one to the erase");
  check(settle(tree, 710, { parent: 715, index: 0 }) === null, "a frame still refuses its own subtree");
  check(settle(tree, 711, { parent: 710, index: 0 }) === null, "and the seat it already holds is no move");

  /* WHICH BOUNDARY the pointer is on: a strip centred on the gap-line between two siblings,
     across the cross extent the pair actually shares */
  const band = (start, end, from = 0, to = 100) => ({ start, end, from, to });
  const three = [band(0, 100), band(100, 240), band(240, 300)];
  check(boundaryAt(three, 100, 50, 5) === 0, "the line between the first two children is boundary 0");
  check(boundaryAt(three, 243, 50, 5) === 1, "the next one along is boundary 1");
  check(boundaryAt(three, 170, 50, 5) === null, "the middle of a child is no boundary");
  check(boundaryAt(three, 107, 50, 5) === null, "nor is a point past the tolerance");
  check(boundaryAt([band(0, 100)], 100, 50, 5) === null, "one child has no boundary at all");
  check(boundaryAt([], 0, 0, 5) === null, "and an empty container none either");
  check(boundaryAt([band(0, 100), band(110, 200)], 105, 50, 5) === 0,
        "with a gap between them the line is the middle of the gap");
  const uneven = [band(0, 100, 0, 40), band(100, 200, 0, 100)];
  check(boundaryAt(uneven, 100, 20, 5) === 0, "inside the shared cross extent the strip grabs");
  check(boundaryAt(uneven, 100, 70, 5) === null, "past where the shorter one ends, it does not");
  /* DEEPEST FIRST is the caller's walk, and this is what makes it matter: a nested container
     has boundaries of its own inside one child of its parent's */
  const nested = [band(0, 150), band(150, 300)];
  check(boundaryAt(nested, 150, 50, 5) === 0 && boundaryAt(three, 150, 50, 5) === null,
        "a pointer inside a child can only mean that child's own boundary");
  check(boundaryAt(three, 100, 50, 5) === 0 && boundaryAt(nested, 100, 50, 5) === null,
        "and where the inner has none, the container's own answers");

  /* ---- and what dragging one writes ---- */
  const side = (grow, min, outer, chrome = 0) => ({ grow, min, outer, chrome });

  /* TRANSFER: 200px and 100px of a 300px row at weights 2 and 1, so one grow unit is 100px */
  const share = resizeAt(side(2, 0, 200), side(1, 0, 100));
  const moved = share.apply(50);
  check(Math.abs(moved.a.grow - 2.5) < 1e-9 && Math.abs(moved.b.grow - 0.5) < 1e-9,
        "50px at 100px per grow unit is half a unit each way, got " + JSON.stringify(moved));
  check(Math.abs(moved.a.grow + moved.b.grow - 3) < 1e-9,
        "the pair's sum is conserved, so no other sibling's share moves");
  check(moved.a.min === undefined && moved.b.min === undefined, "and a transfer writes no min");
  /* the same 100px unit under 30px of padding and border: those come off the shared pool
     before the division, so half a unit is still 50px of pointer */
  const padded = resizeAt(side(2, 0, 220, 20), side(1, 0, 110, 10));
  check(Math.abs(padded.apply(50).a.grow - 2.5) < 1e-9,
        "a side's own padding and border are outside the share it is paid, got " +
          padded.apply(50).a.grow);
  const far = share.apply(1e6);
  check(Math.abs(far.b.grow * 100 - 24) < 1e-9,
        "the shrinking side stops at a graspable 24px, got " + far.b.grow * 100);
  check(Math.abs(far.a.grow + far.b.grow - 3) < 1e-9, "with the sum still conserved at the stop");
  check(Math.abs(resizeAt(side(2, 60, 200), side(1, 40, 100)).apply(-1e6).a.grow * 100 - 60) < 1e-9,
        "a side's own min outranks that floor when it is the larger");
  check(share.apply(-1e6).a.grow >= 0.05, "and a drag never writes a grow of zero");
  check(resizeAt(side(1, 0, 0), side(1, 0, 0)) === null,
        "a boundary with nothing either side of it is inert, not a division by zero");
  const rough = resizeAt(side(1, 0, 100), side(1, 0, 100));
  check(Math.abs(rough.apply(3.7).a.grow - 1.037) < 1e-9, "the live preview uses raw values");
  check(rough.commit(3.7).a.grow === 1.04 && rough.commit(3.7).b.grow === 0.96,
        "and the commit rounds grow to two decimals, got " + JSON.stringify(rough.commit(3.7)));

  /* ONE FIXED SIDE — the header band over the body, which is the case the default document
     opens with: the drag is the header's min, and the body absorbs it with no write at all */
  const band52 = resizeAt(side(0, 52, 52), side(1, 0, 400));
  check(band52.apply(18).a.min === 70 && band52.apply(18).b === null,
        "a fixed side takes the whole drag as min, and the flexible side takes nothing");
  check(band52.apply(18).a.grow === undefined, "no grow is written on either side of it");
  check(band52.apply(-1e6).a.min === 24, "it stops at the graspable floor");
  check(band52.apply(1e6).a.min === 52 + 400 - 24, "and at what the absorbing side can give");
  const after = resizeAt(side(1, 0, 400), side(0, 52, 52));
  check(after.apply(10).b.min === 42 && after.apply(10).a === null,
        "a fixed side AFTER the boundary takes the same drag the other way");
  check(after.commit(0.4).b.min === 52, "and min commits as a whole pixel");
  check(resizeAt(side(0, 4, 4), side(1, 0, 400)).apply(-1e6).a.min === 24,
        "no min write ever lands below the floor, let alone below zero");

  /* NEITHER FLEXES: the pair of mins, one taking exactly what the other gives */
  const fixed = resizeAt(side(0, 100, 100), side(0, 60, 60));
  check(fixed.apply(20).a.min === 120 && fixed.apply(20).b.min === 40,
        "two fixed sides trade min for min");
  check(fixed.apply(1e6).b.min === 24 && fixed.apply(-1e6).a.min === 24,
        "and either of them stops at the floor rather than vanishing");
}

/* What used to close this file -- the repeat/path round trip and the code-part escape
   hatch, both proved by rendering a backend-compiled component to SVG, plus trend
   smoothing out of template.ts -- went with the SVG renderer. Those are real behaviours
   and they will need re-pinning against the DOM once components render as HTML. */


ws.close();
backend.kill();
if (backend.exitCode === null)
  await new Promise((resolve) => {
    backend.once("exit", resolve);
    setTimeout(resolve, 1000);
  });
rmSync(DOC, { force: true });
console.log(`view_test: ${checks} checks, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
