/* Headless check of the view's pure half: it starts the real backend, joins over the real
 * protocol, and drives the document mirror, the attribute interpreter and the sidebar
 * reconcilers, which get a DOM small enough to run in-process (dom_shim.mjs).
 *
 * It no longer RENDERS anything. The SVG template renderer this file was named for is
 * being removed: pages and component internals both become DOM, so what an instance looks
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
const { foldAggs } = await import(mod("editor.js"));
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
const { renderStage, setTransitionClock, stepTransitions, setWallClock, stepTime } =
  await import(mod("stage.js"));
const { dropAtPageEnd, dropPlan, dropZone, fmtFraction, fmtPx, freeAllowed, freeBoxOf,
        freePlan, settle, snapPx } =
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

ws.send(JSON.stringify({ type: "hello", proto: 18, client_name: "view_test" }));
const snapshot = await next("snapshot");
check(snapshot.doc.pages.length === 1, "one page in the snapshot");
check(snapshot.registry.components.length === 12, "twelve components");
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
   what lets one renderer draw a page and an instance's internals */
const headerNode = snapshot.doc.pages[0].children[0];
check(snapshot.node_attrs?.[String(headerNode.id)]?.attrs?.surface?.code?.[0]?.op === "LOAD",
      "a page node's own attrs arrive compiled, keyed by node id");
const interactionOf = (node) =>
  node?.interact ?? (node?.children ?? []).map(interactionOf).find(Boolean) ?? null;
check(
  interactionOf(snapshot.registry.components.find((type) => type.name === "Slider")?.template)?.primitive ===
    "drag1d",
  "the slider exposes the generic drag primitive",
);

const store = new DocStore();
store.load(snapshot.doc);
const view = { mode: "edit", selection: [], element: "", hover: 0, scale: 1, ghost: null, state: {}, faults: {}, themeMode: "dark" };
const page = store.pages()[0];
const slider = store.instancesOn(page).find((w) => w.type === "Slider");

/* ---- boxes: the page is an ARRANGEMENT ON THE ARTBOARD — the header band, the main
   pane and the side panes each at their own place in canvas px, on the 22px grid. What
   those numbers look like on screen is the browser's arithmetic and so Playwright's
   question, not this file's. */
const frameNamed = (node, name) => {
  for (const child of node.children ?? []) {
    if (child.name === name) return child;
    const found = frameNamed(child, name);
    if (found) return found;
  }
  return null;
};
check(page.children.length === 4, "the page is the four top-level panes, nothing loose");
/* EVERY FIELD IS EXPRESSION TEXT, a literal being the degenerate case: the place a
   pane sits and the token it is painted with live in one map, and are read the same */
check(frameNamed(page, "Main")?.attrs?.left === "22" &&
        frameNamed(page, "Main")?.attrs?.w === "880",
      "the main pane carries its own box in canvas px");
check(frameNamed(page, "Main")?.attrs?.surface === "$surface",
      "a pane is dressed with a theme token, not a literal");
const statusFrame = frameNamed(page, "Status group");
check(statusFrame !== null, "the default document seeds a demo frame");
check(
  statusFrame.children.length === 2 && statusFrame.children.every((c) => c.type),
  "the frame groups two instances — an instance is a frame that names a component",
);

const toggleChild = statusFrame.children.find((c) => c.type === "Toggle");

/* the Layers tree shows the frame nesting: a frame row which STARTS SHUT, and its own
   children indented beneath it once its caret is clicked */
{
  const treeHost = new Element("aside");
  const treePanel = new Panel(treeHost);
  const treeEditor = {
    store, registry: snapshot.registry, view,
    page: () => page,
    contexts: [], root: () => page, artboard: () => ({ w: 1408, h: 792 }),
    enterComponent: () => undefined, exitTo: () => undefined, resizePreview: () => undefined,
    diagFor: () => [], diagAt: () => [], diagNode: () => [],
    select: () => undefined, selectPart: () => undefined,
    refresh: () => draw(),
  };
  const draw = () =>
    treePanel.render(leftShape(treeEditor), (host) => renderLeftSidebar(host, treeEditor));
  const keys = () =>
    treeHost.querySelectorAll(".layer-row").map((r) => r.getAttribute("data-key"));
  const row = () => treeHost.querySelectorAll(".layer-row")
    .find((r) => r.getAttribute("data-key") === "n" + statusFrame.id);
  draw();
  check(keys().includes("n" + statusFrame.id),
        "the Layers tree lists a row for the frame");
  check(!keys().includes("n" + toggleChild.id),
        "and NOT what is inside it: a row starts shut");
  check(row().className.includes("collapsed"), "the caret says so");

  /* an untouched row HOLDING THE SELECTION starts open instead: picking a nested node
     off the stage has to show it here, or the tree lies about where you are */
  view.selection = [toggleChild.id];
  draw();
  check(keys().includes("n" + toggleChild.id),
        "a row holding the selection starts open, and lists the instance inside: ONE " +
        "kind of row, for one kind of node");
  view.selection = [];
  draw();
  check(!keys().includes("n" + toggleChild.id), "and shuts again when it does not");

  /* the caret is the row's first child and owns its own click, so folding never selects */
  fire(row().children[0], "click");
  check(keys().includes("n" + toggleChild.id), "the caret opens it by hand");
  fire(row().children[0], "click");
  check(!keys().includes("n" + toggleChild.id), "and shuts it again");
  /* and that hand-made fold now WINS over the selection default: it was closed on purpose */
  view.selection = [toggleChild.id];
  draw();
  check(!keys().includes("n" + toggleChild.id),
        "a row closed by hand stays closed even when the selection moves inside it");
  view.selection = [];
  draw();
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
/* the four panes, and the freshly appended Readout beside them */
check(store.pages()[0].children.length === 5, "the insert reached the mirror");

const unfed = store.pages()[0].children[4];
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

/* ---- a doc component's nodes compile into node_attrs too: THE ENTERED INSTANCE's other
   half. Same programs the served template carries, keyed by the nodes' own document ids,
   which is what lets the stage render a component context through the page's own path.
   The insert changes the registry, so a fresh snapshot follows the echo; its node_attrs
   must know the new ids. */
ws.send(JSON.stringify({
  type: "apply_ops",
  base_version: store.version(),
  ops: [{
    op: "insert", parent: 0, list: "components",
    node: {
      name: "Pill",
      locals: [{ name: "text", type: "text", init: "go", group: "appearance", public: true }],
      attrs: { surface: "'#222222'" },
      children: [
        { kind: "frame", name: "body",
          attrs: { left: "0.1", top: "0.1", w: "0.8", h: "0.8" },
          children: [{ kind: "text", name: "label", attrs: { text: "text" } }] },
      ],
      behavior: [],
    },
  }],
}));
const compEcho = await next("ops_applied");
store.apply(compEcho.version, compEcho.ops);
const pill = store.components().find((c) => c.name === "Pill");
check(!!pill && typeof pill.id === "number", "the component insert echoed with issued ids");
/* earlier edits queued their own snapshots (they moved node_attrs too): drain to the
   one that knows the fresh component */
let refreshed = await next("snapshot");
while (!refreshed.node_attrs?.[String(pill.id)]) refreshed = await next("snapshot");
const pillBody = pill.children[0];
check((refreshed.node_attrs?.[String(pill.id)]?.attrs?.surface?.code?.length ?? 0) > 0,
      "a doc component's ROOT compiles into node_attrs under its own id");
check(refreshed.node_attrs?.[String(pillBody.id)]?.attrs?.left?.code?.[0]?.op === "CONST",
      "and its internal nodes too: an entered instance renders through the page's path");
check(refreshed.node_attrs?.[String(pillBody.children[0].id)]?.attrs?.text?.code?.[0]?.op
        === "LOAD",
      "a prop reference compiles to the same cell load the template serves");

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
const readout = store.pages()[0].children[4];
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
  contexts: [],
  root() { return this.page(); },
  artboard: () => ({ w: 1408, h: 792 }),
  enterComponent: () => undefined,
  exitTo: () => undefined,
  resizePreview: () => undefined,
  selectedNode: () => store.nodeAt(readout.id), selectedInstance: () => store.instance(readout.id),
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
/* These checks drive two ordinary NUMBER SLOTS (radius and border_w, base frame slots
   every type carries). Nothing about what is being proved depends on which two: these are
   reconciliation rules — same node, new value, no rebuild; focus found by document
   address rather than tree position — and they need any two standing numeric controls.
   Each echo spreads the CURRENT slots so an earlier check's write survives.
   PHASE 4a: a slot row is chassis + value box now (`.attr-row.slot-row`, the box's one
   text input inside), so these helpers address that anatomy — the rules are unchanged. */
const slotRowIn = (host, name) =>
  host.querySelectorAll(".attr-row.slot-row")
    .find((row) => row.querySelector(".attr-name")?.textContent === name) ?? null;
const slotInput = (name) => slotRowIn(sidebar, name)?.querySelector("input") ?? null;
const slotsNow = () => store.instance(readout.id).slots ?? {};
const echoSlot = (name, value) =>
  echo([{ op: "set_prop", node: readout.id, key: "slots",
          value: { ...slotsNow(), [name]: value } }]);

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
const valueInput = slotInput("value");
const authored = valueInput.value;
editor.live = { epoch: 2, values: { [readout.id + ".value"]: 99.5 } };
draw();
check(slotInput("value") === valueInput, "a live frame does not rebuild the slot editor");
check(
  valueInput.value === authored,
  "an unfed slot's field ignores the runtime cell, got " + valueInput.value,
);
echo([{ op: "set_prop", node: readout.id, key: "slots", value: { value: 5.5, decimals: 0 } }]);
check(valueInput.value === "5.5", "an unfed slot's field follows the document, got " + valueInput.value);

/* 4. a BOUND slot's authored value IS an expression (spec D1): the box edits that
      text, and a live frame never rebuilds it — the expression is document truth, the
      cell's value is the backend's. The bound/driven cell states died with the old
      slot cells (phase 4a): a slot holding a non-literal expression shows exactly like
      an attr holding one — the icon dims for gestures. The seeded Readout "Flow"
      binds `value` to flow.round(1). */
const fedInstance = store.instancesOn(store.pages()[0]).find(
  (w) => typeof (w.slots ?? {}).value === "string" && w.type === "Readout");
const fedPanel = new Panel(new Element("aside"));
const fedEditor = { ...editor, selectedNode: () => store.nodeAt(fedInstance.id), selectedInstance: () => store.instance(fedInstance.id) };
const drawFed = () =>
  fedPanel.render(inspectorShape(fedEditor), (host) => renderInspector(host, fedEditor));
fedEditor.live = { epoch: 3, values: {} };
drawFed();
const fedRow = slotRowIn(fedPanel.host, "value");
check(fedRow !== null && fedRow.querySelector(".value-box") !== null,
      "a bound slot's row is an ordinary value box");
check(fedRow.querySelector(".vb-icon").classList.contains("vb-dim"),
      "a slot holding a non-literal expression dims the icon, exactly like an attr");
const fedInput = fedRow.querySelector("input");
check(fedInput.value === "flow.round(1)",
      "a bound slot's box shows the authored expression, got " + fedInput.value);
fedEditor.live = { epoch: 4, values: { [fedInstance.id + ".value"]: 4.25 } };
drawFed();
check(fedRow.querySelector("input") === fedInput,
      "a live frame does not rebuild a bound slot's box");
check(fedInput.value === "flow.round(1)",
      "a live frame never overwrites the authored expression, got " + fedInput.value);

/* 4. uncommitted text is held under the document address, so a rebuild caused by an edit
      somewhere else gives it back, and focus follows the key rather than the tree position */
const labelField = sidebar.querySelector(".inspector-head").children[0];
typeInto(labelField, "half typed");
echo([
  {
    op: "insert",
    parent: readout.id,
    list: "locals",
    node: { id: 9001, name: "tmp", type: "num", init: 0, persist: false },
  },
]);
const rebuiltLabel = sidebar.querySelector(".inspector-head").children[0];
check(rebuiltLabel !== labelField, "a structural edit does rebuild the inspector");
check(rebuiltLabel.value === "half typed", "uncommitted text survives it, got " + rebuiltLabel.value);
check(document.activeElement === rebuiltLabel, "focus lands on the same control by key");
fire(rebuiltLabel, "change");

/* 5. an insert that puts controls ABOVE the focused one must not redirect focus into a
      different control, which is exactly what a numeric DOM path would do */
const heightField = slotInput("border_w");
heightField.focus();
echo([
  {
    op: "insert",
    parent: readout.id,
    list: "locals",
    node: { id: 9002, name: "tmp2", type: "num", init: 0, persist: false },
  },
]);
check(slotInput("border_w") !== heightField, "the second insert rebuilt the inspector");
check(document.activeElement === slotInput("border_w"),
      "focus follows the key past inserted controls");
check(
  document.activeElement.closest(".value-box") !== null,
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
    node: { id: 9003, name: "tmp3", type: "num", init: 0, persist: false },
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

/* ---- DISPLAY-TIER LISTS: the opcode family a list expression compiles to ----
   A list is an ordinary value on the stack, and a Nil ELEMENT is a value the list HOLDS --
   a plot's missing sample is a gap in the picture, not an unknown picture -- while every
   question ABOUT a list that has no honest answer is still Nil. The aggregates are pinned
   to the scalar VM's own (backend/src/vm/vm.cpp, MethodId::ListSum and friends): an empty
   list sums to 0 and avg/max/min to Nil, and one element that is not a number takes the
   whole aggregate to Nil rather than averaging over the samples around a gap. */
{
  const nothing = () => null;
  const vm = (...code) => run({ code }, nothing);
  const lit = (v) => ({ op: "CONST", v });
  const json = (v) => JSON.stringify(v);
  const arg = (i) => ({ op: "ARG", i });
  const over = (mode, body) => ({ op: "ITERATE", mode, body });

  check(json(vm(lit(1), lit(2), lit(3), { op: "MAKE_LIST", n: 3 })) === "[1,2,3]",
        "MAKE_LIST takes its values in the order they were pushed");
  check(json(vm(lit(1), lit(null), lit(3), { op: "MAKE_LIST", n: 3 })) === "[1,null,3]",
        "and a Nil element stays put: a gap does not poison the list holding it");

  const three = [lit(10), lit(20), lit(30), { op: "MAKE_LIST", n: 3 }];
  check(vm(...three, lit(1), { op: "INDEX" }) === 20, "INDEX reads the element it names");
  check(vm(...three, lit(3), { op: "INDEX" }) === null, "past the end is Nil, never a wrap");
  check(vm(...three, lit(-1), { op: "INDEX" }) === null, "and so is a negative index");
  check(vm(...three, lit(1.5), { op: "INDEX" }) === null,
        "a fractional index names no element, so it is Nil rather than truncated");
  check(vm(lit(7), lit(0), { op: "INDEX" }) === null, "and indexing a non-list is Nil");

  check(vm(lit("abc"), { op: "LENGTH" }) === 3, "LENGTH counts a string's characters");
  check(vm(...three, { op: "LENGTH" }) === 3, "and a list's elements");
  check(vm(lit(5), { op: "LENGTH" }) === null, "a number has no length: Nil");

  /* A ROW IS AN ORDINARY ELEMENT. A nested cell arrives with its rows whole inside the
     `values` array (backend/src/app.cpp, wire_element), so reading one is INDEX twice and
     counting one is LENGTH on what the first INDEX gave back — a multi-series plot is
     `history[i][series]` and nothing else. */
  const rows = [lit([1, 2]), lit([3]), { op: "MAKE_LIST", n: 2 }];
  check(vm(...rows, lit(0), { op: "INDEX" }, lit(1), { op: "INDEX" }) === 2,
        "indexing a row reaches the leaf");
  check(vm(...rows, lit(0), { op: "INDEX" }, { op: "LENGTH" }) === 2,
        "and LENGTH over a row counts its leaves — the series count a repeat reads");
  check(vm(...rows, lit(1), { op: "INDEX" }, lit(1), { op: "INDEX" }) === null,
        "a leaf a shorter row does not have is Nil, not a wrap into the next row");
  const keyed = [lit({ a: 1 }), { op: "MAKE_LIST", n: 1 }];
  check(vm(...keyed, lit(0), { op: "INDEX" }, lit("a"), { op: "INDEX" }) === 1,
        "a MAP row reads by key the same way");

  const names = [lit("a"), lit("b"), { op: "MAKE_LIST", n: 2 }];
  check(vm(...names, lit("b"), { op: "INDEX_OF" }) === 1, "INDEX_OF finds the first match");
  check(vm(...names, lit("z"), { op: "INDEX_OF" }) === -1,
        "a miss is -1, the scalar VM's own answer");
  check(vm(...names, lit(null), { op: "INDEX_OF" }) === -1,
        "and a Nil needle matches nothing at all");
  check(vm(lit("ab"), lit("a"), { op: "INDEX_OF" }) === null, "INDEX_OF on a non-list is Nil");

  const nums = [lit(1), lit(2), lit(6), { op: "MAKE_LIST", n: 3 }];
  const gap = [lit(1), lit(null), lit(6), { op: "MAKE_LIST", n: 3 }];
  const empty = [{ op: "MAKE_LIST", n: 0 }];
  check(vm(...nums, { op: "LIST_SUM" }) === 9 && vm(...nums, { op: "LIST_AVG" }) === 3,
        "LIST_SUM and LIST_AVG over the elements");
  check(vm(...nums, { op: "LIST_MAX" }) === 6 && vm(...nums, { op: "LIST_MIN" }) === 1,
        "LIST_MAX and LIST_MIN too");
  check(vm(...empty, { op: "LIST_SUM" }) === 0,
        "an EMPTY list sums to 0 -- the VM's own answer, not Nil");
  check(vm(...empty, { op: "LIST_AVG" }) === null && vm(...empty, { op: "LIST_MAX" }) === null &&
          vm(...empty, { op: "LIST_MIN" }) === null,
        "while its average, maximum and minimum are Nil: there is nothing to report");
  check(vm(...gap, { op: "LIST_SUM" }) === null && vm(...gap, { op: "LIST_AVG" }) === null &&
          vm(...gap, { op: "LIST_MAX" }) === null && vm(...gap, { op: "LIST_MIN" }) === null,
        "one gap takes the whole aggregate to Nil, again matching the VM");
  check(vm(lit(3), { op: "LIST_SUM" }) === null, "and a non-list aggregates to Nil");

  check(json(vm(lit(0.5), lit(0.25), { op: "ANCHOR" })) === '{"x":0.5,"y":0.25}',
        "ANCHOR builds a point from x then y");
  check(vm(lit(0.5), lit(null), { op: "ANCHOR" }) === null,
        "a missing coordinate makes the whole anchor a gap");

  /* ITERATE: one loop, one body, the mode saying what to do with what the body returned.
     ARG 0 is the element and ARG 1 its index -- for REDUCE, ARG 0 is the accumulator and
     the pair shifts up one. */
  check(json(vm(...three, over("MAP", [arg(0), arg(1), { op: "ADD" }]))) === "[10,21,32]",
        "MAP runs the body per element, with the index beside it");
  check(json(vm(lit(1), lit(null), lit(2), lit(6), { op: "MAKE_LIST", n: 4 },
                over("FILTER", [arg(0), lit(2), { op: "GE" }]))) === "[2,6]",
        "FILTER keeps what the body called true, and a Nil answer is not true");
  check(vm(lit(0), lit(1), { op: "MAKE_LIST", n: 2 }, over("ANY", [arg(0)])) === true &&
          vm(lit(0), lit(1), { op: "MAKE_LIST", n: 2 }, over("ALL", [arg(0)])) === false,
        "ANY and ALL answer over the same body");
  check(vm(...empty, over("ANY", [arg(0)])) === false &&
          vm(...empty, over("ALL", [arg(0)])) === true,
        "and an empty list answers ANY false, ALL true");
  check(json(vm(lit(3), lit(1), lit(4), lit(1), lit(5), { op: "MAKE_LIST", n: 5 },
                over("SORT_BY", [arg(0), lit(2), { op: "MOD" }]))) === "[4,3,1,1,5]",
        "SORT_BY moves the ELEMENTS by the body's key, and equal keys keep their order");
  check(json(vm(lit(1), lit(2), lit(3), { op: "MAKE_LIST", n: 3 },
                over("SORT_BY", [arg(0), lit(2), { op: "EQ" }, lit(null), arg(0),
                                 { op: "PICK" }]))) === "[1,3,2]",
        "a key with no order to it sorts last, so an UNKNOWN never leads the list");
  check(vm(lit(1), lit(2), lit(3), { op: "MAKE_LIST", n: 3 }, lit(0),
           over("REDUCE", [arg(0), arg(1), { op: "ADD" }])) === 6,
        "REDUCE folds the list into its accumulator");
  check(vm(...empty, lit(7), over("REDUCE", [arg(0), arg(1), { op: "ADD" }])) === 7,
        "over an empty list it is the seed it started from");
  check(vm(lit("a"), lit("b"), { op: "MAKE_LIST", n: 2 }, lit(""),
           over("REDUCE", [arg(0), arg(1), { op: "ADD" }])) === "ab",
        "and it builds text as readily as a number, since + concatenates");
  check(vm(lit(5), over("MAP", [arg(0)])) === null, "iterating a non-list is Nil");
  check(vm(...three, { op: "ITERATE", mode: "WAT", body: [arg(0)] }) === null,
        "and a mode this view does not know fails as UNKNOWN");

  /* the loop is BOUNDED, but by a FRAME's worth of work rather than by a cell's length: a
     retained list is bounded in bytes now, so a long history walks in full and only a
     picture no screen could draw stops short */
  const long = vm(lit(Array.from({ length: 5000 }, (_, i) => i)), over("MAP", [arg(0)]));
  check(Array.isArray(long) && long.length === 5000,
        "a five-thousand-sample history maps whole, got " + (long ?? []).length);
  const huge = vm(lit(Array.from({ length: 70000 }, (_, i) => i)), over("MAP", [arg(0)]));
  check(Array.isArray(huge) && huge.length === 65536,
        "and the frame budget still stops somewhere, got " + (huge ?? []).length);

  /* A MAP takes the same vocabulary where it has an honest answer: LENGTH counts its
     pairs, INDEX looks a text key up, and REDUCE walks (acc, key, value) per SORTED key
     -- the same deterministic order the backend iterates in, so every view folds the
     same answer. The other loops have no settled result shape over a map: Nil. */
  const modes = lit({ low: 1, high: 2 });
  check(vm(modes, { op: "LENGTH" }) === 2, "LENGTH counts a map's pairs");
  check(vm(modes, lit("high"), { op: "INDEX" }) === 2, "INDEX reads the key it names");
  check(vm(modes, lit("off"), { op: "INDEX" }) === null, "an absent key is Nil");
  check(vm(modes, lit(0), { op: "INDEX" }) === null, "and a map takes no numeric index");
  check(vm(modes, lit(""),
           over("REDUCE", [arg(0), arg(1), { op: "ADD" }, arg(2), { op: "ADD" }])) ===
          "high2low1",
        "REDUCE walks a map as (acc, key, value), per sorted key");
  check(vm(modes, over("MAP", [arg(0)])) === null,
        "while the other loops refuse a map as UNKNOWN");
}

/* ---- default behavior and diagnostics ----
   A control has to work the moment it is placed, and the view has to be able to say why
   when it does not. Both are served as data: the type's `behavior` flows, and the compile
   findings the snapshot carries. */

const toggleType = snapshot.registry.components.find((type) => type.name === "Toggle");
check(
  (toggleType.behavior ?? []).length === 1,
  "the Toggle ships one default flow, got " + (toggleType.behavior ?? []).length,
);
check(
  toggleType.behavior[0].do[1].to?.slot === "value",
  "and it writes the instance's own slot, not a variable",
);
/* the toggle's LOGIC is visible behavior now: propose the inverse, echo it, SPEAK it —
   no derivation machinery, no x smuggling */
check(
  toggleType.behavior[0].do[0].from?.expr === "!this.value",
  "the Toggle's inverse is stated in its behavior, got " +
    toggleType.behavior[0].do[0].from?.expr,
);
check(
  toggleType.behavior[0].do[2].kind === "raise" &&
    toggleType.behavior[0].do[2].event === "changed",
  "and the tap RAISES changed, got " + JSON.stringify(toggleType.behavior[0].do[2]),
);
check(
  toggleType.events.length === 1 &&
    toggleType.events[0].name === "changed" &&
    toggleType.events[0].params?.[0]?.name === "value" &&
    toggleType.events[0].params?.[0]?.shape === "bool",
  "a discrete control declares exactly changed(value) — gesture events are never rows",
);
const sliderEvents = snapshot.registry.components.find((t) => t.name === "Slider").events;
check(
  sliderEvents.map((e) => e.name).join(",") === "changing,changed" &&
    sliderEvents.every((e) => e.params?.[0]?.name === "value" &&
                              e.params?.[0]?.shape === "num"),
  "a continuous control declares the PAIR, got " +
    sliderEvents.map((e) => e.name).join(","),
);
check(
  (snapshot.registry.components.find((t) => t.name === "Button").behavior ?? []).length === 0,
  "a Button owns no value, so it ships no default",
);
check(Array.isArray(snapshot.diag?.compile), "the snapshot carries the compile findings");

/* the type's defaults are the control working as expected, so the inspector does not
   list them: the Behavior section holds only what this instance authors */
const toggle = store.instancesOn(store.pages()[0]).find((w) => w.type === "Toggle");
const togglePanel = new Panel(new Element("aside"));
const toggleEditor = { ...editor, selectedNode: () => store.nodeAt(toggle.id), selectedInstance: () => store.instance(toggle.id) };
togglePanel.render(inspectorShape(toggleEditor), (host) => renderInspector(host, toggleEditor));
check(
  togglePanel.host.querySelectorAll(".default-flow").length === 0,
  "the inspector does not list the type's default flow",
);

/* PHASE 4a: the driven display state is gone with the old slot cells. The value box
   shows the DOCUMENT truth always — the authored text is what you edit; what the
   runtime currently holds is the preview/provenance story, not the field's. So a
   runtime-written slot's box keeps showing where the cell STARTED, and no bound or
   driven cell class exists anywhere in the inspector. */
const liveToggleEditor = {
  ...toggleEditor,
  /* the document seeds this toggle ON; the runtime has since been toggled OFF */
  live: { epoch: 5, values: { [toggle.id + ".value"]: false } },
};
const livePanel = new Panel(new Element("aside"));
livePanel.render(inspectorShape(liveToggleEditor), (host) =>
  renderInspector(host, liveToggleEditor),
);
const valueRow = slotRowIn(livePanel.host, "value");
check(valueRow !== null, "the toggle's value row exists");
check(valueRow.querySelector("input").value === "true",
      "the box shows the authored start, the document truth, got " +
        valueRow.querySelector("input").value);
check(livePanel.host.querySelectorAll(".value-cell.driven").length === 0 &&
        livePanel.host.querySelectorAll(".value-cell.bound").length === 0,
      "the bound/driven cell states are gone — the box's own states replace them");
check(
  store.instance(toggle.id).slots.value === true,
  "while the document still holds the value the runtime started from",
);

/* the Readout above is the other half of the rule, and still holds: nothing writes its
   value, so its field shows the document and typing into it is never fought */

/* a finding lands as a mark on the row it names, not in a list: one addressed to the
   instance itself sits on the head, one narrowed to a slot sits on that slot's label */
const findingRows = [
  { node: toggle.id, grade: "error", code: "component_type", message: "unknown type" },
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
  "an instance-level error marks the inspector head",
);
/* the dot OUTSIDE any box: it renders in the head, wears the .icon-btn square
   (dress only) and still opens its popover on hover */
const headDot = findingHead.querySelector(".diag-dot.error");
check(headDot.classList.contains("icon-btn") &&
      !headDot.classList.contains("icon-mark"),
      "a head dot wears .icon-btn like the box's tail cells");
fire(headDot, "mouseenter");
const headPop = document.body.children.find((n) =>
  (n.className ?? "").includes("diag-pop")) ?? null;
check(headPop !== null && headPop.textContent.includes("unknown type"),
      "a dot outside any box still opens its findings popover on hover");
fire(headDot, "mouseleave");
const findingValueRow = slotRowIn(findingPanel.host, "value");
check(
  findingValueRow !== null &&
    findingValueRow.querySelectorAll(".diag-dot.error").length === 1,
  "a slot-level error marks the slot's own row",
);

/* a finding inside a flow is addressed to the STEP, so it traces to the exact line; a
   collapsed card cannot show that line yet, so its head carries the rollup */
const reset = store.instancesOn(store.pages()[0]).find((w) => w.name === "Reset");
const stepId = reset.flows[0].do[0].id;
const stepRows = [{ node: stepId, grade: "error", code: "expression", message: "unknown name" }];
const stepEditor = {
  ...editor,
  selectedNode: () => store.nodeAt(reset.id), selectedInstance: () => store.instance(reset.id),
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

/* a slot expression's finding pins to the INSTANCE's slot row: node = the instance,
   `where` = the slot address, and the row's label wears the dot */
const readoutW = store.instancesOn(store.pages()[0]).find((w) => w.type === "Readout");
const feedRows = [
  { node: readoutW.id, grade: "error", code: "expression",
    message: "unknown name 'flow'", where: "value" },
];
const feedEditor = {
  ...editor,
  selectedNode: () => store.nodeAt(readoutW.id), selectedInstance: () => store.instance(readoutW.id),
  diagFor: () => feedRows,
  diagAt: (node, where) =>
    feedRows.filter((d) => d.node === node && (d.where ?? "") === (where ?? "")),
  diagNode: (node) => feedRows.filter((d) => d.node === node),
};
const feedPanel2 = new Panel(new Element("aside"));
feedPanel2.render(inspectorShape(feedEditor), (host) => renderInspector(host, feedEditor));
const exprFindingRow = slotRowIn(feedPanel2.host, "value");
check(
  exprFindingRow !== null &&
    exprFindingRow.querySelectorAll(".diag-dot.error").length === 1,
  "a slot expression finding marks the slot's own row",
);

/* ...and the finding already NAMES the instance, so the Layers badge walk holds with no
   feed node between them */
check(
  leftShape({
    ...editor,
    diagFor: (w) => feedRows.filter((d) => store.owningInstance(d.node) === w),
  }).includes(readoutW.id + ":expression:"),
  "a slot finding attributes to its instance, so the Layers row badge exists",
);

/* ---- the Layers tree, element selection and the element-scoped inspector ----
   The left sidebar's tree lists the CURRENT page's instances and each instance's named
   template elements from the REGISTRY type (all of them, rendered or not); pages live in
   the topbar selector, not here. Selecting an element scopes the inspector to exactly the
   slots the element's subtree consumes, and the overlay rings the element where the last
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
check(rowByKey("n" + toggle.id) === null,
      "the tree starts shut, so a nested instance has no row of its own yet");
/* SELECTING one is how it is reached: an untouched row holding the selection starts open,
   all the way down, which is what makes clicking a node on the stage show it here */
view.selection = [toggle.id];
drawLeft();
const toggleRow = rowByKey("n" + toggle.id);
check(toggleRow !== null, "the Layers tree lists the current page's instances");
check(left.querySelectorAll(".layer-row.page").length === 0, "the Layers tree has no page rows");
check(rowByKey("p" + page.id) === null, "not even the current page's");
/* an instance row is a LEAF here now: its elements belong to the component that defines them,
   so they are listed by the Design tree and no longer expand out of this one */
check(rowByKey("n" + toggle.id + "/pill.knob") === null,
      "an instance's elements are not listed in the Layers tree");
check(rowByKey("n" + slider.id + "/scale") === null, "not even an element hidden by `show`");

/* a selected element scopes the inspector: instance › element head, ONE section, and only the
   properties that element OWNS — not its siblings', not its children's, not the instance's */
const toggleEditor2 = { ...editor, selectedNode: () => store.nodeAt(toggle.id), selectedInstance: () => store.instance(toggle.id) };
view.selection = [toggle.id];
view.element = "pill.knob";
const instanceShape = (() => { view.element = ""; const s = inspectorShape(toggleEditor2); view.element = "pill.knob"; return s; })();
check(inspectorShape(toggleEditor2) !== instanceShape, "the selected element moves the inspector's shape");
const elementPanel = new Panel(new Element("aside"));
elementPanel.render(inspectorShape(toggleEditor2), (host) => renderInspector(host, toggleEditor2));
const elementLabels = elementPanel.host.querySelectorAll(".attr-row.slot-row")
  .map((row) => row.querySelector(".attr-name")?.textContent);
check(elementLabels.includes("handle_color"),
      "the element view lists the property that element owns");
check(!elementLabels.includes("fill_color") && !elementLabels.includes("track_color"),
      "and not its siblings' slots, got " + elementLabels.join(","));
check(elementPanel.host.querySelector(".geom-grid") === null,
      "the element view carries no Panel/placement section");
check(elementPanel.host.querySelector(".element-name")?.textContent === "knob",
      "the head names the element");

/* ...and the INSTANCE view is the other half of the same rule: a property an element owns is
   editable there and NOWHERE else, so the instance's own inspector holds only its own
   (its value, its frame, its placement) */
view.element = "";
const instancePanel = new Panel(new Element("aside"));
instancePanel.render(inspectorShape(toggleEditor2), (host) => renderInspector(host, toggleEditor2));
const instanceLabels = instancePanel.host.querySelectorAll(".attr-row.slot-row")
  .map((row) => row.querySelector(".attr-name")?.textContent);
check(!instanceLabels.includes("handle_color") && !instanceLabels.includes("fill_color"),
      "the instance view shows no property an element owns, got " + instanceLabels.join(","));
check(instanceLabels.includes("surface"), "and keeps the instance's own frame slots");
/* PLACE IS NOT A SLOT and not a prop: an instance is a node, so its box on the artboard
   is the same attr row a plain box gets, through the same commit */
const instanceAttrNames = instancePanel.host.querySelectorAll(".attr-row")
  .filter((row) => !row.classList.contains("slot-row"))
  .map((row) => row.querySelector(".attr-name")?.textContent);
check(instanceAttrNames.includes("left") && instanceAttrNames.includes("w"),
      "the instance view places the instance, got " + instanceAttrNames.join(","));
{
  /* EVERY element carries its own `shown` switch, so an element is turned off by selecting it
     — and the edit writes NESTED, under the element that owns it. The switch is the bool
     box now: committing `false` stores the raw bool at the element's address. */
  check(elementLabels.includes("shown"), "an element can be switched off from its own view");
  const applied = [];
  const nested = { ...toggleEditor2, apply: (ops) => applied.push(...ops) };
  view.element = "pill.knob";
  const editPanel = new Panel(new Element("aside"));
  editPanel.render(inspectorShape(nested), (host) => renderInspector(host, nested));
  const shownRow = slotRowIn(editPanel.host, "shown");
  check(shownRow !== null, "the knob's own view carries its shown switch");
  const shownInput = shownRow.querySelector("input");
  typeInto(shownInput, "false");
  fire(shownInput, "change");
  const slotOp = applied.find((op) => op.key === "slots");
  check(slotOp && slotOp.value?.pill?.knob?.shown === false,
        "an element's edit writes nested under its element, got " + JSON.stringify(slotOp?.value));
  check(slotOp && slotOp.value.shown === undefined,
        "and never at the instance's top level");
  view.element = "";
}

view.selection = [];
view.element = "";

/* ---- the Components section: browse built-ins, edit doc components ----
   Below Layers, the left sidebar lists the document's components (their ELEMENT trees,
   real doc nodes) and then the built-ins not shadowed by one, browsable from the
   served doc form and carrying a fork affordance. Selecting an element node scopes the
   inspector to that node's attrs, and a component compile finding (addressed to the
   element node, where = the attr) pins to the attr's own row. */

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
check(builtinToggleRow.querySelectorAll(".layer-menu")[0].tagName === "BUTTON",
      "the kebab is a real button of the shared .icon-btn family");
check(builtinToggleRow.className.includes("builtin"), "and is marked read-only");
fire(builtinToggleRow.children[0], "click");
drawDesign();
/* a built-in is not in the document, so its rows are addressed by name + CHILD-INDEX
   path ("0" is the root element, "0.0.0" the track inside its pill) rather than node id */
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
      "a built-in row browses it by name and element path, got " + JSON.stringify(browsed));

/* the inspector then shows that element's definition, read-only: no field commits, and
   the ADDRESS row says what its properties are called from the outside (spec 2.3) */
const trackEditor = {
  ...editor,
  selectedNode: () => null,
  selectedInstance: () => null,
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
      locals: [
        { id: 9201, name: "tint", type: "color", init: "#ff0000", group: "appearance",
          public: true },
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
check(designRow("c9200/9210") !== null, "an expanded component lists its element nodes");
check(designRow("c9200/9211") !== null, "nested nodes too (frames default open)");

/* selecting the component edits the TYPE: name field and the variables it declares */
const lampEditor = {
  ...editor,
  selectedNode: () => null,
  selectedInstance: () => null,
  componentSel: { component: 9200, node: 9200 },
};
const lampPanel = new Panel(new Element("aside"));
lampPanel.render(designInspectorShape(lampEditor), (host) => renderDesignInspector(host, lampEditor));
check(lampPanel.host.querySelector(".inspector-head").children[0].value === "Lamp",
      "a selected component's head edits its name");
/* ONE CARD PER VARIABLE, and a public one says so on its head: a property is not a row
   of its own kind any more, it is a variable the component offers */
const lampCards = lampPanel.host.querySelectorAll(".card");
check(
  lampCards.length === 1 &&
    lampCards[0].querySelectorAll("input").some((i) => i.value === "tint"),
  "the component's variables are listed as cards",
);
check(lampCards[0].textContent.includes("input"),
      "and a public one is marked as the instance's input");

/* selecting an element edits its attrs: the CLOSED vocabulary (spec 2.3) lists every attr
   the "text" kind declares — own attrs first, then the common set — set or not, not
   just the one this "label" element happens to author */
const labelEditor = { ...lampEditor, componentSel: { component: 9200, node: 9211 } };
const labelPanel = new Panel(new Element("aside"));
check(designInspectorShape(labelEditor) !== designInspectorShape(lampEditor),
      "the selected element node moves the inspector's shape");
labelPanel.render(designInspectorShape(labelEditor), (host) => renderDesignInspector(host, labelEditor));
/* EVERY attr the kind declares, and exactly ONE of the two placement vocabularies: the
   parent decides which, so offering both would be offering a field that does nothing half
   the time — which is the sort of dead row this table exists to prevent */
const attrRows = labelPanel.host.querySelectorAll(".attr-row");
const MEASURED = ["left", "top", "right", "bottom", "w", "h",
                  "min_w", "max_w", "min_h", "max_h", "origin_x", "origin_y", "rotate"];
const ARRANGED = ["grow", "min"];
const textVocabCount = editor.attrTable.perKind.text.length +
  editor.attrTable.common.filter((a) => !ARRANGED.includes(a.name)).length;
check(attrRows.length === textVocabCount,
      "the element view lists the kind's attrs and the placement half that applies, got " +
        attrRows.length + " expected " + textVocabCount);
const attrNamed = (rows, name) =>
  rows.find((row) => row.querySelector(".attr-name")?.textContent === name);
check(MEASURED.every((name) => attrNamed(attrRows, name) !== undefined),
      "a child of a FREE frame places itself: the box fields are offered");
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
  /* the row's buttons grew with the value box (icon, browse) — what this pins is the
     DELETE, not a count */
  check([...strayRow.querySelectorAll("button")]
          .some((b) => (b.getAttribute("title") ?? "").startsWith("remove")),
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

/* THERE IS NO OPEN KIND ANY MORE: `code` elements are gone, so every attr on every node is
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

/* a component finding is addressed to the element node, where = the attr: it pins to
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
/* the dot rides INSIDE the value box now (value metadata, the browse precedent),
   in the tail OVERLAY — one absolute container, so a hover reveal never reflows */
const diagTailBox = diagAttrRow.querySelector(".value-box")
  ?.querySelector(".vb-tail-box") ?? null;
check(diagTailBox !== null, "the box's tail rides one .vb-tail-box container");
const diagInBox = diagTailBox?.querySelector(".diag-dot.error") ?? null;
check(diagInBox !== null, "and the dot stands inside the tail container");
check(!diagInBox.classList.contains("vb-tail"),
      "the dot is never tagged vb-tail — a finding must not need a hover");
check(diagInBox.classList.contains("icon-btn") &&
      !diagInBox.classList.contains("icon-mark"),
      "the dot wears the .icon-btn square (dress only — it stays a span)");
check(diagTailBox.querySelector(".vb-browse") !== null,
      "the browse button rides the same tail container");
/* rightmost, after every tail button: the hover reveal must never shift it */
const diagBoxKids = diagTailBox.children;
check(diagBoxKids[diagBoxKids.length - 1] === diagInBox,
      "the dot is the tail's LAST cell — buttons reveal to its left");
/* hover still pops the findings: the mark's own mouseenter, wherever it stands */
fire(diagInBox, "mouseenter");
const diagPop = document.body.children.find((n) =>
  (n.className ?? "").includes("diag-pop")) ?? null;
check(diagPop !== null && diagPop.textContent.includes("unknown name 'nope'"),
      "a diag dot inside a box still opens its findings popover on hover");
fire(diagInBox, "mouseleave");

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
      locals: [],
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
   of its consumers, labeled by the instance and slot they arrive through. */

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
/* a slot expression consuming the mesh entity, injected as an echo would deliver it */
store.apply(store.version() + 1, [
  {
    op: "set_prop", node: toggle.id, key: "slots",
    value: { value: "@plant/temp.value" },
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
check(entityUses.length === 1, "where-used finds the one bound consumer, got " + entityUses.length);
check(entityUses[0].textContent.includes("Pump.value"),
      "and names it by instance and slot, got " + entityUses[0].textContent);
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
      "where-used lists the slot expression reading the global");
check(globalUses.some((r) => r.textContent.includes("Reset flow: assign")),
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
      { id: 901, kind: "frame", name: "Pane", type: "", attrs: {}, children: [
          { id: 903, kind: "frame", type: "Panel", name: "Lamp", attrs: {},
            slots: { surface: "#123456" }, locals: [], feeds: [], flows: [] },
          { id: 904, kind: "frame", type: "Label", name: "", attrs: {},
            slots: { text: "hi" }, locals: [], feeds: [], flows: [] },
        ] },
      { id: 902, kind: "frame", name: "Deck", type: "", attrs: {}, children: [
          { id: 905, kind: "frame", type: "Panel", name: "Under", attrs: {},
            slots: {}, locals: [], feeds: [], flows: [] },
        ] },
    ],
  }],
});

/* A PAGE NODE'S FIELDS ARE PROGRAMS, exactly like a component's — the backend compiles
   both with the same compiler, and this is the wire form it serves them in. A literal is
   the degenerate program, which is why one CONST covers most of a page. Page nodes are
   CANVAS PX of the artboard; the instances' internals below them are fractions. */
const prog = (v) => ({ code: [{ op: "CONST", v }] });
const loads = (cell) => ({ code: [{ op: "LOAD", cell }] });
const stageAttrs = {
  "901": { attrs: { left: prog(22), top: prog(22), w: prog(440), h: prog(220),
                    radius: prog(3), surface: loads("theme:accent") } },
  "902": { attrs: { left: prog(484), top: prog(22), w: prog(440), h: prog(220) } },
  "903": { attrs: { left: prog(22), top: prog(22), w: prog(198), h: prog(110) } },
  "904": { attrs: { left: prog(242), top: prog(22), w: prog(176), h: prog(110) } },
  "905": { attrs: {} },
};

const stageHost = new Element("section");
const stageView = { mode: "edit", selection: [], element: "", hover: 0, state: {}, faults: {} };
const stageEditor = {
  store: stageStore,
  registry: snapshot.registry,
  nodeAttrs: stageAttrs,
  live: { epoch: 1, values: {} },
  view: stageView,
  page: () => stageStore.pages()[0],
  contexts: [],
  root() { return this.page(); },
  artboard() { const c = this.contexts[this.contexts.length - 1];
               return c ? { w: c.w, h: c.h } : { w: 1408, h: 792 }; },
  enterComponent: () => undefined,
  exitTo: () => undefined,
  resizePreview: () => undefined,
  select: (ids) => { stageView.selection = ids; },
};
const drawStage = () => renderStage(stageHost, stageEditor);
const stageNode = (cls, id) =>
  stageHost.querySelectorAll("." + cls).find((n) => n.getAttribute("data-id") === String(id)) ?? null;

drawStage();
const stagePage = stageHost.querySelector(".page");
check(stagePage !== null, "the stage renders a page element");
check(stagePage.style.width === "1408px" && stagePage.style.height === "792px",
      "the page is the ARTBOARD: a fixed 1408 x 792 surface the camera scales");
const row = stageNode("frame", 901);
const deck = stageNode("frame", 902);
check(row !== null && deck !== null, "each box is a div carrying its own id");
check(row.parentElement === stagePage && deck.parentElement === stagePage,
      "the page's boxes are its own children");
check(stageNode("leaf", 903)?.parentElement === row, "and a box's instances nest inside it");
/* A PAGE NODE IS CANVAS PX: what is written is what renders, relative to its parent */
check(row.style.position === "absolute" && row.style.left === "22px" &&
        row.style.top === "22px" && row.style.width === "440px" &&
        row.style.height === "220px",
      "a page box sits at its own px, absolutely placed");
check(stageNode("leaf", 903).style.left === "22px" &&
        stageNode("leaf", 903).style.width === "198px",
      "a nested node's px are relative to its parent's origin");
/* a child with nothing said about its box pins to all four edges of its parent */
check(stageNode("leaf", 905).style.position === "absolute" &&
        stageNode("leaf", 905).style.left === "0" &&
        stageNode("leaf", 905).style.right === "0",
      "an unplaced child stretches over its parent");
check(row.style.borderRadius === "3px", "radius reaches the style");

/* ---- EDGE-ANCHORED AXES: `right`/`bottom` pin the far edge and own the size ----
   The browser derives an edge-pinned width itself, which is why the applier only ever
   writes plain CSS edges: left+right stand and width clears; right alone anchors the box
   at `w`; the min/max clamps land as their own properties on every combination. */
const label = stageNode("leaf", 904);
stageAttrs["904"].attrs = { left: prog(242), right: prog(44), top: prog(22),
                            w: prog(176), h: prog(110) };
stageEditor.live = { epoch: 21, values: {} };
drawStage();
check(label.style.left === "242px" && label.style.right === "44px" &&
        label.style.width === "",
      "both edges pin: the width is theirs and `w` goes inert, got width '" +
        label.style.width + "'");
stageAttrs["904"].attrs = { right: prog(44), top: prog(22), w: prog(176), h: prog(110) };
stageEditor.live = { epoch: 22, values: {} };
drawStage();
check(label.style.left === "" && label.style.right === "44px" &&
        label.style.width === "176px",
      "the far edge alone anchors the box right at its own w, got left '" +
        label.style.left + "' right '" + label.style.right + "'");
stageAttrs["904"].attrs = { left: prog(242), top: prog(22), w: prog(176), h: prog(110),
                            min_w: prog(88), max_w: prog(352), max_h: prog(132) };
stageEditor.live = { epoch: 23, values: {} };
drawStage();
check(label.style.minWidth === "88px" && label.style.maxWidth === "352px" &&
        label.style.maxHeight === "132px" && label.style.minHeight === "",
      "the clamps land as their own properties, absent ones cleared, got min '" +
        label.style.minWidth + "'");
/* CLAMPS TRANSFER THROUGH THE RATIO: where aspect derives an axis, that axis's clamps
   fold into the AUTHORED axis's emitted size — converted through the ratio — so the
   ratio holds through them (CSS alone clips the derived axis and breaks the shape) */
stageAttrs["904"].attrs = { left: prog(242), top: prog(22), h: prog(110),
                            aspect: prog(2), max_w: prog(330), min_w: prog(44) };
stageEditor.live = { epoch: 25, values: {} };
drawStage();
check(label.style.height === "max(min(110px, 165px), 22px)" &&
        label.style.width === "" && label.style.aspectRatio === "2",
      "a derived axis's clamps fold into the authored height through the ratio, got '" +
        label.style.height + "'");
stageAttrs["904"].attrs = { left: prog(242), top: prog(22), w: prog(440),
                            aspect: prog(4), max_h: prog(66) };
stageEditor.live = { epoch: 26, values: {} };
drawStage();
check(label.style.width === "min(440px, 264px)" && label.style.height === "",
      "and symmetrically into an authored width, got '" + label.style.width + "'");
stageAttrs["904"].attrs = { left: prog(242), top: prog(22), w: prog(176), h: prog(110) };
stageEditor.live = { epoch: 24, values: {} };
drawStage();
check(label.style.right === "" && label.style.minWidth === "" &&
        label.style.maxWidth === "" && label.style.left === "242px",
      "and every edge and clamp clears when its attr goes — the applier is total");

/* ---- THE DISPLAY TIER READS THE WHOLE UNIVERSE ----
   A page element's attrs name the variables in scope and the mesh, and each arrives as
   ONE published cell read by key: a variable under the `v<id>` the runtime has always
   published it as, a mesh field under the served spelling. Nothing here is a new
   evaluation place — it is the same interpreter over the same programs, finally handed
   the same vocabulary a flow has. An aggregate rides the standing copies (the delta
   lane), which is why the read tries `agg` before `values`. */
const stageAggs = new Map();
stageEditor.agg = (key) => stageAggs.get(key) ?? null;
stageAttrs["904"].attrs = { left: prog(242), top: prog(22), h: prog(110),
                            w: loads("var:510") };
stageEditor.live = { epoch: 30, values: { v510: 300 } };
drawStage();
check(label.style.width === "300px",
      "an attr reads a VARIABLE from its own v<id> cell, got '" + label.style.width + "'");
stageEditor.live = { epoch: 31, values: { v510: 140 } };
drawStage();
check(label.style.width === "140px",
      "and a live frame patches it, got '" + label.style.width + "'");
stageEditor.live = { epoch: 32, values: {} };
drawStage();
check(label.style.width === "",
      "an unpublished variable is honestly Nil, not a stale pixel, got '" +
        label.style.width + "'");
stageAttrs["904"].attrs = { left: prog(242), top: prog(22), h: prog(110),
                            w: loads("mesh:cage/motor.speed") };
stageEditor.live = { epoch: 33, values: { "mesh:cage/motor.speed": 176 } };
drawStage();
check(label.style.width === "176px",
      "an attr reads a MESH FIELD under the served spelling, got '" +
        label.style.width + "'");
/* an AGGREGATE lives in the standing copies, not in `values`: what the fold holds is
   what the program indexes, and what is RECORDED is the copy's version */
stageAggs.set("v520", { version: 1, values: [11, 22, 33] });
stageAttrs["904"].attrs = { left: prog(242), top: prog(22), h: prog(110),
                            w: { code: [{ op: "LOAD", cell: "var:520" }, { op: "LENGTH" }] } };
stageEditor.live = { epoch: 34, values: {} };
drawStage();
check(label.style.width === "3px",
      "a list variable reads from the standing copies the delta lane folds into, got '" +
        label.style.width + "'");
stageAggs.set("v520", { version: 2, values: [11, 22, 33, 44, 55] });
stageEditor.live = { epoch: 35, values: {} };
drawStage();
check(label.style.width === "5px",
      "and its VERSION is what a live frame diffs, got '" + label.style.width + "'");
stageAttrs["904"].attrs = { left: prog(242), top: prog(22), w: prog(176), h: prog(110) };
stageEditor.live = { epoch: 36, values: {} };
drawStage();

/* ---- CLIPPING IS THE `clip` ATTR'S, and nobody else's ----
   Both of these boxes carried `overflow: hidden` from the STYLESHEET once, which made the
   attr unable to say the one thing only it can say: a box whose children draw outside it.
   The applier is written, never cleared, for exactly that reason — "" hands the answer
   back to the cascade. Nothing here is layout: an unclipped box is placed identically. */
check(row.style.overflow === "visible" && stageNode("leaf", 903).style.overflow === "visible",
      "absent = the box does not clip: a frame AND an instance both let children overflow");
const boxBefore = [row.style.left, row.style.top, row.style.width, row.style.height];
stageAttrs["901"].attrs.clip = prog(true);
stageEditor.live = { epoch: 3, values: {} };
drawStage();
check(row.style.overflow === "hidden", "true clips to the box");
check([row.style.left, row.style.top, row.style.width, row.style.height]
        .join() === boxBefore.join(),
      "and moves nothing doing it — clipping is not layout");
stageAttrs["901"].attrs.clip = prog(8);
stageEditor.live = { epoch: 4, values: {} };
drawStage();
check(row.style.overflow === "hidden" && row.style.borderRadius === "8px",
      "a number clips to the box rounded by that radius, outranking `radius`");
stageAttrs["901"].attrs.clip = prog(false);
stageEditor.live = { epoch: 5, values: {} };
drawStage();
check(row.style.overflow === "visible" && row.style.borderRadius === "3px",
      "false clips nothing and hands `radius` back its corners");
delete stageAttrs["901"].attrs.clip;

/* A TEXT CLIPS ITSELF: one line ellipsises what does not fit, which is a clip like any
   other, so the same word turns it off — and `clip` says nothing about wrapping. */
const inkOf = () => stageNode("leaf", 904).querySelector(".ink-text");
stageEditor.live = { epoch: 6, values: {} };
drawStage();
check(inkOf().style.overflow === "hidden" && inkOf().style.textOverflow === "ellipsis",
      "a one-line text ellipsises by default");
stageAttrs["904"].attrs.clip = prog(false);
stageEditor.live = { epoch: 7, values: {} };
drawStage();
check(stageNode("leaf", 904).style.overflow === "visible",
      "clip:false on the instance stops its box clipping");
delete stageAttrs["904"].attrs.clip;

/* ---- A BOX THAT SCROLLS ITS CHILDREN ----
   `scroll` opens the axes and the browser does the scrolling; `scrollbar` and its three
   companions dress the bar it draws, through custom properties, because a scrollbar is
   pseudo-element drawing no inline style can reach (stage.css holds that mechanism). A
   scrolling axis CLIPS — it is a window onto the content — and the marker attribute is what
   the touch allowance and the wheel read, so it is as total as the styles. */
stageAttrs["901"].attrs.scroll = prog("y");
stageEditor.live = { epoch: 71, values: {} };
drawStage();
check(row.style.overflow === "hidden auto",
      "scroll: y scrolls the box down its content and clips across, got '" +
        row.style.overflow + "'");
check(row.getAttribute("data-scroll") === "y",
      "and marks the box with the axes it opened — what the wheel and the touch floor read");
check(row.style["--sb-w"] === "8px",
      "the bar's thickness carries the served default, got '" + row.style["--sb-w"] + "'");
check(row.style["--sb-thumb"] === undefined && row.style["--sb-track"] === undefined,
      "with no colours authored the stylesheet's own neutral bar stands");
stageAttrs["901"].attrs.scrollbar_w = prog(14);
stageAttrs["901"].attrs.scrollbar_color = prog("$accent");
stageAttrs["901"].attrs.scrollbar_track = prog("#00000022");
stageEditor.live = { epoch: 72, values: {} };
drawStage();
check(row.style["--sb-w"] === "14px" && row.style["--sb-thumb"] === "var(--t-accent)" &&
        row.style["--sb-track"] === "#00000022",
      "a themed bar rides the attrs: thickness, thumb (a $token like any colour) and track");
stageAttrs["901"].attrs.scrollbar = prog(false);
stageEditor.live = { epoch: 73, values: {} };
drawStage();
check(row.getAttribute("data-scrollbar") === "off" && row.style.overflow === "hidden auto",
      "scrollbar: false hides the bar and the box still scrolls");
stageAttrs["901"].attrs.scroll = prog("both");
stageEditor.live = { epoch: 74, values: {} };
drawStage();
check(row.style.overflow === "auto",
      "`both` scrolls either way, got '" + row.style.overflow + "'");
stageAttrs["901"].attrs.scroll = prog("x");
stageEditor.live = { epoch: 75, values: {} };
drawStage();
check(row.style.overflow === "auto hidden", "`x` scrolls across and clips down");
/* AN OFFSET AN AXIS NO LONGER SCROLLS is a displaced picture with nothing left to put it
   back: an overflow: hidden box keeps whatever scrollTop it was left holding. */
row.scrollTop = 40;
delete stageAttrs["901"].attrs.scroll;
delete stageAttrs["901"].attrs.scrollbar;
delete stageAttrs["901"].attrs.scrollbar_w;
delete stageAttrs["901"].attrs.scrollbar_color;
delete stageAttrs["901"].attrs.scrollbar_track;
stageEditor.live = { epoch: 76, values: {} };
drawStage();
check(row.style.overflow === "visible" && row.getAttribute("data-scroll") === null &&
        row.getAttribute("data-scrollbar") === null && row.style["--sb-w"] === undefined,
      "the attr leaving takes the overflow, the marker and the bar's properties with it");
check(row.scrollTop === 0, "and the offset it was left holding, which nothing could scroll back");

/* AN ORIGIN ON A STRETCHED AXIS IS A PIVOT AND NOTHING ELSE. Both edges are pinned, so
   there is no placement point to shift back from — and shifting anyway put every built-in
   needle half a dial up and to the left, which only the blanket clip above ever hid. */
stageAttrs["905"].attrs = { origin_x: prog(0.5), origin_y: prog(0.5), rotate: prog(30) };
stageEditor.live = { epoch: 8, values: {} };
drawStage();
const spanned = stageNode("leaf", 905);
check(spanned.style.transform === "rotate(30deg)",
      "a stretched node takes the pivot without the shift, got " + spanned.style.transform);
check(spanned.style.transformOrigin === "50% 50%",
      "and still turns about its own origin, got " + spanned.style.transformOrigin);
/* the same origin on a PLACED axis still shifts: that is what `x` places */
stageAttrs["905"].attrs = { left: prog(40), top: prog(40), w: prog(60), h: prog(60),
                            origin_x: prog(0.5), origin_y: prog(0.5), rotate: prog(30) };
stageEditor.live = { epoch: 9, values: {} };
drawStage();
check(stageNode("leaf", 905).style.transform === "translate(-50%, -50%) rotate(30deg)",
      "a placed node's origin is the point `x` puts down, got " +
        stageNode("leaf", 905).style.transform);
stageAttrs["905"].attrs = {};
stageEditor.live = { epoch: 10, values: {} };
drawStage();

/* ---- THE SHADOW: one authored intent, three mechanisms ----
   A box casts box-shadow (radius, spread and inset all its own); ink casts a FILTER, so
   the shadow follows the glyph or the stroke and not the rectangle around it. And the
   offset is authored in the ARTBOARD's axes: it must not turn when the node does. */
const shadowOn = (id, attrs, epoch) => {
  stageAttrs[String(id)].attrs = { ...stageAttrs[String(id)].attrs, ...attrs };
  stageEditor.live = { epoch, values: {} };
  drawStage();
};

shadowOn(901, { shadow: prog("#000000cc"), shadow_x: prog(2), shadow_y: prog(4),
                shadow_blur: prog(8) }, 11);
check(row.style.boxShadow === "2px 4px 8px 0px #000000cc",
      "a box casts box-shadow, got " + row.style.boxShadow);
shadowOn(901, { shadow_inset: prog(true), shadow_spread: prog(3) }, 12);
check(row.style.boxShadow === "inset 2px 4px 8px 3px #000000cc",
      "with its own inset and spread, got " + row.style.boxShadow);

/* THE OFFSET DOES NOT TURN WITH THE NODE. A quarter turn clockwise makes the element's
   own +x axis point down the screen, so a shadow authored 4px DOWN has to be written 4px
   along local +x for it to land down. */
shadowOn(901, { shadow_inset: prog(false), shadow_spread: prog(0),
                shadow_x: prog(0), shadow_y: prog(4), rotate: prog(90) }, 13);
check(row.style.boxShadow === "4px 0px 8px 0px #000000cc",
      "a rotated box un-turns its shadow so the offset stays put, got " + row.style.boxShadow);
shadowOn(901, { rotate: prog(180) }, 14);
check(row.style.boxShadow === "-0px -4px 8px 0px #000000cc" ||
        row.style.boxShadow === "0px -4px 8px 0px #000000cc",
      "half a turn flips it back the other way, got " + row.style.boxShadow);

/* AND IT COUNTS THE PARENTS TOO: rotation applies to the whole subtree, so a child of a
   turned box is turned as well and its own shadow has to cancel that too. */
shadowOn(901, { rotate: prog(90) }, 15);
shadowOn(903, { shadow: prog("#ff0000"), shadow_x: prog(0), shadow_y: prog(6) }, 16);
check(stageNode("leaf", 903).style.boxShadow === "6px 0px 0px 0px #ff0000",
      "a child of a rotated box un-turns by its PARENT's rotation, got " +
        stageNode("leaf", 903).style.boxShadow);
shadowOn(903, { rotate: prog(-90) }, 17);
check(stageNode("leaf", 903).style.boxShadow === "0px 6px 0px 0px #ff0000",
      "and by the sum when it turns as well — 90 out, 90 back is no turn at all, got " +
        stageNode("leaf", 903).style.boxShadow);
shadowOn(901, { rotate: prog(0), shadow: prog("") }, 18);
shadowOn(903, { rotate: prog(0), shadow: prog("") }, 19);
check(row.style.boxShadow === "" && stageNode("leaf", 903).style.boxShadow === "",
      "and a shadow whose COLOUR went away casts nothing, cleared not zeroed");

/* INK casts a filter. One node, page-level, so its attrs are this rig's to write. */
stageStore.apply(stageStore.version() + 1, [
  { op: "insert", parent: 900, list: "children",
    node: { id: 906, kind: "text", name: "Ink", attrs: {} } },
]);
stageAttrs["906"] = { attrs: { left: prog(22), top: prog(300), w: prog(200), h: prog(30),
                               text: prog("shadowed") } };
stageEditor.live = { epoch: 20, values: {} };
drawStage();
const ink = () => stageNode("ink-text", 906);
check(ink() !== null && ink().style.filter === "", "ink with no shadow carries no filter");
shadowOn(906, { shadow: prog("#00ff00"), shadow_x: prog(1), shadow_y: prog(2),
                shadow_blur: prog(4) }, 21);
check(ink().style.filter === "drop-shadow(1px 2px 4px #00ff00)",
      "ink casts drop-shadow, which follows the glyph and not its box, got " +
        ink().style.filter);
check(ink().style.boxShadow === undefined || ink().style.boxShadow === "",
      "and never a box-shadow: a text has no box worth shadowing");

/* INSET ON INK has no CSS shorthand at all, so it is a real SVG inner-shadow filter */
shadowOn(906, { shadow_inset: prog(true) }, 22);
const filterUrl = ink().style.filter;
check(/^url\(#hmi-shadow-\d+\)$/.test(filterUrl),
      "an inset shadow on ink references a filter of its own, got " + filterUrl);
const filterEl = stageHost.querySelector("filter");
check(filterEl !== null, "which exists, in a defs svg hung off the host");
const prims = filterEl ? filterEl.children : [];
check(prims.length === 6 && prims[0].tagName === "FEOFFSET" &&
        prims[0].getAttribute("dx") === "1" && prims[0].getAttribute("dy") === "2",
      "carrying this node's own offset");
check(prims[1] && prims[1].getAttribute("stdDeviation") === "2",
      "its blur as a deviation (half the CSS radius), got " +
        (prims[1] && prims[1].getAttribute("stdDeviation")));
check(prims[3] && prims[3].style.floodColor === "#00ff00",
      "and its colour as a STYLE, so a $token would resolve, got " +
        (prims[3] && prims[3].style.floodColor));
/* the un-turning reaches the filter too: (1, 2) authored, turned a quarter clockwise, is
   (2, -1) locally — which lands right-and-down again once the element turns */
shadowOn(906, { rotate: prog(90) }, 23);
check(Math.abs(Number(filterEl.children[0].getAttribute("dx")) - 2) < 1e-9 &&
        Math.abs(Number(filterEl.children[0].getAttribute("dy")) + 1) < 1e-9,
      "a turned ink node un-turns its inset offset as well, got " +
        filterEl.children[0].getAttribute("dx") + "," +
        filterEl.children[0].getAttribute("dy"));
/* and the filter goes when the shadow does — nothing is left hanging in the defs */
shadowOn(906, { shadow: prog("") }, 24);
check(ink().style.filter === "" && stageHost.querySelector("filter") === null,
      "clearing the shadow takes the filter with it");

stageAttrs["901"].attrs = { left: prog(22), top: prog(22), w: prog(440), h: prog(220),
                            radius: prog(3), surface: loads("theme:accent") };
stageAttrs["903"].attrs = { left: prog(22), top: prog(22), w: prog(198), h: prog(110) };
stageStore.apply(stageStore.version() + 1, [{ op: "remove", node: 906 }]);
delete stageAttrs["906"];
stageEditor.live = { epoch: 25, values: {} };
drawStage();
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
   frame that moves no cell this picture read runs nothing at all, and one that moves a
   cell PATCHES the element that read it — no element on the artboard is ever replaced */
const heldRow = stageNode("frame", 901);
const heldLamp = stageNode("leaf", 903);
stageEditor.live = { epoch: 1, values: { "903.surface": "#ff0000", "999.value": 7 } };
drawStage();
check(stageNode("frame", 901) === heldRow, "a live frame touching no consumed cell rebuilds nothing");
stageEditor.live = { epoch: 1, values: { "903.surface": "#00ff00" } };
drawStage();
check(stageNode("frame", 901) === heldRow && stageNode("leaf", 903) === heldLamp,
      "and one that MOVES a consumed cell keeps every element it patches");
check(heldLamp.style.background === "#00ff00",
      "the patch lands on that very element, got " + heldLamp.style.background);

/* A COMPILE RECONCILES IT REGARDLESS. Editing an attr leaves the tree identical and
   changes the PROGRAM the field evaluates to, and the new programs arrive in the snapshot
   that follows the echo — so the epoch is what says "the same document means something
   else now". Without this a resize commits its number and redraws the old one. */
const heldAgain = stageNode("frame", 901);
stageAttrs["901"].attrs.w = prog(660);
drawStage();
check(stageNode("frame", 901) === heldAgain &&
        stageNode("frame", 901).style.width === "440px",
      "fresh programs alone re-run nothing: nothing told the view they were fresh");
stageEditor.live = { epoch: 2, values: { "903.surface": "#00ff00" } };
drawStage();
check(stageNode("frame", 901) === heldAgain &&
        stageNode("frame", 901).style.width === "660px",
      "a new compile epoch RECONCILES: the same element, the number it just received");

/* ---- THE IDENTITY-STABLE RENDERER: no element is created or deleted at runtime ----
   An element is a thing the user is HOLDING — a press, a hover, a text selection, the box
   a gesture measured — so the engine never replaces one to change what it says. A live
   frame patches exactly the binds whose cells moved; a document edit, a compile epoch and
   a mode flip RECONCILE by key onto the very same elements; only a `show` that flipped or
   a `repeat` whose count moved touches structure, and then only under the one parent that
   read it. This rig hand-authors all three levers as programs over one instance's cells. */
{
  /* the gesture primitives put their fail-safe listeners on the window and the document
     (gestures.ts), which this process has neither of until the popover block installs one */
  globalThis.window ??= { addEventListener: () => undefined,
                          removeEventListener: () => undefined };
  document.addEventListener ??= () => undefined;
  document.removeEventListener ??= () => undefined;

  const cell = (c) => ({ code: [{ op: "LOAD", cell: c }] });
  /* pressed ? green : blue — the view-local gesture state, bound the way a real instance
     binds it, so a press has something to move */
  const pressedTint = { code: [{ op: "LOAD", cell: "state:pressed" },
                               { op: "CONST", v: "#00ff00" }, { op: "CONST", v: "#0000ff" },
                               { op: "PICK" }] };
  const rigType = {
    name: "Rig", design_w: 220, design_h: 110, events: [],
    slots: [{ name: "tint", default: "#000000" }, { name: "on", default: 1 },
            { name: "count", default: 3 }],
    template: { kind: "frame", name: "", attrs: {}, children: [
      { kind: "frame", name: "lamp", attrs: { surface: cell("slot:tint") } },
      { kind: "text", name: "read", attrs: { text: cell("slot:tint") } },
      { kind: "frame", name: "gate", attrs: { show: cell("slot:on"),
                                              surface: prog("#111111") } },
      /* pressable and NOT repeated: the control case for what a copy-less post carries */
      { kind: "frame", name: "tail", attrs: { surface: prog("#222222") },
        interact: { primitive: "press", params: {} } },
      { kind: "frame", name: "knob", attrs: { surface: pressedTint },
        interact: { primitive: "press", params: {}, emits: { tap: "tap" } } },
      /* repeated AND pressable, and painting its OWN press: every copy is armed, which
         one spoke is the only thing that tells them apart on the wire, and the look each
         one wears is the only thing that tells them apart on screen */
      { kind: "frame", name: "tick", attrs: { repeat: cell("slot:count"),
                                              left: cell("repeat:frac"),
                                              surface: pressedTint },
        interact: { primitive: "press", params: {} } },
    ] },
  };
  const rStore = new DocStore();
  rStore.load({
    version: 1, next_id: 999, globals: [], tokens: [], components: [],
    pages: [{ id: 500, name: "Rig", children: [
      { id: 510, kind: "frame", name: "board", attrs: {}, children: [
        { id: 511, kind: "frame", type: "Rig", name: "rig", attrs: {},
          slots: {}, locals: [], feeds: [], flows: [] },
      ] },
      { id: 520, kind: "frame", name: "side", attrs: {}, children: [] },
    ] }],
  });
  const rAttrs = {
    "510": { attrs: { left: prog(11), top: prog(11), w: prog(440), h: prog(220) } },
    "511": { attrs: { left: prog(22), top: prog(22), w: prog(198), h: prog(110) } },
    "520": { attrs: { left: prog(484), top: prog(11), w: prog(220), h: prog(110) } },
  };
  const rHost = new Element("section");
  const rView = { mode: "edit", selection: [], element: "", hover: 0, state: {}, faults: {} };
  const rEditor = {
    store: rStore, registry: { version: 1, components: [rigType] }, nodeAttrs: rAttrs,
    live: { epoch: 1, values: {} }, view: rView,
    page: () => rStore.pages()[0],
    contexts: [],
    root() { return this.page(); },
    artboard: () => ({ w: 1408, h: 792 }),
    enterComponent: () => undefined, exitTo: () => undefined, resizePreview: () => undefined,
    select: () => undefined, input: () => undefined,
  };
  const draw = () => renderStage(rHost, rEditor);
  const rNode = (id) => rHost.querySelectorAll("[data-id]")
    .find((n) => n.getAttribute("data-id") === String(id)) ?? null;
  /* a live frame, at the same epoch: what the runtime sends thirty times a second */
  const feed = (values) => { rEditor.live = { epoch: 1, values }; draw(); };
  /* one edit landing as the shell delivers it: the echo bumps the version, the recompiled
     programs arrive in the snapshot behind it */
  const edit = (version, change) => {
    change();
    rStore.apply(version, [{ op: "set_prop", node: 520, key: "name", value: "side" }]);
    draw();
  };

  draw();
  const rPage = rHost.querySelector(".page");
  const board = rNode(510);
  const rig = rNode(511);
  const side = rNode(520);
  check(rPage !== null && board !== null && rig !== null && side !== null,
        "the rig renders: two page boxes and the instance inside one of them");
  const kids = () => rig.children;
  check(kids().length === 8,
        "an instance renders its component's own nodes — lamp, read, gate, tail, knob and " +
        "three repeat copies — got " + kids().length);
  const lamp = kids()[0];
  const read = kids()[1];
  const gate = kids()[2];
  const tail = kids()[3];
  const knob = kids()[4];
  const ticks = [kids()[5], kids()[6], kids()[7]];
  check(ticks[1].style.left === "50%",
        "a repeat copy places itself by its own fraction of the run, got " + ticks[1].style.left);

  /* A DOCUMENT EDIT RECONCILES BY KEY: the page keeps its elements and the edited field
     lands on the one it belongs to. Page nodes key by id, a component's internals by
     their index path under the instance — so both survive. */
  edit(2, () => { rAttrs["510"].attrs.w = prog(660); });
  check(rHost.querySelector(".page") === rPage && rNode(510) === board &&
          rNode(511) === rig && rNode(520) === side,
        "a document edit reuses every element whose key survived");
  check(board.style.width === "660px",
        "and the edited attr lands on that very element, got " + board.style.width);
  check(kids()[0] === lamp && kids()[3] === tail && kids()[5] === ticks[0],
        "a component's internals are keyed by index path and survive the edit too");

  /* EVERY APPLIER IS TOTAL: the element already carries the last pass's answer, so an
     attr that LEFT must be cleared rather than left standing */
  edit(3, () => { rAttrs["520"].attrs.surface = prog("#334455"); });
  check(side.style.background === "#334455",
        "an added surface paints on the standing element, got " + side.style.background);
  edit(4, () => { delete rAttrs["520"].attrs.surface; });
  check(rNode(520) === side && !side.style.background,
        "and removing it CLEARS that element: an applier writes or clears all it owns");

  /* A LIVE FRAME PATCHES. Nothing structural, nothing else re-run. */
  feed({ "511.tint": "#ff0000" });
  check(rHost.querySelector(".page") === rPage && rNode(511) === rig && kids()[0] === lamp,
        "a live frame keeps the page, the instance and the leaf it patched");
  check(lamp.style.background === "#ff0000",
        "the bound surface moved to the live value, got " + lamp.style.background);
  check(read.textContent === "#ff0000",
        "and every reader of that one cell moved with it, got " + read.textContent);
  /* scribble on the element: an applier that runs would wipe this out */
  lamp.style.background = "#010203";
  feed({ "511.tint": "#ff0000", "999.nothing": 5 });
  check(lamp.style.background === "#010203",
        "a live frame that moves no cell this picture reads runs no applier at all");

  /* `show`, FED LIVE: the node is not emitted, and nothing around it is disturbed */
  feed({ "511.tint": "#ff0000", "511.on": 0 });
  check(kids().length === 7 && kids().indexOf(gate) < 0,
        "a `show` that flipped off takes that node out, got " + kids().length + " children");
  check(kids()[0] === lamp && kids()[2] === tail && kids()[3] === knob,
        "its siblings keep their own elements, and close ranks in order");
  feed({ "511.tint": "#ff0000", "511.on": 1 });
  check(kids().length === 8 && kids()[2].style.background === "#111111" &&
          kids()[3] === tail,
        "and flipping it back re-emits it in its own sibling seat: z-order is sibling order");
  check(kids()[0] === lamp && kids()[4] === knob,
        "the re-emit touched no element but the one that came back");

  /* `repeat`, FED LIVE: the copies that survive a count change are the same elements,
     re-applied — their index did not move but their count did */
  feed({ "511.tint": "#ff0000", "511.count": 5 });
  check(kids().length === 10 && kids()[5] === ticks[0] && kids()[7] === ticks[2],
        "growing the count keeps every copy that survived, got " + kids().length);
  check(ticks[1].style.left === "25%",
        "and re-applies them: copy 1 of 5 is a quarter of the way through, got " +
          ticks[1].style.left);
  check(kids()[9].style.left === "100%",
        "while the new tail copies land at the end, got " + kids()[9].style.left);
  feed({ "511.tint": "#ff0000", "511.count": 2 });
  check(kids().length === 7 && kids()[5] === ticks[0] && kids()[6] === ticks[1],
        "shrinking it destroys only the tail copies, got " + kids().length);
  check(ticks[1].style.left === "100%",
        "and the survivors re-solve against the new count, got " + ticks[1].style.left);
  feed({ "511.tint": "#ff0000", "511.count": 3 });

  /* A MODE FLIP IS A PATCH PASS. The elements and their listeners persist, so the regime
     is a property like any other — and the gesture armed at BUILD (in edit mode, which
     never armed anything before this) fires the moment the mode says it may. */
  check(!knob.style.pointerEvents && knob.style.background === "#0000ff",
        "in edit mode the knob takes the pointer as a picture does, unpressed");
  fire(knob, "pointerdown", { button: 0, clientX: 4, clientY: 4 });
  check(knob.style.background === "#0000ff" && !rView.state[511]?.pressed,
        "and a press there is NOT the instance's: edit mode gates it at event time");
  rView.mode = "test";
  draw();
  check(rNode(511) === rig && rig.children[4] === knob && rHost.querySelector(".page") === rPage,
        "flipping to test keeps every element, the page included");
  check(rNode(510).style.pointerEvents === "none" && rig.style.pointerEvents === "none",
        "test mode: a bare page node and an inert instance both let the press through");
  fire(knob, "pointerdown", { button: 0, clientX: 4, clientY: 4 });
  check(rView.state[511]?.pressed === true,
        "the gesture armed at build fires after an edit and a mode flip");
  check(knob.style.background === "#00ff00" && rig.children[4] === knob,
        "and the state write patches exactly what binds it, on that same element");
  rView.mode = "edit";
  draw();
  check(rNode(511) === rig && !rNode(510).style.pointerEvents,
        "flipping back is a patch too: same elements, the regime taken off");

  /* THE COPY RIDES THE EVENT (proto 17). The backend holds ONE set of cells for a
     repeated element however many pictures this view drew, so which copy was pressed
     exists nowhere but on the gesture — and the seat reads it at POST time off the live
     bind, never off what it was armed with, because a reconcile moves a copy's index
     under a listener that outlives it. */
  const posted = [];
  rEditor.input = (node, event, value, element, repeat) =>
    posted.push({ node, event, element, repeat });
  rView.mode = "test";
  draw();
  fire(kids()[6], "pointerdown", { button: 0, clientX: 4, clientY: 4 });
  check(posted.length === 1 && posted[0].event === "press" && posted[0].element === "tick",
        "a press on a repeat copy posts as that element, got " + JSON.stringify(posted));
  check(posted[0].repeat?.index === 1 && posted[0].repeat?.count === 3,
        "and carries WHICH COPY it was, got " + JSON.stringify(posted[0].repeat));
  fire(tail, "pointerdown", { button: 0, clientX: 4, clientY: 4 });
  check(posted[1]?.element === "tail" && posted[1].repeat == null,
        "while an element outside a repeat carries none: absence is how the wire says " +
        "'not in a repeat', got " + JSON.stringify(posted[1]));

  /* AND THE LOOK IS THE PRESSED COPY'S ALONE. The view-local `state:` cells key on the
     channel PLUS the copy, so one finger lights one picture — keyed on the channel alone,
     every copy of a repeated control lit together. */
  const tint = () => kids().slice(5).map((n) => n.style.background);
  check(tint().join(",") === "#0000ff,#00ff00,#0000ff",
        "one press lights exactly the copy that was pressed, got " + tint().join(","));
  /* the whole of an INSTANCE's anatomy still shares one seat: the knob's own press (a
     different element of the same channel) is what the tail is painting */
  check(knob.style.background === "#00ff00",
        "while an instance's own anatomy shares one seat, got " + knob.style.background);

  /* the count moves under listeners armed once — the NEXT press reports the new run */
  feed({ "511.tint": "#ff0000", "511.count": 5 });
  check(tint().join(",") === "#0000ff,#00ff00,#0000ff,#0000ff,#0000ff",
        "growing the run does not spread a press to the copies that arrived, got " +
          tint().join(","));
  fire(kids()[7], "pointerdown", { button: 0, clientX: 4, clientY: 4 });
  check(posted[2]?.repeat?.index === 2 && posted[2]?.repeat?.count === 5,
        "a copy that outlived a count change reports its NEW run, got " +
          JSON.stringify(posted[2]?.repeat));
  check(tint().join(",") === "#0000ff,#00ff00,#00ff00,#0000ff,#0000ff",
        "and two copies held down are two lit pictures, got " + tint().join(","));
  rView.mode = "edit";
  draw();
}

/* ---- THE PLACEMENT RULE: a per-copy property is evaluated HERE ----
   Every other slot expression is a standing backend program with one published cell. An
   expression naming `state` or `repeat` cannot be: the backend keeps one cell where this
   view draws N pictures. So the backend serves the PROGRAM with the instance's own row
   instead, and the renderer runs it once per copy, over that copy's cells. Nothing about
   the served template changes — the component still reads `slot:value` and does not know
   which side of the wire the number came from. */
{
  const cell = (c) => ({ code: [{ op: "LOAD", cell: c }] });
  const pcType = {
    name: "Cellule", design_w: 120, design_h: 40, events: [],
    slots: [{ name: "value", shape: "num", default: 0 }],
    template: { kind: "frame", name: "", attrs: {}, children: [
      { kind: "text", name: "face", attrs: { text: cell("slot:value") } },
    ] },
  };
  const pStore = new DocStore();
  pStore.load({
    version: 1, next_id: 999, globals: [], tokens: [], components: [],
    pages: [{ id: 700, name: "P", children: [
      { id: 710, kind: "frame", type: "Cellule", name: "each",
        attrs: {}, slots: {}, locals: [], feeds: [], flows: [] },
    ] }],
  });
  /* the instance's own row: its attrs, and the property the backend handed back */
  const pAttrs = {
    "710": {
      attrs: { left: prog(11), top: prog(11), w: prog(120), h: prog(40),
               repeat: prog(3) },
      slots: { value: { code: [{ op: "LOAD", cell: "repeat:index" },
                               { op: "CONST", v: 100 }, { op: "MUL" }] } },
    },
  };
  const pView = { mode: "edit", selection: [], element: "", hover: 0, state: {}, faults: {} };
  const pEditor = {
    store: pStore, registry: { version: 1, components: [pcType] }, nodeAttrs: pAttrs,
    /* the cell the standing program WOULD have published, deliberately holding a value:
       a per-copy property has no standing program, so this must not be what is drawn */
    live: { epoch: 1, values: { "710.value": 999 } }, view: pView,
    page: () => pStore.pages()[0],
    contexts: [],
    root() { return this.page(); },
    artboard: () => ({ w: 1408, h: 792 }),
    enterComponent: () => undefined, exitTo: () => undefined, resizePreview: () => undefined,
    select: () => undefined, input: () => undefined,
  };
  const pHost = new Element("section");
  renderStage(pHost, pEditor);
  const faces = () => pHost.querySelectorAll("[data-id]")
    .filter((n) => n.getAttribute("data-id") === "710")
    .map((n) => n.children[0]?.textContent ?? "");
  check(faces().length === 3, "three copies of the instance, got " + faces().length);
  check(faces().join(",") === "0,100,200",
        "each copy evaluates the property for ITSELF, got " + faces().join(","));
  check(!faces().includes("999"),
        "and the cell the wire would have carried is not what is drawn: there is no " +
        "standing program behind a per-copy property, got " + faces().join(","));

  /* the served template did not change: the component reads `slot:value` exactly as it
     does for an ordinary property, so a component never knows which tier answered */
  check(pcType.template.children[0].attrs.text.code[0].cell === "slot:value",
        "the component still reads slot:value — the tier is the compiler's business");
}

/* ---- TRANSITIONS: the view eases what it draws ----
   The true value is never eased anywhere -- behavior, the wire and gestures read truth --
   so what these pin is the RENDERING contract, in its two halves: an ATTRIBUTE transition
   is metadata merged into the element's native CSS `transition` (the browser owns the
   blend; this process has no CSS engine, so what is pinned is the property string and its
   totality), and a PROPERTY transition tweens the slot's rendered value in the view's own
   loop (stepped here on a hand clock): retargets start from what is shown, structure
   reads truth, Nil snaps. */
{
  const cell = (c) => ({ code: [{ op: "LOAD", cell: c }] });
  /* a type whose `value` PROPERTY declares the transition: the bar's position and the
     gate's visibility both read the same slot, and only the PICTURE of it may sweep.
     The bar ALSO carries attr-transition metadata of its own (width), pinning that a
     template node's rows reach its element. */
  const sweepType = {
    name: "Sweeper", design_w: 220, design_h: 110, events: [],
    slots: [{ name: "value", shape: "num", default: 0.2, group: "value",
              smooth: 200, profile: "linear" }],
    template: { kind: "frame", name: "", attrs: {}, children: [
      /* the width transition's DURATION is an expression over the smoothed slot: what
         it must read is the TRUE value, never the eased picture of it */
      { kind: "frame", name: "bar", attrs: { left: cell("slot:value"), w: prog(0.1),
                                             h: prog(0.5) },
        transitions: { w: { ms: { code: [{ op: "LOAD", cell: "slot:value" },
                                         { op: "CONST", v: 1000 },
                                         { op: "MUL" }] } } } },
      { kind: "frame", name: "gate",
        attrs: { show: { code: [{ op: "LOAD", cell: "slot:value" },
                                { op: "CONST", v: 0.9 }, { op: "GT" }] },
                 surface: prog("#111111"), w: prog(0.1), h: prog(0.1) } },
    ] },
  };
  const tStore = new DocStore();
  tStore.load({
    version: 1, next_id: 999, globals: [], tokens: [], components: [],
    pages: [{ id: 700, name: "Sweep", children: [
      { id: 710, kind: "frame", name: "box", attrs: {}, children: [] },
      { id: 711, kind: "frame", type: "Sweeper", name: "sw", attrs: {},
        slots: {}, locals: [], feeds: [], flows: [] },
    ] }],
  });
  const tAttrs = {
    "710": { attrs: { left: prog(11), top: prog(11), w: prog(220), h: prog(110),
                      surface: prog("#333333") } },
    "711": { attrs: { left: prog(11), top: prog(200), w: prog(220), h: prog(110) } },
  };
  const tView = { mode: "edit", selection: [], element: "", hover: 0, state: {}, faults: {} };
  const tHost = new Element("section");
  const tEditor = {
    store: tStore, registry: { version: 1, components: [sweepType] }, nodeAttrs: tAttrs,
    live: { epoch: 1, values: {} }, view: tView,
    page: () => tStore.pages()[0],
    contexts: [],
    root() { return this.page(); },
    artboard: () => ({ w: 1408, h: 792 }),
    enterComponent: () => undefined, exitTo: () => undefined, resizePreview: () => undefined,
    select: () => undefined, input: () => undefined,
  };
  let tnow = 1000;
  setTransitionClock(() => tnow);
  const tDraw = () => renderStage(tHost, tEditor);
  const tNode = (id) => tHost.querySelectorAll("[data-id]")
    .find((n) => n.getAttribute("data-id") === String(id)) ?? null;

  tDraw();
  const sw = tNode(711);
  const bar = () => sw.children[0];
  check(bar().style.left === "20%",
        "first sight SNAPS: there is no sweep from nothing, got " + bar().style.left);
  check(sw.children.length === 1, "the gate is honestly absent at 0.2");

  /* THE ATTR MECHANISM IS METADATA -> the native `transition` property, per entry, per
     rate -- and TOTAL: rows that leave take their entries with them. The DURATION here
     is an expression (value * 1000) evaluated over the true value 0.2. */
  check(bar().style.transition === "width 200ms ease",
        "a template node's transition metadata reaches its element, its duration an "
        + "expression over the node's own scope, got '" + bar().style.transition + "'");
  tAttrs["710"].transitions = { left: { ms: 400, profile: "linear" },
                                surface: { ms: 300, profile: "ease-out" } };
  tEditor.live = { epoch: 2, values: {} };
  tDraw();
  const box = tNode(710);
  check(box.style.transition === "left 400ms linear, background-color 300ms ease-out",
        "a page node's rows merge into one per-property list, got '" +
          box.style.transition + "'");
  delete tAttrs["710"].transitions;
  tEditor.live = { epoch: 3, values: {} };
  tDraw();
  check(box.style.transition === "",
        "and it clears whole when the metadata goes -- the applier is total");

  /* THE PROPERTY MECHANISM: the slot's rendered value tweens here. The slot moves: the
     true value lands whole (structure, marks) while the picture starts walking. Same
     epoch -- this is a live frame, not a compile. */
  tnow = 1000;
  tEditor.live = { epoch: 3, values: { "711.value": 1 } };
  tDraw();
  check(sw.children.length === 2,
        "STRUCTURE READS TRUTH: the gate exists the moment the value passes 0.9, "
        + "not 180ms later");
  check(bar().style.left === "20%",
        "while the eased picture has not moved yet, got " + bar().style.left);
  check(bar().style.transition === "width 1000ms ease",
        "AND A DURATION READS TRUTH: the expression sees 1 at once, not the eased "
        + "0.2-and-climbing, got '" + bar().style.transition + "'");
  tnow = 1100;
  stepTransitions(tHost, tEditor, tnow);
  check(Math.abs(parseFloat(bar().style.left) - 60) < 1e-9,
        "half the time, half the way (linear), got " + bar().style.left);
  tnow = 1250;
  stepTransitions(tHost, tEditor, tnow);
  check(bar().style.left === "100%", "and it settles exactly, got " + bar().style.left);

  /* a retarget mid-flight starts FROM WHAT IS SHOWN, never a jump */
  tEditor.live = { epoch: 3, values: { "711.value": 0 } };
  tDraw();
  tnow = 1350;
  stepTransitions(tHost, tEditor, tnow);
  tEditor.live = { epoch: 3, values: { "711.value": 1 } };
  tDraw();
  tnow = 1450;
  stepTransitions(tHost, tEditor, tnow);
  const mid = parseFloat(bar().style.left);
  check(mid > 50 && mid < 100,
        "a mid-flight retarget eases from the shown value toward the new one, got "
        + bar().style.left);
  tnow = 2000;
  stepTransitions(tHost, tEditor, tnow);
  check(bar().style.left === "100%", "and still settles exactly");

  /* a live cell going away RESOLVES to the authored fallback -- a renderable number --
     and the picture eases toward it like any other move */
  tnow = 4000;
  tEditor.live = { epoch: 3, values: { "711.value": null } };
  tDraw();
  check(bar().style.left === "100%",
        "a fallback is a retarget, not a jump, got " + bar().style.left);
  tnow = 4200;
  stepTransitions(tHost, tEditor, tnow);
  check(bar().style.left === "20%", "easing home to the authored value");

  /* TRUE NIL SNAPS: a slot with no value anywhere renders UNKNOWN at once -- nothing
     invents frames toward (or from) a value nobody produced. A NEW type row, because
     the sweep table is cached per served type object (as a snapshot would deliver). */
  tEditor.registry = { version: 2, components: [{
    ...sweepType,
    slots: [...sweepType.slots,
            { name: "raw", shape: "num", group: "value", smooth: 200, profile: "linear" }],
    template: { ...sweepType.template, children: [
      ...sweepType.template.children,
      { kind: "frame", name: "rawbar", attrs: { left: cell("slot:raw"), w: prog(0.1),
                                                h: prog(0.2) } },
    ] },
  }] };
  tEditor.live = { epoch: 6, values: { "711.raw": 0.5 } };
  tDraw();
  const rawbar = () => sw.children[sw.children.length - 1];
  check(rawbar().style.left === "50%", "a fresh slot's first sight snaps");
  tEditor.live = { epoch: 6, values: {} };
  tDraw();
  check(rawbar().style.left === "0%",
        "and Nil ends the sweep at once: the unknown treatment, never an eased lie, got "
        + rawbar().style.left);

  setTransitionClock(null);
}

/* ---- THE CLOCK: time cells tick the view ----
   `time` reads by field ("time:<field>" cells): `time.now` is the animation clock —
   seconds off the same replaceable clock the sweeps use — and the rest is the viewer's
   wall clock, replaced here so the civil fields hold still under the checks. The clock
   has its OWN ticker (stepTime): it re-runs exactly the binds whose time cell moved,
   and the wire's live diff never touches a time cell. */
{
  const cell = (c) => ({ code: [{ op: "LOAD", cell: c }] });
  const kStore = new DocStore();
  kStore.load({
    version: 1, next_id: 999, globals: [], tokens: [], components: [],
    pages: [{ id: 720, name: "Clock", children: [
      { id: 730, kind: "text", name: "readout", attrs: {}, children: [] },
      { id: 731, kind: "frame", name: "mover", attrs: {}, children: [] },
    ] }],
  });
  const kAttrs = {
    "730": { attrs: { left: prog(11), top: prog(11), w: prog(220), h: prog(44),
                      text: cell("time:text") } },
    "731": { attrs: { top: prog(110), w: prog(110), h: prog(110),
                      left: { code: [{ op: "LOAD", cell: "time:now" },
                                     { op: "CONST", v: 100 }, { op: "MUL" }] } } },
  };
  const kView = { mode: "edit", selection: [], element: "", hover: 0, state: {}, faults: {} };
  const kHost = new Element("section");
  const kEditor = {
    store: kStore, registry: { version: 1, components: [] }, nodeAttrs: kAttrs,
    live: { epoch: 1, values: {} }, view: kView,
    page: () => kStore.pages()[0],
    contexts: [],
    root() { return this.page(); },
    artboard: () => ({ w: 1408, h: 792 }),
    enterComponent: () => undefined, exitTo: () => undefined, resizePreview: () => undefined,
    select: () => undefined, input: () => undefined,
  };
  let know = 2000;
  let kwall = new Date(2026, 7, 10, 12, 34, 56).getTime();
  setTransitionClock(() => know);
  setWallClock(() => kwall);
  renderStage(kHost, kEditor);
  const kNode = (id) => kHost.querySelectorAll("[data-id]")
    .find((n) => n.getAttribute("data-id") === String(id)) ?? null;
  check(kNode(730).textContent === "12:34:56",
        "time.text renders the pinned wall clock, got '" + kNode(730).textContent + "'");
  check(kNode(731).style.left === "200px",
        "time.now is the animation clock in seconds, got " + kNode(731).style.left);

  /* the ticker's step: only what moved re-runs. A frame later the animation clock has
     moved and the wall second has not. */
  know = 2500;
  stepTime(kHost, kEditor);
  check(kNode(731).style.left === "250px",
        "stepTime re-runs the time.now reader, got " + kNode(731).style.left);
  check(kNode(730).textContent === "12:34:56", "while the wall second stands");
  kwall += 1000;
  stepTime(kHost, kEditor);
  check(kNode(730).textContent === "12:34:57",
        "and the second flipping repaints the readout, got '" +
          kNode(730).textContent + "'");

  /* the wire's live diff leaves time cells alone: a live frame moving nothing this
     picture reads must not misread the ticker-driven cells as moved */
  kEditor.live = { epoch: 1, values: { "999.unrelated": 5 } };
  know = 2600;
  renderStage(kHost, kEditor);
  check(kNode(731).style.left === "250px",
        "a live frame does not advance the clock: the ticker owns time cells, got " +
          kNode(731).style.left);

  setTransitionClock(null);
  setWallClock(null);
}

/* ---- the node inspector ----
   A page's box is a NODE, so it is inspected the way a component's node is: one
   structural field (what it is) and then every attr its kind declares, generated from
   the served vocabulary. There is no hand-written field list for a page box and a
   second one for a component's box, because there is one node. */
{
  const group = frameNamed(store.pages()[0], "Status group");
  const applied = [];
  const frameEditor = {
    ...editor,
    selectedNode: () => store.nodeAt(group.id),
    selectedInstance: () => null,
    apply: (ops) => applied.push(...ops),
  };
  const framePanel = new Panel(new Element("aside"));
  framePanel.render(inspectorShape(frameEditor), (host) => renderInspector(host, frameEditor));

  const attrRowFor = (name) =>
    framePanel.host.querySelectorAll(".attr-row")
      .find((row) => row.querySelector(".attr-name")?.textContent === name) ?? null;
  /* the box's own dressing and its one placement vocabulary: everything sits at its own
     left/top in the one static space — the far edges and the clamps beside them — so the
     same box rows stand on every node */
  for (const name of ["surface", "border", "border_w", "radius",
                      "left", "top", "right", "bottom", "w", "h",
                      "min_w", "max_w", "min_h", "max_h",
                      "aspect", "origin_x", "origin_y", "rotate"])
    check(attrRowFor(name) !== null, "the node inspector edits " + name);
  for (const name of ["gap", "pad", "align", "justify", "grow", "min", "layout"])
    check(attrRowFor(name) === null,
          "and does not offer " + name + ", which left the vocabulary with the layouts");

  /* editing one writes the WHOLE attrs map, exactly as a component's node does */
  const radiusField = attrRowFor("radius").querySelectorAll("input")[0];
  radiusField.value = "12";
  fire(radiusField, "change");
  const op = applied.find((o) => o.key === "attrs");
  check(op && op.op === "set_prop" && op.node === group.id && op.value.radius === "12",
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
   ARE, but which parent and which index a drop means is arithmetic, and it is the element that
   makes tree dragging feel right or maddening. */
{
  const leaf = (id, name) => ({ id, kind: "frame", type: "Label", name,
                                 attrs: {}, slots: {}, locals: [], feeds: [], flows: [] });
  const frame = (id, name, children) => ({ id, kind: "frame", name, attrs: {}, children });
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
  check(Boolean(moveStore.instance(711) ?? moveStore.nodeAt(711)),
        "a selected node survives its own reparent echo");

  moveStore.apply(3, [{ op: "move", node: 700, parent: 0, list: "pages", index: 1 }]);
  check(ids(moveStore.pages()) === "800,700", "a page echo reorders the one list hanging off the root");

  moveStore.apply(4, [{ op: "move", node: 711, index: 1 }]);
  check(ids(moveStore.nodeAt(720).children) === "721,711",
        "and an echo with no parent at all reorders where the node already is");

  /* the group echo: an insert of a childless box, then one addressed move per node, so
     the mirror never holds the same instance in two places */
  moveStore.apply(5, [
    { op: "insert", parent: 700, list: "children", index: 0,
      node: frame(750, "Group", []) },
    { op: "move", node: 710, parent: 750, list: "children", index: 0 },
    { op: "move", node: 720, parent: 750, list: "children", index: 1 },
  ]);
  check(ids(moveStore.page(700).children) === "750,730", "the group echo lands the box where the nodes were");
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
  check(at(730, 711, "into") === "none", "an instance row has no inside to drop into");

  /* the empty room under the last row: the end of the page */
  const end = dropAtPageEnd(tree, 711);
  check(end?.parent === 700 && end?.index === 3, "the space below the tree appends to the page");
  check(dropAtPageEnd(tree, 730) === null, "unless the node is already the last thing on it");

  /* the zone the pointer names, from the row's own proportions */
  check(dropZone(true, 0.2) === "before" && dropZone(true, 0.5) === "into" &&
          dropZone(true, 0.8) === "after",
        "a frame row means INSIDE through its middle, and a gap at either edge");
  check(dropZone(false, 0.4) === "before" && dropZone(false, 0.6) === "after",
        "an instance row has no middle: it splits at the halfway mark");

  /* settle(), reached with a container and an index: the same legality and the same
     erase-first shift however a drop was aimed */
  check(settle(tree, 730, { parent: 720, index: 1 })?.index === 1, "a plain append settles as itself");
  check(settle(tree, 711, { parent: 710, index: 2 })?.index === 1,
        "a slot further down its own list still loses one to the erase");
  check(settle(tree, 710, { parent: 715, index: 0 }) === null, "a frame still refuses its own subtree");
  check(settle(tree, 711, { parent: 710, index: 0 }) === null, "and the seat it already holds is no move");

  /* ---- the artboard: the grid, the box, and what a gesture may write ----
     Everything is canvas px on the one 11px grid; `base` is the parent's own origin on
     the artboard, which is what keeps a nested box snapping to the GLOBAL lines. */

  check(snapPx(100) === 99 && snapPx(250) === 253,
        "px snap to the 11px cells");
  check(fmtPx(153.6) === "154" && fmtPx(22) === "22",
        "a written position is whole px, got " + fmtPx(153.6));

  const freeNode = (attrs) => ({ id: 9, kind: "frame", name: "n", attrs });
  const flat = { left: 0, top: 0, w: 0, h: 0 };
  const origin = { x: 0, y: 0 };

  /* the resolved box prefers the doc's own constants and falls back to the screen */
  const authored = freeBoxOf(freeNode({ left: "110", top: "110", w: "220", h: "110" }),
                             { left: 900, top: 900, w: 900, h: 900 });
  check(authored.left.value === 110 && authored.left.literal && authored.w.value === 220,
        "a literal field reads from the document, not the measurement");
  const measured = freeBoxOf(freeNode({ left: "value.pick(2, 1)" }),
                             { left: 396, top: 66, w: 220, h: 110 });
  check(!measured.left.literal && Math.abs(measured.left.value - 396) < 1e-9,
        "an expression field reads off the screen and may not be written");
  check(freeBoxOf(freeNode({ origin_x: "value" }), flat) === null,
        "an expression origin refuses the whole gesture: nothing safe to write through");

  /* which handles are offered */
  const plain = freeBoxOf(freeNode({ left: "110", top: "110", w: "220", h: "110" }), flat);
  check(freeAllowed(plain, "move") && freeAllowed(plain, "BR") && freeAllowed(plain, "L"),
        "a box of constants offers everything");
  const boundX = freeBoxOf(freeNode({ left: "value.mapRange(0,1,0,1408)", top: "220",
                                      w: "220", h: "110" }), flat);
  check(freeAllowed(boundX, "move"), "one authored axis still leaves an axis-locked move");
  check(!freeAllowed(boundX, "L") && freeAllowed(boundX, "R") && freeAllowed(boundX, "B"),
        "a bound left takes the left grip away but not the right (origin 0: R never writes it)");
  const spun = freeBoxOf(freeNode({ left: "220", top: "220", w: "220", h: "110",
                                    rotate: "45" }), flat);
  check(freeAllowed(spun, "move") && !freeAllowed(spun, "BR") && !freeAllowed(spun, "R"),
        "a rotated box still moves point-for-point but resizes through nothing");
  const locked = freeBoxOf(freeNode({ left: "22", top: "22", w: "440", aspect: "2" }), flat);
  check(!freeAllowed(locked, "T") && !freeAllowed(locked, "B"),
        "aspect derives the unauthored size, whose own edges have nothing to write");
  check(freeAllowed(locked, "BR") && freeAllowed(locked, "R"),
        "while the authored axis keeps its edge and its corners");

  /* the move plan: snapped, axis-locked, and quiet about what did not change */
  const slide = freePlan("move", plain, origin);
  const slid = slide.commit(15, 0, true);   /* 110 + 15 = 125, snapped to 121 */
  check(slid.left === 121 && !("top" in slid) && !("w" in slid),
        "a move writes the snapped left it reached and nothing it did not touch, got " +
          JSON.stringify(slid));
  check(slide.commit(15, 0, false).left === 125,
        "Alt suspends the snap and the same travel lands raw");
  check(Object.keys(slide.commit(3, 0, true)).length === 0,
        "a move that snaps back to where it began writes nothing at all");

  /* THE GRID IS GLOBAL: the same drag inside a parent that sits off the origin snaps to
     the artboard's lines, not to lines of the parent's own */
  const nested = freePlan("move", plain, { x: 5, y: 0 });
  check(nested.commit(15, 0, true).left === 127,
        "a nested box snaps where the ARTBOARD's line is, got " +
          JSON.stringify(nested.commit(15, 0, true)));

  /* a STRETCHED axis pins its size when first moved: the doc held nothing on it */
  const stretched = freeBoxOf(freeNode({}), { left: 0, top: 0, w: 1408, h: 792 });
  const pinned = freePlan("move", stretched, origin).commit(30, 0, true);
  check(pinned.left === 33 && pinned.w === 1408 && !("h" in pinned),
        "moving a stretched box writes the size the stretch was giving, got " +
          JSON.stringify(pinned));

  /* the resize plan: the grabbed edge moves, the opposite edge stands */
  const wider = freePlan("R", plain, origin).commit(15, 0, true);
  check(wider.w === 231 && !("left" in wider),
        "dragging R at origin 0 writes only w, got " + JSON.stringify(wider));
  const fromLeft = freePlan("L", plain, origin).commit(15, 0, true);
  check(fromLeft.left === 121 && fromLeft.w === 209,
        "dragging L moves left and w together and the right edge stands, got " +
          JSON.stringify(fromLeft));
  check(freePlan("R", plain, origin).apply(-1e6, 0, true).w >= 8 - 1e-9,
        "a resize stops at a graspable floor rather than vanishing");
  const corner = freePlan("BR", locked, origin).commit(30, 30, true);
  check("w" in corner && !("h" in corner) && !("top" in corner),
        "a corner on an aspect-locked box drags the authored axis only, got " +
          JSON.stringify(corner));

  /* an origin off the corner rides the writes: left places the origin, not the edge */
  const hub = freeBoxOf(freeNode({ left: "220", top: "220", w: "110", h: "110",
                                   origin_x: "0.5", origin_y: "0.5" }), flat);
  const hubMove = freePlan("move", hub, origin).commit(15, 0, true);
  check(hubMove.left === 176 + 55,
        "a centred origin: the snapped LEFT EDGE plus half the width, got " +
          JSON.stringify(hubMove));

  /* ---- EDGE-ANCHORED AXES: a pinned far edge changes what the grips write ----
     `right`/`bottom` are insets from the PARENT's far edge (`span`). With both edges
     authored the width is theirs — no gesture ever writes w; with the far edge alone
     the box anchors right and a move slides the inset. */
  const spanned = { w: 1408, h: 792 };
  const edged = freeBoxOf(freeNode({ left: "110", right: "88", top: "110", h: "110" }),
                          { left: 110, top: 110, w: 1210, h: 110 },
                          { x: 1, y: 1 }, spanned);
  check(edged.right.present && edged.right.value === 88 && edged.w.value === 1210,
        "an authored inset reads from the doc and the derived width off the screen");
  const edgeMove = freePlan("move", edged, origin).commit(15, 0, true);
  check(edgeMove.left === 121 && edgeMove.right === 77 && !("w" in edgeMove),
        "moving a both-edges box slides BOTH edges and never writes w, got " +
          JSON.stringify(edgeMove));
  const edgeR = freePlan("R", edged, origin).commit(15, 0, true);
  check(edgeR.right === 77 && !("left" in edgeR) && !("w" in edgeR),
        "dragging R on a both-edges box writes the inset alone, got " +
          JSON.stringify(edgeR));
  const edgeL = freePlan("L", edged, origin).commit(15, 0, true);
  check(edgeL.left === 121 && !("right" in edgeL) && !("w" in edgeL),
        "dragging L writes the near edge alone: the width follows the edges, got " +
          JSON.stringify(edgeL));
  /* a `w` still written beside two pinned edges is INERT: the algebra must span the
     MEASURED axis, not the dead number (the first browser drive caught exactly this) */
  const edgedInert = freeBoxOf(freeNode({ left: "110", right: "88", top: "110",
                                          h: "110", w: "500" }),
                               { left: 110, top: 110, w: 1210, h: 110 },
                               { x: 1, y: 1 }, spanned);
  const inertMove = freePlan("move", edgedInert, origin).commit(15, 0, true);
  check(inertMove.left === 121 && inertMove.right === 77 && !("w" in inertMove),
        "an inert authored w does not poison a both-edges move, got " +
          JSON.stringify(inertMove));

  /* anchored right: no left at all — the box rides the parent's right edge at width w */
  const anchored = freeBoxOf(freeNode({ right: "88", w: "220", top: "110", h: "110" }),
                             { left: 1100, top: 110, w: 220, h: 110 },
                             { x: 1, y: 1 }, spanned);
  const aMove = freePlan("move", anchored, origin).commit(15, 0, true);
  check(aMove.right === 77 && !("left" in aMove) && !("w" in aMove),
        "moving an anchored-right box slides its inset and leaves it anchored, got " +
          JSON.stringify(aMove));
  const aL = freePlan("L", anchored, origin).commit(15, 0, true);
  check(aL.w === 209 && !("left" in aL) && !("right" in aL),
        "dragging its L writes w alone: the right edge stands on its anchor, got " +
          JSON.stringify(aL));
  const aR = freePlan("R", anchored, origin).commit(15, 0, true);
  check(aR.right === 77 && aR.w === 231,
        "dragging its R moves the anchor and the width together (the LEFT edge stands), got " +
          JSON.stringify(aR));

  /* an expression inset guards its grips exactly as an expression position does */
  const exprEdge = freeBoxOf(freeNode({ right: "value * 2", w: "220",
                                        top: "110", h: "110" }),
                             { left: 1100, top: 110, w: 220, h: 110 },
                             { x: 1, y: 1 }, spanned);
  check(!freeAllowed(exprEdge, "R"), "a bound inset takes the right grip away");
  check(freeAllowed(exprEdge, "L"),
        "while L still resizes through w and never touches the anchor");

  /* ---- INSIDE A COMPONENT: the same plan, seamed at the read and the write ----
     A component's literals are FRACTIONS of the parent. `scale` blows them up to px on
     the way in, so every rule above — snap, floors, origins, freeAllowed — runs
     unchanged; the commit's caller divides back down and writes fmtFraction
     (manipulate.ts holds the divisors it measured). */
  const fracBox = freeBoxOf(freeNode({ left: "0.25", top: "0.5", w: "0.5", h: "0.25" }),
                            flat, { x: 440, y: 220 });
  check(fracBox.left.value === 110 && fracBox.w.value === 220 &&
          fracBox.top.value === 110 && fracBox.h.value === 55,
        "fraction literals scale by the parent's box into plan px");
  const fracSlid = freePlan("move", fracBox, origin).commit(23, 0, true);
  check(fracSlid.left === 132, "the plan itself still snaps on the artboard's own grid");
  check(fmtFraction(fracSlid.left / 440) === "0.3",
        "and the caller divides back to a clean fraction of the parent");
  check(fmtFraction(0.123456789) === "0.1235" && fmtFraction(0.5) === "0.5",
        "a written fraction holds at most 4 decimals, got " + fmtFraction(0.123456789));
}

/* ---- ENTER A INSTANCE: the strip, the context tree AND the context inspector ----
   Inside a component the left sidebar's strip names the trail and says the edit is to
   the COMPONENT; the tree lists the component's own nodes as REAL rows (they carry ids,
   so everything works on them), while an unforked built-in's rows stay fenced. The
   right sidebar follows the same standing: nothing selected = the component's own
   editable record; a selected node = its attrs PLUS what only a component's node owns
   (declared properties, the interact). */
{
  /* a component of this block's own (the Lamp above was deleted by the revert test),
     plus one instance of it on the page to have entered through */
  store.apply(store.version() + 1, [
    { op: "insert", parent: 0, list: "components",
      node: { id: 9800, name: "Bulb", events: [], locals: [], attrs: {},
              children: [
                { id: 9810, kind: "frame", name: "body", attrs: {},
                  locals: [{ id: 9812, name: "glow_color", type: "color", public: true,
                             init: "#ff0000", group: "appearance" }],
                  interact: { primitive: "press", params: { hold_ms: "600" },
                              emits: { tap: "tap" } },
                  children: [{ id: 9811, kind: "text", name: "label",
                               attrs: { text: "'on'" } }] },
              ],
              behavior: [] } },
    { op: "insert", parent: store.pages()[0].id, list: "children",
      node: { id: 9880, kind: "frame", type: "Bulb", name: "Glow",
              attrs: { left: "44", top: "44", w: "220", h: "110" },
              slots: {}, locals: [], feeds: [], flows: [] } },
  ]);
  const ctxEditor = {
    ...editor,
    contexts: [{ component: 9800, builtin: "", from: 9880,
                 w: 220, h: 110, w0: 220, h0: 110 }],
    root() {
      const c = this.contexts[this.contexts.length - 1];
      if (!c) return this.page();
      if (!c.component) return null;
      const comp = store.node(c.component);
      return comp ? { id: comp.id, name: comp.name ?? "", children: comp.children ?? [] }
                  : null;
    },
  };
  const ctxPanel = new Panel(new Element("aside"));
  ctxPanel.render(leftShape(ctxEditor), (host) => renderLeftSidebar(host, ctxEditor));
  const strip = ctxPanel.host.querySelector(".context-strip");
  check(strip !== null && strip.className.includes("on"),
        "inside an instance the breadcrumb strip turns on");
  const crumbs = ctxPanel.host.querySelectorAll(".crumb");
  check(crumbs.length === 2 && crumbs[1].textContent === "Bulb" &&
          crumbs[1].className.includes("current"),
        "the trail reads page › component, standing on the component");
  check(!!ctxPanel.host.querySelector(".crumb-note")?.textContent
          ?.includes("every instance follows"),
        "and the strip says out loud what an edit here reaches");
  const keys = () => ctxPanel.host.querySelectorAll(".layer-row")
    .map((r) => r.getAttribute("data-key"));
  check(keys().includes("n9810") && !keys().includes("n9811"),
        "the tree lists the component's own nodes as real rows — shut, like every other " +
        "row, got " + keys().join(","));
  /* the same caret, on the same kind of row: a context's tree is the Layers tree */
  fire(ctxPanel.host.querySelectorAll(".layer-row")
    .find((r) => r.getAttribute("data-key") === "n9810").children[0], "click");
  ctxPanel.render(leftShape(ctxEditor), (host) => renderLeftSidebar(host, ctxEditor));
  check(keys().includes("n9811"), "and what is nested inside them once opened");
  check(ctxPanel.host.querySelectorAll(".layer-row.tpl").length === 0,
        "nothing here is fenced: these rows are the component's to edit");

  /* the built-in variant: fenced rows and the Override verb */
  const roEditor = {
    ...ctxEditor,
    contexts: [{ component: 0, builtin: "Toggle", from: 9880,
                 w: 396, h: 66, w0: 396, h0: 66 }],
  };
  const roPanel = new Panel(new Element("aside"));
  roPanel.render(leftShape(roEditor), (host) => renderLeftSidebar(host, roEditor));
  check(roPanel.host.querySelector(".crumb-override") !== null,
        "an unforked built-in offers Override in the strip");
  check(!!roPanel.host.querySelector(".crumb-note")?.textContent?.includes("read-only"),
        "and says read-only beside it");
  const roRows = roPanel.host.querySelectorAll(".layer-row");
  check(roRows.length > 0 && roRows.every((r) => r.className.includes("tpl")),
        "every row of a built-in's context is fenced until the fork");

  /* ---- the RIGHT sidebar inside a context ----
     Nothing selected stands the inspector on the COMPONENT itself — the Design
     workspace's own editable view — and a selected internal node gains the sections a
     page node never shows: the interact it carries, and variables that can be made
     PUBLIC (a page element has no placement to offer one to). */
  const sel = [];
  const insEditor = {
    ...ctxEditor,
    selectedNode: () => (sel[0] ? store.nodeAt(sel[0]) : null),
    selectedInstance: () => (sel[0] ? store.instance(sel[0]) : null),
  };
  const compPanel = new Panel(new Element("aside"));
  compPanel.render(inspectorShape(insEditor), (host) => renderInspector(host, insEditor));
  check(compPanel.host.querySelector(".head-tag")?.textContent === "component",
        "nothing selected inside a context stands the inspector on the component");
  check(compPanel.host.querySelectorAll(".dashed-btn")
          .some((b) => b.textContent === "+ Variable"),
        "and the component's variables are declared right there");

  /* ---- THE EVENTS A COMPONENT DECLARES ----
     function SIGNATURES its behavior raises with the `raise` step; the gesture family
     (tap, press, ...) never appears here — the primitive on an element brings it. Bulb
     declares none yet, which costs nothing: its press gesture already speaks. */
  check(compPanel.host.textContent.includes("no declared events"),
        "a component with no events says what that costs");
  check(compPanel.host.querySelectorAll(".dashed-btn")
          .some((b) => b.textContent === "+ Event"),
        "and the events are declared right there too");
  check(compPanel.host.querySelectorAll(".eventdef").length === 0,
        "no rows yet, and none of them counted as properties");

  /* two declared signatures: one carrying a value, one a bare moment */
  const evOps = [];
  const evEditor = { ...insEditor, apply: (batch) => evOps.push(...batch) };
  store.apply(store.version() + 1, [
    { op: "set_prop", node: 9800, key: "events",
      value: [{ name: "changed", params: [{ name: "value", shape: "bool" }] },
              { name: "confirmed", params: [] }] },
  ]);
  compPanel.render(inspectorShape(evEditor), (host) => renderInspector(host, evEditor));
  const evRows = compPanel.host.querySelectorAll(".eventdef");
  check(evRows.length === 2 &&
          evRows[0].querySelectorAll("input").some((i) => i.value === "changed"),
        "each declared event gets a row of its own");
  check(evRows[0].querySelectorAll("input").some((i) => i.value === "value") &&
          evRows[0].querySelectorAll("select").length === 1,
        "the signature edits in place: the parameter's name and its shape");
  check(evRows[1].querySelectorAll("select").length === 0,
        "a nullary event offers no shape - a moment carries nothing");
  /* removing one writes the whole array back: `events` is a plain prop, not a child list */
  fire(evRows[1].querySelector(".icon-btn"), "click");
  check(evOps.length === 1 && evOps[0].key === "events" &&
          evOps[0].value.length === 1 && evOps[0].value[0].name === "changed",
        "and removing one rewrites the array, got " + JSON.stringify(evOps));

  sel[0] = 9810;
  const nodeShape = inspectorShape(insEditor);
  check(nodeShape.includes("glow_color") === false && nodeShape.includes("9812"),
        "a selected node's own declarations ride the inspector's shape");
  compPanel.render(nodeShape, (host) => renderInspector(host, insEditor));
  check(compPanel.host.querySelector(".card") !== null &&
          compPanel.host.querySelectorAll(".dashed-btn")
            .some((b) => b.textContent === "+ Variable"),
        "a component's element declares and edits its variables from the content view");
  check(compPanel.host.textContent.includes("GESTURE") &&
          compPanel.host.textContent.includes("hold_ms") &&
          compPanel.host.textContent.includes("pressrelease (down)"),
        "and the interact it carries shows its params and the family it BRINGS");
  /* the gesture is EDITABLE here, which is what lets an authored node be given one at
     all: the picker offers `none` plus the four primitives, standing on this one's */
  const gesturePicker = compPanel.host.querySelectorAll(".select-wrap")
    .find((w) => w.children[0].value === "press");
  check(gesturePicker !== undefined &&
          gesturePicker.children[0].children.map((o) => o.value)
            .join(",") === ",press,drag1d,drag_radial,pick",
        "the primitive is picked, not read: none plus the four");

  /* the built-in context: the shipped definition, read-only, Override one click away */
  const roIns = { ...roEditor, selectedNode: () => null, selectedInstance: () => null };
  const roPanel2 = new Panel(new Element("aside"));
  roPanel2.render(inspectorShape(roIns), (host) => renderInspector(host, roIns));
  check(roPanel2.host.querySelector(".head-tag")?.textContent === "built-in",
        "an unforked built-in context shows the shipped definition in the inspector");
  check(roPanel2.host.querySelectorAll(".dashed-btn")
          .some((b) => (b.textContent ?? "").startsWith("Override")),
        "with Override one click away there too");
}

/* ---- ENTER A INSTANCE on the stage: the component's own artboard (stage.ts) ----
   The artboard becomes the context's preview box, the design frame wears the component
   root's dressing, and the component's nodes render carrying their ids, placed in
   FRACTIONS of their parent — resizing the preview re-solves them. */
{
  const ctxStore = new DocStore();
  ctxStore.load({
    version: 1, next_id: 999, globals: [], tokens: [],
    components: [
      { id: 950, name: "Chip", events: [], locals: [],
        attrs: { surface: "'#333333'" },
        children: [{ id: 951, kind: "frame", name: "body",
                     attrs: { left: "0.25", top: "0.25", w: "0.5", h: "0.5" } }],
        behavior: [] },
    ],
    pages: [{ id: 940, name: "P", children: [
      { id: 941, kind: "frame", type: "Chip", name: "chip1",
        attrs: { left: "22", top: "22", w: "440", h: "220" },
        slots: {}, locals: [], feeds: [], flows: [] },
    ] }],
  });
  const prog2 = (v) => ({ code: [{ op: "CONST", v }] });
  const ctxAttrs = {
    "941": { attrs: { left: prog2(22), top: prog2(22), w: prog2(440), h: prog2(220) } },
    "950": { attrs: { surface: prog2("#333333") } },
    "951": { attrs: { left: prog2(0.25), top: prog2(0.25), w: prog2(0.5), h: prog2(0.5) } },
  };
  const ctxHost = new Element("section");
  const ctxView = { mode: "edit", selection: [], element: "", hover: 0, state: {}, faults: {} };
  const ctxStage = {
    store: ctxStore, registry: snapshot.registry, nodeAttrs: ctxAttrs,
    live: { epoch: 1, values: {} }, view: ctxView,
    page: () => ctxStore.pages()[0],
    contexts: [{ component: 950, builtin: "", from: 941,
                 w: 440, h: 220, w0: 440, h0: 220 }],
    root() {
      const c = this.contexts[this.contexts.length - 1];
      if (!c) return this.page();
      const comp = ctxStore.node(c.component);
      return comp ? { id: comp.id, name: comp.name, children: comp.children ?? [] } : null;
    },
    artboard() {
      const c = this.contexts[this.contexts.length - 1];
      return c ? { w: c.w, h: c.h } : { w: 1408, h: 792 };
    },
    enterComponent: () => undefined, exitTo: () => undefined, resizePreview: () => undefined,
    select: () => undefined,
  };
  renderStage(ctxHost, ctxStage);
  const ctxPage = ctxHost.querySelector(".page");
  check(ctxPage !== null && ctxPage.style.width === "440px" &&
          ctxPage.style.height === "220px",
        "an entered instance's artboard is the context's preview box");
  check(ctxPage.style.background === "#333333",
        "the design frame wears the component root's own dressing");
  const body = ctxHost.querySelectorAll(".frame")
    .find((n) => n.getAttribute("data-id") === "951") ?? null;
  check(body !== null,
        "a component's own node renders CARRYING ITS ID: selectable, draggable");
  check(body.style.left === "25%" && body.style.width === "50%",
        "and places itself in FRACTIONS of its parent, got " + body.style.left);
  ctxStage.contexts[0].w = 880;
  renderStage(ctxHost, ctxStage);
  check(ctxHost.querySelector(".page").style.width === "880px",
        "resizing the preview resizes the artboard: the fractions re-solve");

  /* CLAMPS TRANSFER THROUGH THE RATIO in FRACTION space: the derived axis's bound
     converts into the parent's cross-axis units — cqw, every box being a size container
     (stage.css) — so a narrowing instance shrinks the height and the shape holds */
  ctxAttrs["951"].attrs = { left: prog2(0), top: prog2(0.1), h: prog2(0.8),
                            aspect: prog2(2), max_w: prog2(1) };
  ctxStage.live = { epoch: 2, values: {} };
  renderStage(ctxHost, ctxStage);
  const fit = ctxHost.querySelectorAll(".frame")
    .find((n) => n.getAttribute("data-id") === "951") ?? null;
  check(fit !== null && fit.style.height === "min(80%, 50cqw)" &&
          fit.style.width === "" && fit.style.aspectRatio === "2",
        "a max_w on a height-authored aspect box folds in as its parent-width bound, "
        + "got '" + fit?.style.height + "'");
}

/* ---- THE STANDING AGGREGATES: what the wire delivers vs. what the view holds ----
   Every `aggs` entry is a DELTA against a per-cell generation and append cursor, so the
   fold either continues the copy it has or throws it away: ERASE AND REBASELINE, never
   bridge a hole. Guessing what fell in a gap would show a list that never existed. */
{
  const store = new Map();
  const wire = (gen, from, len, values) => ({ "1.ring": { gen, from, len, values } });
  const held = () => {
    const values = store.get("1.ring")?.values;
    return Array.isArray(values) ? values.join(",") : String(values);
  };
  const entry = () => store.get("1.ring");

  foldAggs(store, wire(1, 0, 2, [1, 2]));
  check(held() === "1,2" && entry().end === 2,
        "the first frame becomes the copy, and the cursor lands past it");
  const first = entry().version;
  foldAggs(store, wire(1, 2, 3, [3]));
  check(held() === "1,2,3" && entry().end === 3,
        "a frame starting exactly at the cursor APPENDS, got " + held());
  check(entry().version > first, "and the version moves, which is what a reader watches");

  foldAggs(store, wire(1, 3, 3, [4]));
  check(held() === "2,3,4" && entry().end === 4,
        "the front falls off to `len` (the backend's own keep), cursor unaffected, got " +
        held());

  const before = entry().version;
  foldAggs(store, wire(1, 9, 4, [7, 8]));
  check(held() === "7,8" && entry().end === 11,
        "a frame starting anywhere else DISCARDS and rebaselines from its own tail, got " +
        held());
  check(entry().version > before,
        "a rebaseline moves the version too: the reader must be told to redraw");

  foldAggs(store, wire(2, 0, 1, [9]));
  check(held() === "9" && entry().gen === 2,
        "a new GENERATION is a whole-store: the frame replaces, whatever the cursor said");

  foldAggs(store, { "1.ring": { gen: 2, from: "x", len: 1, values: [1] } });
  check(held() === "9", "a frame the view cannot read is dropped, never allowed to erase");

  foldAggs(store, { "1.ring": { gen: 3, nil: true } });
  check(entry().values === null && entry().version > before,
        "a Nil cell is held as null -- the honest UNKNOWN a reader falls back from");
  foldAggs(store, wire(3, 0, 2, [1, 2]));
  check(held() === "1,2", "and a later frame refills it through the same door");

  foldAggs(store, { "2.modes": { gen: 1, map: true, values: { high: 2, low: 1 } } });
  const map = store.get("2.modes");
  check(map && !Array.isArray(map.values) && map.values.low === 1,
        "a map rides whole on any change and is held as the object itself");
}

/* ---- A PLOT, END TO END: list slot -> map -> anchors -> path `d` (stage.ts) ----
   The privileged points-are-numbers branch AND the privileged hist cell are both gone.
   `points` is an ordinary expression over an ordinary LIST SLOT (the Trend's `history`),
   whose value arrives on the aggs lane and is served from the standing copy. A gap in
   the data is a gap in the line. */
{
  const plotStore = new DocStore();
  plotStore.load({
    version: 1, next_id: 999, globals: [], tokens: [], components: [],
    pages: [{ id: 970, name: "Plot", children: [
      { id: 971, kind: "frame", type: "Trend", name: "trend",
        attrs: {}, slots: {}, locals: [], feeds: [], flows: [] },
    ] }],
  });
  const K = (v) => ({ op: "CONST", v });
  const A = (i) => ({ op: "ARG", i });
  /* x is the element's index, y its value: one map over the slot, one anchor each */
  const pointsProgram = { code: [
    { op: "LOAD", cell: "slot:history" },
    { op: "ITERATE", mode: "MAP", body: [A(1), A(0), { op: "ANCHOR" }] },
  ] };
  /* the LAST element, read by index off the same slot */
  const lastProgram = { code: [
    { op: "LOAD", cell: "slot:history" },
    { op: "LOAD", cell: "slot:history" }, { op: "LENGTH" }, K(1), { op: "SUB" },
    { op: "INDEX" }, { op: "STR" },
  ] };
  const trace = { kind: "path", name: "trace", attrs: { points: pointsProgram },
                  anchors: [], closed: false };
  const plotType = {
    name: "Trend", slots: [], events: [], design_w: 220, design_h: 110,
    template: { kind: "frame", name: "", attrs: {}, children: [
      trace,
      { kind: "text", name: "last", attrs: { text: lastProgram } },
    ] },
  };
  const aggStore = new Map();
  const plotHost = new Element("section");
  const plotView = { mode: "edit", selection: [], element: "", hover: 0, state: {}, faults: {} };
  const plotEditor = {
    store: plotStore, registry: { version: 1, components: [plotType] },
    nodeAttrs: { 971: { attrs: {} } },
    live: { epoch: 1, values: {} }, view: plotView,
    agg: (key) => aggStore.get(key) ?? null,
    page: () => plotStore.pages()[0],
    contexts: [],
    root() { return this.page(); },
    artboard: () => ({ w: 1408, h: 792 }),
    enterComponent: () => undefined, exitTo: () => undefined, resizePreview: () => undefined,
    select: () => undefined,
  };
  const drawPlot = () => renderStage(plotHost, plotEditor);
  const traceD = () => plotHost.querySelector("path")?.getAttribute("d");
  const inks = () => plotHost.querySelectorAll(".ink-text").map((n) => n.textContent);

  foldAggs(aggStore, { "971.history": { gen: 1, from: 0, len: 8,
                                        values: [1, 2, null, 4] } });
  drawPlot();
  check(traceD() === "M0 1 L1 2 M3 4",
        "a gap BREAKS the line: the next element opens a new subpath, got " + traceD());
  check(inks()[0] === "4", "the same slot indexes as a plain list, got " + inks()[0]);

  /* AN APPEND MUST REPAINT: the render recorded the copy's VERSION, and the diff that
     decides which binds a live frame patches compares exactly that. A PLOT IS AN
     ORDINARY BIND — so the append rewrites one `d` on the path that was already there,
     which is what lets a press survive a streaming trend. */
  const standing = plotHost.querySelector("path");
  plotEditor.live = { epoch: 1, values: { "999.nothing": 1 } };
  drawPlot();
  check(plotHost.querySelector("path") === standing,
        "a live frame touching no consumed cell leaves the plot standing");
  foldAggs(aggStore, { "971.history": { gen: 1, from: 4, len: 8, values: [5] } });
  drawPlot();
  check(plotHost.querySelector("path") === standing && traceD() === "M0 1 L1 2 M3 4 L4 5",
        "while an appended element redraws that same path in place, got " + traceD());

  /* a Nil cell serves NOTHING, and the read falls through to what the document authors:
     the same honest fallback an omitted scalar key takes */
  foldAggs(aggStore, { "971.history": { gen: 2, nil: true } });
  drawPlot();
  check(inks()[0] === "--",
        "a Nil list serves nothing and the readout shows the UNKNOWN mark, got " + inks()[0]);
  foldAggs(aggStore, { "971.history": { gen: 3, from: 0, len: 8, values: [1, 2, 3] } });
  drawPlot();
  check(traceD() === "M0 1 L1 2 L2 3",
        "a rebaselined generation redraws from its own whole, got " + traceD());

  /* a closed path still closes: the fold produces anchors, and everything downstream of
     the anchors is what it always was */
  trace.closed = true;
  plotEditor.live = { epoch: 2, values: {} };
  drawPlot();
  check(traceD().endsWith(" Z"), "a closed path still gets its Z, got " + traceD());
  trace.closed = false;

  /* `points` that is not a list at all falls through to the authored anchors, which is
     how every ordinary shape is still drawn */
  trace.attrs.points = { code: [K("nope")] };
  trace.anchors = [{ x: { code: [K(0)] }, y: { code: [K(0)] } },
                   { x: { code: [K(1)] }, y: { code: [K(1)] } }];
  plotEditor.live = { epoch: 4, values: {} };
  drawPlot();
  check(traceD() === "M0 0 L1 1",
        "a non-list `points` leaves the authored anchors in charge, got " + traceD());
}

/* ---- TEST MODE: the pointer regime and the gesture arithmetic (stage.ts, gestures.ts) ----
   Outside edit mode the pointer OPERATES. A bare page node never takes it; an instance
   takes it only where a gesture would RUN something (INERT PASS-THROUGH: a Toggle's
   default toggles an unfed value, a Panel with no flows is a picture and presses pass
   through it). The drag arithmetic is pure, so the numbers pin exactly. */
{
  const { steppedValue, bearingDeg, sweepFraction, optionNames } =
    await import(mod("gestures.js"));
  const { operable } = await import(mod("slots.js"));

  /* THE OPTIONS ARE A LIST now, not a TypeRef the view expands: the param evaluates to a
     real list and the tray only has to read it */
  check(optionNames(["Off", "Low"]).join(",") === "Off,Low",
        "a list of names offers exactly those names");
  check(optionNames([1, 2.5]).join(",") === "1,2.5",
        "a number offers as its plain string, the way every other value renders");
  check(optionNames(["a", null, undefined, { x: 1 }, "b"]).join(",") === "a,b",
        "an element with no text to it is dropped, never offered as a blank row");
  check(optionNames("ValveCmd.mode").length === 0 && optionNames(null).length === 0,
        "and anything that is not a list offers nothing: no detents beats wrong ones");

  check(steppedValue(0.5, 0, 100, 0) === 50 && steppedValue(1.7, 0, 100, 0) === 100,
        "a range fraction maps into min..max and holds at the ends");
  check(steppedValue(0.5, 0, 100, 20) === 60,
        "a step quantizes to the range's own detents, got " + steppedValue(0.5, 0, 100, 20));
  check(bearingDeg(0, -1) === 0 && bearingDeg(1, 0) === 90 && bearingDeg(0, 1) === 180,
        "the bearing speaks the system's one convention: degrees, 0 up, clockwise");
  check(sweepFraction(-135, -135, 270) === 0 && sweepFraction(135, -135, 270) === 1 &&
          sweepFraction(0, -135, 270) === 0.5,
        "a bearing inside the sweep is its fraction of it");
  check(sweepFraction(170, -135, 270) === 1 && sweepFraction(-170, -135, 270) === 0,
        "a bearing in the dead arc belongs to the NEARER end, never wrapped");

  const toggleType = snapshot.registry.components.find((t) => t.name === "Toggle");
  const panelType = snapshot.registry.components.find((t) => t.name === "Panel");
  const inst = (type, extra) => ({ id: 1, kind: "frame", type, name: "w", attrs: {},
                                   slots: {}, locals: [], flows: [], ...extra });
  check(operable(inst("Toggle"), toggleType) === true,
        "a Toggle's default behavior writes its unbound value: operable");
  check(operable(inst("Toggle", { slots: { value: "@switch.on" } }), toggleType) === false,
        "the same Toggle BOUND is a pure view of the machine: inert");
  check(operable(inst("Panel"), panelType) === false,
        "a Panel with no flows is a picture: inert");
  check(operable(inst("Panel", { flows: [{ when: [{ kind: "event", name: "tap" }],
                                           when_mode: "first", do: [] }] }),
                 panelType) === true,
        "an authored flow on an event makes any instance operable");

  const tStore = new DocStore();
  tStore.load({
    version: 1, next_id: 999, globals: [], tokens: [], components: [],
    pages: [{ id: 960, name: "T", children: [
      { id: 961, kind: "frame", name: "box",
        attrs: { left: "22", top: "22", w: "220", h: "110" } },
      { id: 962, kind: "frame", type: "Toggle", name: "tog",
        attrs: { left: "264", top: "22", w: "132", h: "66" },
        slots: {}, locals: [], feeds: [], flows: [] },
      { id: 963, kind: "frame", type: "Panel", name: "pan",
        attrs: { left: "440", top: "22", w: "264", h: "176" },
        slots: {}, locals: [], feeds: [], flows: [] },
    ] }],
  });
  const prog3 = (v) => ({ code: [{ op: "CONST", v }] });
  const boxOf = (x, y, w, h) =>
    ({ attrs: { left: prog3(x), top: prog3(y), w: prog3(w), h: prog3(h) } });
  const tHost = new Element("section");
  const tView = { mode: "test", selection: [], element: "", hover: 0, state: {}, faults: {} };
  const tEditor = {
    store: tStore, registry: snapshot.registry,
    nodeAttrs: { 961: boxOf(22, 22, 220, 110), 962: boxOf(264, 22, 132, 66),
                 963: boxOf(440, 22, 264, 176) },
    live: { epoch: 1, values: {} }, view: tView,
    mesh: { entities: [], types: [] },
    page: () => tStore.pages()[0],
    contexts: [],
    root() { return this.page(); },
    artboard: () => ({ w: 1408, h: 792 }),
    enterComponent: () => undefined, exitTo: () => undefined, resizePreview: () => undefined,
    select: () => undefined, input: () => undefined,
  };
  renderStage(tHost, tEditor);
  const at = (id) => tHost.querySelectorAll("[data-id]")
    .find((n) => n.getAttribute("data-id") === String(id));
  check(at(961).style.pointerEvents === "none",
        "test mode: a bare page node never takes the operating pointer");
  check(at(962).style.pointerEvents === "auto",
        "test mode: an operable Toggle takes it");
  check(at(963).style.pointerEvents === "none",
        "test mode: an inert Panel lets the press through");
  const heldTog = at(962);
  tView.mode = "edit";
  renderStage(tHost, tEditor);
  check(!at(961).style.pointerEvents && !at(963).style.pointerEvents,
        "flipping the mode PATCHES the regime: edit takes it back off");
  check(at(962) === heldTog,
        "and every element stands through the flip: a mode is not a reason to rebuild");
}

/* ---- THE OPTIONS SLOT: a list spelling, and a picker that is sugar for writing one ----
   A Dropdown's options used to BE a TypeRef, so the row was a chip and nothing else. The
   value is a real list now -- a literal, or variants(Valve.mode) naming an enum's variants
   through the schema -- so the row is an ordinary field holding that text, with the type
   picker beside it writing the call the author would otherwise type by hand. */
{
  /* the popover places itself against the viewport, which this process otherwise has no
     notion of */
  globalThis.window = { innerWidth: 1280, innerHeight: 800 };
  const { valueEditor } = await import(mod("inspector/editors.js"));
  const optionsEditor = {
    ...editor,
    mesh: {
      entities: [],
      types: [{
        name: "Valve", entities: [],
        fields: [{ path: "mode", shape: "enum",
                   variants: [{ name: "Off", value: 0 }, { name: "On", value: 1 }] }],
      }],
    },
  };
  const written = [];
  let spelling = '["Off", "On"]';
  const optionsSpec = { name: "options", shape: "text", default: "", group: "config",
                        editor: "enum-type" };
  const optionsPanel = new Panel(new Element("div"));
  const drawOptions = () =>
    optionsPanel.render("options", (host) =>
      host.appendChild(valueEditor(optionsSpec, "text", "1:options", () => spelling,
                                   (next) => { spelling = next; written.push(next); },
                                   false, optionsEditor)));
  drawOptions();

  const optionsField = optionsPanel.host.querySelector(".field");
  const optionsChip = optionsPanel.host.querySelector(".source-chip");
  check(optionsField !== null && optionsChip !== null,
        "the options row is a field AND a picker, not a picker standing alone");
  check(optionsField.value === '["Off", "On"]',
        "the field carries the list spelling verbatim, got " + optionsField?.value);
  typeInto(optionsField, '["Off", "Low", "High"]');
  fire(optionsField, "change");
  check(written[written.length - 1] === '["Off", "Low", "High"]',
        "editing it commits the text as written, got " + written[written.length - 1]);

  fire(optionsChip, "click");
  const treeRow = (label) =>
    document.body.querySelectorAll(".stree-row")
      .find((r) => r.textContent.startsWith(label)) ?? null;
  check(treeRow("Valve") !== null, "the chip opens the type tree on the enums it may pick");
  fire(treeRow("Valve"), "click", { detail: 0 });
  fire(treeRow("mode"), "click", { detail: 0 });
  check(written[written.length - 1] === "variants(Valve.mode)",
        "and the pick writes the variants(...) call, got " + written[written.length - 1]);
  drawOptions();
  check(optionsField.value === "variants(Valve.mode)",
        "which the field then shows, like anything else the slot holds");
  document.activeElement = null;
}

/* ---- THE VALUE BOX on the attr rows (inspector redesign, phase 2) ----
   The unified input landed on the safest surface first: every attr row is now
   [icon | expression | browse] with the commit semantics UNCHANGED (text as typed,
   empty deletes the key), the icon obeying the handle's law (gestures only on a
   literal), and the transition popover's MS / EASE fields the same box. These are
   NEW checks; nothing above was touched. */
{
  globalThis.window = { innerWidth: 1280, innerHeight: 800,
                        addEventListener: () => undefined,
                        removeEventListener: () => undefined };
  store.apply(store.version() + 1, [
    { op: "insert", parent: 0, list: "components", node: {
      id: 9700, name: "VbComp", events: [], locals: [], attrs: {},
      children: [
        { id: 9711, kind: "text", name: "cap",
          attrs: { text: "'go'", size: "14", color: "#ff0000", align: "'center'",
                   bold: "state.pressed" } },
      ],
      behavior: [] } },
  ]);
  const vbOps = [];
  const vbEditor = {
    ...editor,
    componentSel: { component: 9700, node: 9711 },
    selectedNode: () => null,
    selectedInstance: () => null,
    /* commits land in the mirror too, so a later field reads what an earlier one wrote */
    apply: (ops) => {
      vbOps.push(...ops);
      store.apply(store.version() + 1, ops);
    },
  };
  const vbPanel = new Panel(new Element("aside"));
  vbPanel.render(designInspectorShape(vbEditor),
                 (host) => renderDesignInspector(host, vbEditor));
  const vbRow = (name) =>
    vbPanel.host.querySelectorAll(".attr-row")
      .find((row) => row.querySelector(".attr-name")?.textContent === name) ?? null;
  const lastAttrs = () => vbOps.findLast((o) => o.key === "attrs");

  /* the anatomy: one box per declared row — icon, input, browse (the attr scope always
     names at least the view's own inputs, so browse stands) */
  const sizeRow = vbRow("size");
  const sizeBox = sizeRow?.querySelector(".value-box") ?? null;
  check(sizeBox !== null, "a declared attr row carries a value box");
  check(sizeBox.querySelector(".vb-icon") !== null &&
        sizeBox.querySelector("input") !== null &&
        sizeBox.querySelector(".vb-browse") !== null,
        "with the literal icon, the expression input and the browse button");

  /* typing an expression commits it as the attr's text, as ever */
  const sizeInput = sizeBox.querySelector("input");
  typeInto(sizeInput, "10 + 4");
  fire(sizeInput, "change");
  check(lastAttrs()?.value?.size === "10 + 4",
        "typing into the box commits the attr as typed, got " +
          JSON.stringify(lastAttrs()?.value?.size));

  /* and clearing it back to empty still DELETES the key */
  typeInto(sizeInput, "");
  fire(sizeInput, "change");
  check(lastAttrs() && !("size" in lastAttrs().value),
        "an empty commit still deletes the key");

  /* the literal gate (the handle's law): an expression dims the scrub handle, a plain
     number arms it */
  typeInto(sizeInput, "value * 2");
  check(sizeRow.querySelector(".vb-icon").classList.contains("vb-dim"),
        "a num box holding an expression dims the scrub icon");
  typeInto(sizeInput, "14");
  check(!sizeRow.querySelector(".vb-icon").classList.contains("vb-dim") &&
        sizeRow.querySelector(".vb-icon").classList.contains("vb-scrub"),
        "and a plain number arms it again");

  /* the color icon is a swatch: a literal hex paints it, an expression paints the
     unknown treatment — never a stale color */
  const colorRow = vbRow("color");
  const swatch = colorRow?.querySelector(".vb-swatch") ?? null;
  check(swatch !== null &&
        String(swatch.style.background).includes("rgba(255, 0, 0"),
        "a literal hex paints the color box's swatch");
  const colorInput = colorRow.querySelector("input");
  typeInto(colorInput, "state.pressed.pick('#ffffff', '#000000')");
  check(swatch.classList.contains("vb-unknown"),
        "an expression paints the unknown treatment instead");

  /* the enum picker: align's variants ride the served note ("start | center | end"),
     the current one is checked, and a pick writes the QUOTED spelling the template
     compiler actually accepts (every built-in authors align: 'center') */
  const alignRow = vbRow("align");
  fire(alignRow.querySelector(".vb-icon"), "click");
  const ctxOverlay = document.body.children.find((n) => n.id === "ctx");
  const menuBox = ctxOverlay.children[0];
  const variantBtn = (name) =>
    menuBox.querySelectorAll("button")
      .find((b) => (b.innerHTML ?? "").includes(">" + name + "</span>")) ?? null;
  check(["start", "center", "end"].every((v) => variantBtn(v) !== null),
        "the enum picker lists the attr's variants");
  fire(variantBtn("start"), "click");
  check(lastAttrs()?.value?.align === "'start'",
        "picking writes the quoted variant spelling, got " +
          JSON.stringify(lastAttrs()?.value?.align));

  /* the transition popover's MS and EASE are value boxes now, writing the same
     whole-map set_prop as before */
  fire(sizeRow.querySelector(".transition-chip"), "click");
  check(menuBox.querySelectorAll(".value-box").length === 2,
        "the transition popover hosts two value boxes");
  const [msInput, easeInput] = menuBox.querySelectorAll(".value-box")
    .map((b) => b.querySelector("input"));
  typeInto(msInput, "250");
  fire(msInput, "change");
  const msOp = vbOps.findLast((o) => o.key === "transitions");
  check(msOp && msOp.value?.size?.ms === 250,
        "MS folds a plain number and writes the map, got " + JSON.stringify(msOp?.value));
  typeInto(easeInput, "linear");
  fire(easeInput, "change");
  const easeOp = vbOps.findLast((o) => o.key === "transitions");
  check(easeOp && easeOp.value?.size?.ms === 250 && easeOp.value?.size?.profile === "linear",
        "EASE joins it in the same row, got " + JSON.stringify(easeOp?.value));
  document.activeElement = null;
}

/* ---- SLOT ROWS ARE VALUE BOXES (inspector redesign, phase 4a) ----
   Every slot row is chassis + box now: label | [icon|expression|browse] | trail. The
   box speaks the document encoding directly (raw number/bool literals, strings as
   expressions), enum picks write the QUOTED variant spelling, a top-level ?: chain
   grows the cases disclosure below its row, and a slot reading a mesh FUNCTION gets
   the poll settings writing the instance's poll[slot]. */
{
  const meshFor4a = {
    entities: [
      { kind: "F", name: "sim/calc", type: "", writable: false, forceable: false,
        fields: [], returns: [{ path: "value", shape: "num" }] },
      { kind: "V", name: "cage/plc/IO", type: "IOBlock", writable: true, forceable: false,
        fields: [{ path: "temp", shape: "num" }, { path: "level", shape: "num" }] },
    ],
    types: [{
      name: "Valve", entities: [],
      fields: [{ path: "mode", shape: "enum",
                 variants: [{ name: "Off", value: 0 }, { name: "On", value: 1 }] }],
    }],
  };
  /* a Selector: an enum slot (drag), an options slot (enum-type) and a value slot */
  store.apply(store.version() + 1, [
    { op: "insert", parent: store.pages()[0].id, list: "children", node: {
      id: 9800, kind: "frame", type: "Selector", name: "sel4a", attrs: {},
      slots: {}, locals: [], flows: [] } },
  ]);
  const ops4a = [];
  const editor4a = {
    ...editor,
    mesh: meshFor4a,
    selectedNode: () => store.nodeAt(9800),
    selectedInstance: () => store.instance(9800),
    apply: (ops) => {
      ops4a.push(...ops);
      store.apply(store.version() + 1, ops);
    },
  };
  const panel4a = new Panel(new Element("aside"));
  const draw4a = () =>
    panel4a.render(inspectorShape(editor4a), (host) => renderInspector(host, editor4a));
  const row4a = (name) =>
    panel4a.host.querySelectorAll(".attr-row.slot-row")
      .find((r) => r.querySelector(".attr-name")?.textContent === name) ?? null;
  const echo4a = (name, value) =>
    store.apply(store.version() + 1, [{
      op: "set_prop", node: 9800, key: "slots",
      value: { ...(store.instance(9800).slots ?? {}), [name]: value } }]);
  const lastSlots = () => ops4a.findLast((o) => o.key === "slots");
  draw4a();

  /* the anatomy: a slot row is a chassis carrying one value box */
  const valueRow4a = row4a("value");
  const valueBox4a = valueRow4a?.querySelector(".value-box") ?? null;
  check(valueBox4a !== null, "a slot row carries a value box");
  check(valueBox4a.querySelector(".vb-icon") !== null &&
        valueBox4a.querySelector("input") !== null &&
        valueBox4a.querySelector(".vb-browse") !== null,
        "with the literal icon, the expression input and the browse button");
  /* ONE ICON LANGUAGE: both box buttons are .icon-btn; the browse rests hidden
     behind the vb-tail rule until the box is hovered or focused */
  check(valueBox4a.querySelector(".vb-icon").classList.contains("icon-btn"),
        "the box icon is an .icon-btn");
  check(valueBox4a.querySelector(".vb-browse").classList.contains("icon-btn"),
        "the browse button is an .icon-btn");
  check(valueBox4a.querySelector(".vb-browse").classList.contains("vb-tail"),
        "browse is tagged vb-tail — hidden at rest, revealed on hover/focus");
  /* the tail overlay: one container holds the trailing cells so a hover reveal
     never reflows the text */
  check(valueBox4a.querySelector(".vb-tail-box") !== null,
        "a slot row's box carries the .vb-tail-box tail container");
  check(valueBox4a.querySelector(".vb-tail-box").querySelector(".vb-browse") !== null,
        "and browse rides inside it");

  /* a num slot's box commits expression TEXT as typed — the string is the encoding */
  const startInput = row4a("start_angle").querySelector("input");
  typeInto(startInput, "@x + @y");
  fire(startInput, "change");
  check(lastSlots()?.value?.start_angle === "@x + @y",
        "typing an expression into a num slot commits the string, got " +
          JSON.stringify(lastSlots()?.value?.start_angle));
  typeInto(startInput, "-120");
  fire(startInput, "change");
  check(lastSlots()?.value?.start_angle === -120,
        "while a plain number rides RAW, got " +
          JSON.stringify(lastSlots()?.value?.start_angle));

  /* the enum slot's picker writes the QUOTED variant spelling — one rule, every tier */
  draw4a();
  fire(row4a("drag").querySelector(".vb-icon"), "click");
  const ctx4a = document.body.children.find((n) => n.id === "ctx");
  const menu4a = ctx4a.children[0];
  const variant4a = (name) =>
    menu4a.querySelectorAll("button")
      .find((b) => (b.innerHTML ?? "").includes(">" + name + "</span>")) ?? null;
  check(variant4a("radial") !== null && variant4a("linear") !== null,
        "the enum slot's picker lists the served variants");
  fire(variant4a("radial"), "click");
  check(lastSlots()?.value?.drag === "'radial'",
        "picking writes the quoted variant spelling, got " +
          JSON.stringify(lastSlots()?.value?.drag));

  /* THE CASES DISCLOSURE arms on a clean top-level ?: chain and round-trips edits */
  echo4a("value", "@cage/plc/IO.temp > 5 ? 'hot' : 'cold'");
  draw4a();
  const chainRow = row4a("value");
  const chip4a = chainRow.querySelector(".cases-chip");
  check(chip4a !== null, "a ?: chain grows the cases affordance on its row");
  /* the chip rides INSIDE the value box's tail overlay, as a tail icon */
  check(chainRow.querySelector(".value-box").querySelector(".vb-tail-box")
          ?.querySelector(".cases-chip") === chip4a,
        "the cases chip rides the box's tail container");
  check(chip4a.classList.contains("icon-btn") && chip4a.classList.contains("vb-tail"),
        "the chip is a plain .icon-btn tail cell");
  check(!chip4a.classList.contains("on"),
        "shut, it rests in the hidden-until-hover state");
  fire(chip4a, "click");
  draw4a();
  check(row4a("value").querySelector(".cases-chip").classList.contains("on"),
        "open, the chip wears .on — standing state stays visible without a hover");
  const casesHost = panel4a.host.querySelector(".cases-editor");
  check(casesHost !== null, "opening it builds the structured editor below the row");
  const caseInputs = casesHost.querySelectorAll("input");
  check(caseInputs.length === 3 &&
        caseInputs[0].value === "@cage/plc/IO.temp > 5" &&
        caseInputs[1].value === "'hot'" &&
        caseInputs[2].value === "'cold'",
        "one when/then pair and the else, parsed from the authored text, got " +
          caseInputs.map((i) => i.value).join(" | "));
  typeInto(caseInputs[1], "'warm'");
  fire(caseInputs[1], "change");
  check(lastSlots()?.value?.value === "@cage/plc/IO.temp > 5 ? 'warm' : 'cold'",
        "editing a branch writes back the exact chain shape, got " +
          JSON.stringify(lastSlots()?.value?.value));

  /* a PLAIN expression gets the wrap editor: + Case makes it the chain's else */
  echo4a("value", "@cage/plc/IO.temp");
  draw4a();
  const wrapHost = panel4a.host.querySelector(".cases-editor");
  check(wrapHost !== null && wrapHost.querySelectorAll("input").length === 1,
        "a plain expression shows its else row alone");
  fire(wrapHost.querySelectorAll(".dashed-btn")[0], "click");
  check(lastSlots()?.value?.value === "true ? @cage/plc/IO.temp : @cage/plc/IO.temp",
        "+ Case wraps it as the else branch, got " +
          JSON.stringify(lastSlots()?.value?.value));
  /* ...while a literal spelling and a dirty ?: text get no disclosure at all */
  echo4a("value", "'plain caption'");
  draw4a();
  check(row4a("value").querySelector(".cases-chip") === null,
        "a literal spelling gets no disclosure");
  echo4a("value", "a ? b");
  draw4a();
  check(row4a("value").querySelector(".cases-chip") === null,
        "an unpairable ?: never arms the editor — the box alone edits it");

  /* THE POLL SETTINGS, on exactly the rows whose expression reads a mesh function */
  check(row4a("value").querySelector(".poll-chip") === null,
        "no poll button while nothing reads a function");
  echo4a("value", "@sim/calc.value * 10");
  draw4a();
  const pollBtn = row4a("value").querySelector(".poll-chip");
  check(pollBtn !== null, "a slot reading a mesh FUNCTION grows the poll settings");
  check(row4a("value").querySelector(".value-box").querySelector(".vb-tail-box")
          ?.querySelector(".poll-chip") === pollBtn
        && pollBtn.classList.contains("vb-tail"),
        "the poll chip rides inside the box's tail container as a tail icon");
  fire(pollBtn, "click");
  const pollField = ctx4a.children[0].querySelector(".menu-field")
    ?.querySelector("input") ?? null;
  check(pollField !== null, "the settings popover hosts one HZ value box");
  typeInto(pollField, "5");
  fire(pollField, "change");
  const pollOp = ops4a.findLast((o) => o.key === "poll");
  check(pollOp && pollOp.value?.value === 5,
        "the rate lands in the instance's poll under the slot, got " +
          JSON.stringify(pollOp?.value));
  typeInto(pollField, "");
  fire(pollField, "change");
  const pollClear = ops4a.findLast((o) => o.key === "poll");
  check(pollClear && pollClear.value?.value === undefined,
        "and an empty rate deletes the key, got " + JSON.stringify(pollClear?.value));

  /* THE BROWSE TREE grows hierarchy for slot scope: the tree is the ONE universe now
     and names() its flat projection — the instance's slots NEST under a `instance`
     folder, struct and timer variables fold over their field leaves, entities fold
     by the / segments of their names, and every pick INSERTS a canonical spelling.
     The options slot's browse adds the schema's enum types. */
  echo4a("value", "");
  /* a struct and a timer variable, so their folders can be pinned */
  store.apply(store.version() + 1, [
    { op: "insert", parent: 9800, list: "locals",
      node: { id: 9860, name: "valve", type: "Valve", init: 0, persist: false } },
    { op: "insert", parent: 9800, list: "locals",
      node: { id: 9861, name: "cook", type: "timer", init: 0, persist: false } },
  ]);
  draw4a();
  document.activeElement = null;
  let boxInput4a = row4a("value").querySelector("input");
  fire(row4a("value").querySelector(".vb-browse"), "click");
  const vbrowse = document.body.children.find((n) => n.id === "vbrowse");
  check(vbrowse !== null && vbrowse.className.includes("on"),
        "the browse button opens the browse popover");
  const streeRow4a = (label) =>
    vbrowse.querySelectorAll(".stree-row")
      .find((r) => r.textContent.startsWith(label)) ?? null;
  check(streeRow4a("hmi") !== null && streeRow4a("dart") !== null,
        "the slot scope browses as the two-root source tree");
  /* the `this` folder: slots are ITS leaves, never flat rows at the hmi level */
  check(streeRow4a("this.value") === null,
        "no flat this.<slot> row stands at the top level");
  const thisFolder = streeRow4a("this");
  check(thisFolder !== null, "the `this` folder stands under hmi");
  fire(thisFolder, "click", { detail: 0 });
  check(streeRow4a("value") !== null, "and opens into its slot leaves");
  fire(streeRow4a("value"), "click", { detail: 0 });
  check(boxInput4a.value === "this.value",
        "picking a slot leaf inserts its this.<slot> spelling, got " +
          boxInput4a.value);
  check(!vbrowse.className.includes("on"), "and the pick closes the popover");

  /* a STRUCT variable is a pickable folder: the leaf inserts the dotted field, the
     row body the whole struct (the split-click idiom) */
  echo4a("value", "");
  draw4a();
  document.activeElement = null;
  boxInput4a = row4a("value").querySelector("input");
  fire(row4a("value").querySelector(".vb-browse"), "click");
  check(streeRow4a("mode") === null, "a shut variable folder hides its fields");
  /* a coordinate click left of the icon folds a row that both expands and picks */
  fire(streeRow4a("valve"), "click", { detail: 1, clientX: -1 });
  check(streeRow4a("mode") !== null, "a struct variable expands to its field leaves");
  fire(streeRow4a("mode"), "click", { detail: 0 });
  check(boxInput4a.value === "valve.mode",
        "a field leaf inserts the dotted spelling, got " + boxInput4a.value);
  echo4a("value", "");
  draw4a();
  document.activeElement = null;
  boxInput4a = row4a("value").querySelector("input");
  fire(row4a("value").querySelector(".vb-browse"), "click");
  fire(streeRow4a("valve"), "click", { detail: 0 });
  check(boxInput4a.value === "valve",
        "the folder row itself picks the whole struct, got " + boxInput4a.value);

  /* the timer folder lists its four read fields */
  echo4a("value", "");
  draw4a();
  document.activeElement = null;
  boxInput4a = row4a("value").querySelector("input");
  fire(row4a("value").querySelector(".vb-browse"), "click");
  fire(streeRow4a("cook"), "click", { detail: 1, clientX: -1 });
  check(streeRow4a("running") !== null && streeRow4a("remaining") !== null &&
        streeRow4a("duration") !== null && streeRow4a("progress") !== null,
        "a timer variable folders over running/remaining/duration/progress");

  /* the dart root: entities folder by the / segments of their names */
  check(streeRow4a("cage") !== null,
        "a path-spelled entity folders by its / segments");
  check(streeRow4a("IO") === null, "a shut folder hides what is under it");
  fire(streeRow4a("cage"), "click", { detail: 0 });
  fire(streeRow4a("plc"), "click", { detail: 0 });
  const ioRow = streeRow4a("IO");
  check(ioRow !== null, "opening the folders walks down to the entity");
  fire(ioRow, "click", { detail: 0 });   /* two fields: the entity row is a folder */
  check(streeRow4a("temp") !== null && streeRow4a("level") !== null,
        "an entity row opens into its field rows");
  fire(streeRow4a("temp"), "click", { detail: 0 });
  check(boxInput4a.value === "@cage/plc/IO.temp",
        "picking a field INSERTS the canonical reference spelling, got " +
          boxInput4a.value);
  check(!vbrowse.className.includes("on"), "and the pick closes the popover");

  /* the flat projection: autocomplete's names are DERIVED from the same tree — the
     slot spelling, the struct variable with its dot table, the timer, the mesh rows
     in reflection order */
  {
    const { slotScope } = await import(mod("inspector/scope.js"));
    const names4a = slotScope(editor4a, store.instance(9800)).names();
    const byLabel = (label) => names4a.find((n) => n.label === label) ?? null;
    check(byLabel("this.value")?.note === "slot",
          "names() projects the slot leaf back to its flat this.value row");
    const valveRow4a = byLabel("valve");
    check(valveRow4a?.shape === "struct" && valveRow4a?.note === "local" &&
          valveRow4a?.fields?.length === 1 && valveRow4a.fields[0].path === "mode",
          "a struct variable projects as ONE row carrying its dot table");
    check(byLabel("cook")?.fields?.length === 4,
          "a timer projects with its four fields behind the dot");
    check(byLabel("@sim/calc")?.note === "mesh" &&
          byLabel("@cage/plc/IO.temp")?.note === "mesh",
          "the mesh projects to its @ spellings");
    const meshAt = names4a.findIndex((n) => n.label === "@sim/calc");
    check(meshAt >= 0 && names4a[meshAt + 1]?.label === "@cage/plc/IO.temp",
          "in reflection order, behind the hmi names");
  }

  /* the options-shaped box: the enum types ride its browse tree (the old chip's job) */
  document.activeElement = null;
  const optionsInput4a = row4a("options").querySelector("input");
  fire(row4a("options").querySelector(".vb-browse"), "click");
  check(streeRow4a("enum types") !== null,
        "an options box's browse carries the enum types section");
  const valveRow = streeRow4a("Valve.mode");
  check(valveRow !== null, "listing the schema's enums");
  fire(valveRow, "click", { detail: 0 });
  check(optionsInput4a.value === "variants(Valve.mode)",
        "picking one inserts the variants(...) call, got " + optionsInput4a.value);
  document.activeElement = null;
}

/* ---- FLOW FIELDS ARE VALUE BOXES + THE SWEEP POPOVER + THE ONE CHIP (phase 4b) ----
   Every expression a flow row holds — a gate's condition, a move's expression source,
   a raise's arguments, the beat's ms — is the same box the attr and slot rows wear,
   over flowScope (wire tier, where x IS legal). The prop SWEEP row dissolved into the
   attr rows' motion popover. Every picked reference is ONE chip builder now. */
{
  const { closeSourceTree } = await import(mod("inspector/sourcetree.js"));
  const { closeTypeTree } = await import(mod("inspector/typetree.js"));
  const { closeMenu } = await import(mod("menu.js"));
  document.activeElement = null;

  /* a Slider with a flow: gate, assign, raise — every expression
     surface a step can hold */
  store.apply(store.version() + 1, [
    { op: "insert", parent: store.pages()[0].id, list: "children", node: {
      id: 9900, kind: "frame", type: "Slider", name: "sl4b", attrs: {},
      slots: {}, locals: [],
      flows: [{ id: 9901, when: [{ kind: "event", name: "changed" }], when_mode: "first",
                do: [
                  { id: 9902, kind: "gate", a: "value > 5" },
                  { id: 9903, kind: "assign", from: { expr: "" }, to: { local: "", path: "" } },
                  { id: 9904, kind: "raise", event: "changed", args: {} },
                ] }] } },
  ]);
  const ops4b = [];
  const editor4b = {
    ...editor,
    selectedNode: () => store.nodeAt(9900),
    selectedInstance: () => store.instance(9900),
    apply: (ops) => {
      ops4b.push(...ops);
      store.apply(store.version() + 1, ops);
    },
  };
  const panel4b = new Panel(new Element("aside"));
  const draw4b = () =>
    panel4b.render(inspectorShape(editor4b), (host) => renderInspector(host, editor4b));
  draw4b();

  /* open the flow card: the DO rows are structure keyed on the fold */
  fire(panel4b.host.querySelector(".card-head"), "click");
  draw4b();
  const rowByVerb = (verb) =>
    panel4b.host.querySelectorAll(".do-row")
      .find((r) => r.querySelector(".do-verb")?.textContent === verb) ?? null;

  /* the gate's condition: a value box, committing as typed */
  const gateRow = rowByVerb("if");
  const gateBox = gateRow?.querySelector(".value-box") ?? null;
  check(gateBox !== null, "a gate's condition is a value box on its row");
  check(gateBox.querySelector(".vb-icon") !== null &&
        gateBox.querySelector(".vb-browse") !== null,
        "wearing the box's own icon and browse anatomy");
  const gateInput = gateBox.querySelector("input");
  check(gateInput.value === "value > 5",
        "showing the authored condition, got " + gateInput.value);
  typeInto(gateInput, "value > 10");
  fire(gateInput, "change");
  const gateOp = ops4b.findLast((o) => o.node === 9902 && o.key === "a");
  check(gateOp?.value === "value > 10",
        "committing writes the step's own field as typed, got " +
          JSON.stringify(gateOp?.value));

  /* x IS legal on a flow box: the wire tier serves the pipeline register */
  typeInto(gateInput, "");
  const acPop = document.body.querySelector(".ac-pop");
  check(acPop !== null, "an emptied flow box offers its vocabulary");
  const acNames = acPop.querySelectorAll(".ac-name").map((n) => n.textContent);
  check(acNames[0] === "x",
        "and x leads it — the register is legal here, unlike a slot's box, got " +
          acNames.slice(0, 3).join(","));
  /* the dropdown caps at 14 rows, so ask for the parameter by prefix (the caret is
     placed by hand: the shim's typeInto leaves selectionStart at 0) */
  gateInput.value = "va";
  gateInput.setSelectionRange(2, 2);
  fire(gateInput, "input");
  const acFiltered = document.body.querySelector(".ac-pop")
    ?.querySelectorAll(".ac-name").map((n) => n.textContent) ?? [];
  check(acFiltered.includes("value"),
        "the trigger's parameter is offered by its declared name too, got " +
          acFiltered.join(","));
  typeInto(gateInput, "value > 10");
  fire(gateInput, "change");
  fire(gateInput, "blur");

  /* the assignment's rvalue: ONE expression box (a read and a write are the same
     thing), and browse-insert is the box's own affordance */
  const writeRow = rowByVerb("assign");
  const fromBox = writeRow?.querySelector(".value-box") ?? null;
  check(fromBox !== null && writeRow.querySelector(".expr-pick") === null,
        "an assignment's rvalue is the same box — the fused expr-pick is gone");
  document.activeElement = null;
  const fromInput = fromBox.querySelector("input");
  fire(fromBox.querySelector(".vb-browse"), "click");
  const vb4b = document.body.children.find((n) => n.id === "vbrowse");
  check(vb4b !== null && vb4b.className.includes("on"),
        "the box's browse opens the popover");
  const flat4b = (label) =>
    vb4b.querySelectorAll(".stree-row")
      .find((r) => r.textContent.startsWith(label)) ?? null;
  /* the flow scope browses HIERARCHICALLY now: its own names lead (the trigger's
     parameter), then the hmi root — one universe with the dropdown */
  check(flat4b("this flow") !== null,
        "a flow box's browse leads with the flow's own names");
  check(flat4b("value") !== null,
        "the trigger's parameter stands under it");
  /* the `this` folder nests the slots here too (left open by the slot-tier leg —
     the fold state is shared across boxes); the slot leaf is the LAST row labelled
     `value`, behind the flow's parameter of the same name */
  check(flat4b("this.value") === null,
        "no flat this.<slot> row in a flow browse either");
  check(flat4b("this") !== null, "the `this` folder frames the slots");
  const slotLeaf4b = vb4b.querySelectorAll(".stree-row")
    .filter((r) => r.textContent.startsWith("value"))
    .at(-1) ?? null;
  fire(slotLeaf4b, "click", { detail: 0 });
  check(fromInput.value === "this.value",
        "picking the slot leaf inserts the canonical spelling, got " + fromInput.value);
  check(!vb4b.className.includes("on"), "and the pick closes the popover");
  fire(fromInput, "change");
  const fromOp = ops4b.findLast((o) => o.node === 9903 && o.key === "from");
  check(fromOp?.value?.expr === "this.value",
        "committing writes the expression side form, got " + JSON.stringify(fromOp?.value));

  /* THE ENTITY ROOTS IN A FLOW: with a mesh reflected, the same rvalue box browses
     the dart hierarchy the slot tier serves, and a pick inserts the @ spelling */
  const editor4c = {
    ...editor4b,
    mesh: {
      entities: [
        { kind: "V", name: "plant/temp", writable: true,
          fields: [{ path: "value", shape: "num" }, { path: "alarm", shape: "bool" }] },
      ],
      types: [],
    },
  };
  panel4b.render(inspectorShape(editor4c) + ":mesh",
                 (host) => renderInspector(host, editor4c));
  const fromBox4c = panel4b.host.querySelectorAll(".do-row")
    .find((r) => r.querySelector(".do-verb")?.textContent === "assign")
    ?.querySelector(".value-box") ?? null;
  const fromInput4c = fromBox4c.querySelector("input");
  document.activeElement = null;
  fire(fromBox4c.querySelector(".vb-browse"), "click");
  const vb4c = document.body.children.find((n) => n.id === "vbrowse");
  const row4c = (label) =>
    vb4c.querySelectorAll(".stree-row")
      .find((r) => r.textContent.startsWith(label)) ?? null;
  check(row4c("dart") !== null,
        "a flow box's browse offers the mesh root — the entity vocabulary reached flows");
  /* dart starts expanded: its folders already stand */
  fire(row4c("plant"), "click", { detail: 0 });
  fire(row4c("temp"), "click", { detail: 0 });
  const leaf4c = row4c("alarm");
  check(leaf4c !== null, "an entity opens into its field leaves");
  fire(leaf4c, "click", { detail: 0 });
  check(fromInput4c.value.endsWith("@plant/temp.alarm"),
        "and the pick inserts the @ spelling, got " + fromInput4c.value);
  fire(fromInput4c, "change");
  const fromOp4c = ops4b.findLast((o) => o.node === 9903 && o.key === "from");
  check(String(fromOp4c?.value?.expr ?? "").includes("@plant/temp.alarm"),
        "which commits into the rvalue, got " + JSON.stringify(fromOp4c?.value));

  /* THE STEP MENU: one `assign` entry inserts the step with its holes visible */
  const plus4c = panel4b.host.querySelectorAll("button")
    .find((b) => b.textContent === "+ step");
  fire(plus4c, "click");
  const menuHost4c = document.body.children.find((n) => n.id === "ctx");
  /* menu rows are icon+label markup: the shim keeps innerHTML verbatim, so match it */
  const menuRow4c = menuHost4c.querySelectorAll("button")
    .find((r) => (r.innerHTML ?? "").includes(">assign<")) ?? null;
  check(menuRow4c !== null, "the step menu offers `assign` (read and write are gone)");
  check(!menuHost4c.querySelectorAll("button")
          .some((r) => (r.innerHTML ?? "").includes(">read<") ||
                       (r.innerHTML ?? "").includes(">write<")),
        "and no read/write entries remain");
  fire(menuRow4c, "click");
  const insOp = ops4b.findLast((o) => o.op === "insert" && o.list === "do");
  check(insOp?.node?.kind === "assign" &&
        typeof insOp.node.from?.expr === "string" &&
        insOp.node.to?.local === "",
        "picking it inserts an assign step — rvalue expression, unpicked target, got " +
          JSON.stringify(insOp?.node));
  closeMenu();

  /* the raise's argument: one box per declared parameter, bound by NAME */
  const raiseRow = rowByVerb("raise");
  const raiseBox = raiseRow?.querySelector(".value-box") ?? null;
  check(raiseBox !== null && raiseRow.textContent.includes("value:"),
        "a raise parameter is a value box named by the signature");
  const raiseInput = raiseBox.querySelector("input");
  typeInto(raiseInput, "value * 2");
  fire(raiseInput, "change");
  fire(raiseInput, "blur");
  const argOp = ops4b.findLast((o) => o.node === 9904 && o.key === "args");
  check(argOp && argOp.value?.value === "value * 2",
        "committing binds the argument by name, got " + JSON.stringify(argOp?.value));

  /* the move target is the ONE reference chip: ghost while nothing is picked,
     click opens the source tree */
  const toChip = writeRow.querySelector(".source-chip");
  check(toChip !== null && toChip.className.includes("ghost-chip") &&
        toChip.querySelector(".name")?.textContent === "pick target",
        "an unpicked move target wears the ghost reference chip");
  fire(toChip, "click");
  const stree4b = document.body.children.find((n) => n.id === "stree");
  check(stree4b !== null && stree4b.className.includes("on"),
        "clicking the chip opens the source tree");
  closeSourceTree();

  /* the vars TYPE chip is the same builder, opening the TYPE tree */
  store.apply(store.version() + 1, [
    { op: "insert", parent: 9900, list: "locals",
      node: { id: 9940, name: "t1", type: "num", init: 0, persist: false } },
  ]);
  draw4b();
  const varHead = panel4b.host.querySelectorAll(".card-head")
    .find((h) => h.querySelector(".now-value") !== null);
  fire(varHead, "click");
  draw4b();
  const typeChip = panel4b.host.querySelectorAll(".card")
    .find((c) => c.querySelector(".now-value") !== null)
    ?.querySelector(".source-chip") ?? null;
  check(typeChip !== null && typeChip.querySelector(".name")?.textContent === "number",
        "a variable's TYPE wears the same chip, reading its scalar label");
  fire(typeChip, "click");
  const ttree4b = document.body.children.find((n) => n.id === "ttree");
  check(ttree4b !== null && ttree4b.className.includes("on"),
        "and clicking it opens the type tree");
  closeTypeTree();
  document.activeElement = null;

  /* ---- the SWEEP popover: a num INPUT's smooth/profile behind the same motion button
     the attr rows wear — the inline SWEEP row is gone, and so is speed. The chip lives
     in the variable card's own body now, so the card is opened to reach it ---- */
  store.apply(store.version() + 1, [
    { op: "insert", parent: 0, list: "components", node: {
      id: 9930, name: "Sweep4b", events: [],
      locals: [
        { id: 9931, name: "rate", type: "num", init: 1, group: "value", public: true },
        { id: 9932, name: "tint", type: "color", init: "#123456", group: "appearance",
          public: true },
      ],
      attrs: {}, children: [], behavior: [] } },
  ]);
  const swOps = [];
  const swEditor = {
    ...editor,
    componentSel: { component: 9930, node: 9930 },
    selectedNode: () => null,
    selectedInstance: () => null,
    apply: (ops) => {
      swOps.push(...ops);
      store.apply(store.version() + 1, ops);
    },
  };
  const swPanel = new Panel(new Element("aside"));
  const drawSw = () =>
    swPanel.render(designInspectorShape(swEditor),
                   (host) => renderDesignInspector(host, swEditor));
  drawSw();
  const varCardNamed = (name) =>
    swPanel.host.querySelectorAll(".card")
      .find((r) => r.querySelectorAll("input").some((i) => i.value === name)) ?? null;
  /* a card is folded until it is asked for — the same caret every card wears */
  const openCard = (name) => {
    const card = varCardNamed(name);
    if (card && !card.className.includes("open")) {
      fire(card.querySelector(".card-head"), "click");
      drawSw();
    }
    return varCardNamed(name);
  };
  check(!swPanel.host.textContent.includes("SWEEP MS"),
        "the inline SWEEP row is gone from the variable card");
  const sweepBtn = openCard("rate")?.querySelector(".transition-chip") ?? null;
  check(sweepBtn !== null, "a num input wears the motion button instead");
  check(openCard("tint")?.querySelector(".transition-chip") === null,
        "a colour one does not — it cross-fades on the attr that draws it");
  check(!sweepBtn.classList.contains("on"), "unlit while no sweep stands");

  fire(sweepBtn, "click");
  const ctx4b = document.body.children.find((n) => n.id === "ctx");
  const menu4b = ctx4b.children[0];
  const sweepBoxes = menu4b.querySelectorAll(".value-box");
  check(sweepBoxes.length === 2,
        "the popover hosts MS and EASE value boxes and nothing else — speed is gone");
  const [msIn4b, easeIn4b] = sweepBoxes.map((b) => b.querySelector("input"));
  typeInto(msIn4b, "800");
  fire(msIn4b, "change");
  const msOp4b = swOps.findLast((o) => o.key === "smooth");
  check(msOp4b && msOp4b.node === 9931 && msOp4b.value === 800,
        "MS folds a plain number into smooth, got " + JSON.stringify(msOp4b?.value));
  typeInto(easeIn4b, "linear");
  fire(easeIn4b, "change");
  const easeOp4b = swOps.findLast((o) => o.key === "profile");
  check(easeOp4b && easeOp4b.node === 9931 && easeOp4b.value === "linear",
        "EASE writes profile beside it, got " + JSON.stringify(easeOp4b?.value));
  typeInto(msIn4b, "1000 / rate");
  fire(msIn4b, "change");
  check(swOps.findLast((o) => o.key === "smooth")?.value === "1000 / rate",
        "an expression rides as text — the compiler is the teacher");
  closeMenu();
  drawSw();
  /* the card rebuilt around it, so the chip is re-read rather than held across the draw */
  const litBtn = openCard("rate")?.querySelector(".transition-chip") ?? null;
  check(litBtn !== null && litBtn.classList.contains("on"),
        "the button lights while a sweep stands");

  fire(litBtn, "click");
  const removeRow = menu4b.querySelectorAll("button")
    .find((b) => (b.innerHTML ?? "").includes("remove the sweep"));
  check(removeRow !== undefined, "a standing sweep offers its removal");
  fire(removeRow, "click");
  const cleared = swOps.slice(-2);
  check(cleared[0]?.key === "smooth" && cleared[0].value === 0 &&
        cleared[1]?.key === "profile" && cleared[1].value === "",
        "removing clears smooth and profile in one act, got " + JSON.stringify(cleared));
  drawSw();
  check(!sweepBtn.classList.contains("on"), "and the light goes out");
  document.activeElement = null;

  /* ---- A LIST OF ROWS: the OF picker offers list and map beside the scalars, and
     picking one brings the ROWS OF picker that says what a row holds. Nesting is one
     level, so that second picker offers scalars only, and stepping OF back to a scalar
     clears the leaf in the SAME apply — a row type cannot outlive the row. ---- */
  store.apply(store.version() + 1, [
    { op: "insert", parent: 9930, list: "locals", node: {
      id: 9933, name: "grid", type: "list", init: null, persist: false } },
  ]);
  drawSw();
  const ofPicker = (name, label) => {
    const card = openCard(name);
    const labels = card.querySelectorAll(".row-label");
    const at = labels.findIndex((r) => (r.textContent ?? "") === label);
    return at < 0 ? null : card.querySelectorAll("select")[
      labels.slice(0, at).filter((r) => ["OF", "ROWS OF"].includes(r.textContent ?? ""))
        .length];
  };
  const ofSel = ofPicker("grid", "OF");
  check(ofSel !== null &&
          ofSel.children.map((o) => o.value).join(",") ===
            ",num,bool,text,color,icon,list,map",
        "OF offers the scalars and then list/map — elements that are ROWS");
  check(ofPicker("grid", "ROWS OF") === null,
        "a list of scalars has no leaf to declare");
  ofSel.value = "list";
  fire(ofSel, "change");
  drawSw();
  const rowsSel = ofPicker("grid", "ROWS OF");
  check(rowsSel !== null &&
          rowsSel.children.map((o) => o.value).join(",") ===
            ",num,bool,text,color,icon",
        "elements that are rows bring ROWS OF, scalars only — nesting is one level");
  rowsSel.value = "num";
  fire(rowsSel, "change");
  check(swOps.findLast((o) => o.key === "leaf")?.value === "num",
        "and it writes the leaf type");
  const { aggLabel } = await import(mod("types.js"));
  check(aggLabel("list", "list", "num") === "list of list of number",
        "which reads as a list of list of number wherever a variable names its shape");
  const backToScalar = ofPicker("grid", "OF");
  backToScalar.value = "text";
  fire(backToScalar, "change");
  const stepped = swOps.slice(-2);
  check(stepped[0]?.key === "elem" && stepped[0].value === "text" &&
        stepped[1]?.key === "leaf" && stepped[1].value === "",
        "stepping back to a scalar element clears the leaf in the same apply, got " +
          JSON.stringify(stepped));
  drawSw();
  check(ofPicker("grid", "ROWS OF") === null, "and the row disappears with it");
}

/* What used to close this file -- the repeat/path round trip and the code-element escape
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
