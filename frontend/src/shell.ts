/* The application shell: the frame (topbar, workspace tabs, mode switch) around the
 * workspaces, and the wiring between the connection, the document mirror and the
 * sidebars. The content workspace is the three-column editor; the shell holds only view
 * state (selection, mode, active workspace, sidebar widths); every edit leaves as an op
 * and comes back as a broadcast, so two windows are always looking at the same document.
 *
 * THE STAGE IS REAL DOM (stage.ts). A page is nested divs laid out by flex, so hit
 * testing, resizing and scaling are the browser's, not ours: what stood here to do those
 * jobs by hand — the two artboard SVGs, the template renderer, the pan/zoom camera, the
 * drag-move and resize grips, the four interaction primitives — is gone rather than
 * ported. This file keeps the half that was never about pixels: the connection, the
 * document mirror, selection, the four workspaces' panels, and structural editing by TREE
 * POSITION rather than by coordinate. */

import { DropPlan, fmtFraction, fmtPx, holds, literalNumber, snapPx } from "./arrange.js";
import { DocStore } from "./doc.js";
import { clear, el, iconButton } from "./dom.js";
import { AggEntry, Editor, foldAggs, Mode, StageContext, ViewState } from "./editor.js";
import { LogView } from "./logbar.js";
import { armSwallow, closeMenu, openMenu } from "./menu.js";
import { inspectorShape, leftShape, renderInspector, renderLeftSidebar } from "./inspector/panel.js";
import { refreshSourceTree } from "./inspector/sourcetree.js";
import { pageSelectShape, renderPageSelect } from "./pageselect.js";
import { Connection, Status } from "./protocol.js";
import { Panel } from "./reconcile.js";
import { previewArrangement, renderStage, stageScale } from "./stage.js";
import { AttrTable, BuiltinDef, CANVAS_H, CANVAS_W, Diag, Doc, Json, Lang, Live, Mesh, Node, NodeAttrs, NodeKind, Op, Page, Registry, RepeatCopy, primitiveDef } from "./types.js";
import { buildWorkspaces, Workspace, WorkspaceId } from "./workspaces.js";
import { dataShape, renderDataDetail, renderDataTree } from "./workspaces/data.js";
import { designInspectorShape, designShape, renderDesignInspector, renderDesignTree } from "./workspaces/design.js";
import { renderStyleWorkspace, styleShape } from "./workspaces/style.js";

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 800;

export class App implements Editor {
  store = new DocStore();
  registry: Registry | null = null;
  /* every PAGE node's compiled attrs, keyed by node id: the other half of the compile
     product, and what lets the renderer run one interpreter over a page and a component */
  nodeAttrs: Record<string, NodeAttrs> = {};
  /* the reflected entity tree, served by the backend: the "dart" root of the coming
     source picker (stage 6); the "hmi" root is the document's own variables */
  mesh: Mesh = { entities: [], types: [] };
  /* the served expression vocabulary: autocomplete reads exactly what compiles */
  lang: Lang | null = null;
  /* the closed attr vocabulary, snapshot-only like `lang`: the element
     inspector's Attrs section lists exactly this, set or not */
  attrTable: AttrTable | null = null;
  /* the built-ins' editable document form, snapshot-only (it never changes at runtime):
     the Components tree browses it and a fork copies one entry into doc.components */
  builtins: BuiltinDef[] = [];
  /* the component-edit selection; mutually exclusive with the instance selection */
  componentSel: { component: number; node: number } | null = null;
  /* the built-in being browsed read-only: its name plus a child-index path into its
     elements ("" = the component itself). Mutually exclusive with the other two. */
  builtinSel: { name: string; path: string } | null = null;
  live: Live | null = null;
  diagnostics: Diag[] = [];
  /* the standing aggregate cells, folded from every frame's `aggs` deltas (editor.ts):
     the wire carries what is new, this holds what there is */
  private aggs = new Map<string, AggEntry>();
  /* the entered-component stack (editor.ts): empty = editing the page itself. Never synced
     and never persisted, like the selection it travels with. */
  contexts: StageContext[] = [];
  view: ViewState = {
    mode: "edit", selection: [], element: "", hover: 0, state: {}, faults: {},
    /* the theme preview mode is a local preference, like the sidebar widths */
    themeMode: localStorage.getItem("theme-mode") === "light" ? "light" : "dark",
  };

  private conn: Connection;
  private pageId = 0;
  private workspaces: Workspace[] = [];
  private workspace: WorkspaceId = "content";
  /* the topbar controls that act on the artboard: hidden over Data and Style */
  private stageTools: HTMLElement[] = [];
  private nodes!: {
    left: HTMLElement;
    inspector: HTMLElement;
    stage: HTMLElement;
    banner: HTMLElement;
    problems: HTMLElement;
    pill: HTMLElement;
  };
  private sidebars!: { left: Panel; inspector: Panel };
  /* the Style and Data workspaces' reconciled panels and the topbar page selector's
     (pageselect.ts); all null when operating */
  private stylePanel: Panel | null = null;
  private dataTreePanel: Panel | null = null;
  private dataDetailPanel: Panel | null = null;
  private designTreePanel: Panel | null = null;
  private designInspectorPanel: Panel | null = null;
  private pagePanel: Panel | null = null;
  /* our "+ New page" is in flight: the echo carries the issued id, switch to it there */
  private pendingPage = false;
  /* our wrap is in flight: the frame the backend makes is named for the first time in the
     echo, and that is where the selection can follow it */
  private pendingGroup = false;
  /* a just-forked or just-added component's name: its insert is in flight, and the ids
     the backend issues arrive with the echo, so selection resolves there by name */
  private pendingComponent: string | null = null;
  private frame = 0;
  private sidebarsDirty = true;
  /* the gesture sequence (protocol `input.seq`): monotonic for the session's life */
  private inputSeq = 1;
  /* the log sidebar + its toasts (logbar.ts): built in every view, operate included —
     an operator is exactly who an error notification is for */
  private logView!: LogView;

  /* `operate` is the deployed view: no topbar, no sidebars, the artboard alone */
  constructor(private shellHost: HTMLElement, url: string, private operate = false) {
    this.build();
    if (this.operate) this.setMode("operate");
    this.conn = new Connection(url, {
      snapshot: (doc, registry, live, diag, mesh, lang, attrTable, builtins, nodeAttrs) =>
        this.onSnapshot(doc, registry, live, diag, mesh, lang, attrTable, builtins,
                        nodeAttrs),
      mesh: (mesh) => {
        this.mesh = { entities: mesh?.entities ?? [], types: mesh?.types ?? [] };
        refreshSourceTree();
        this.queueSidebars();
      },
      ops: (version, ops) => this.onOps(version, ops),
      /* a live frame and a document echo are the same event to a sidebar: re-read and
         assign. The sidebars decide for themselves whether anything structural moved. */
      live: (live) => {
        this.live = live;
        foldAggs(this.aggs, live?.aggs);
        this.queueSidebars();
      },
      diag: (rows) => this.onDiag(rows),
      log: (entries, fresh) => this.logView.log(entries, fresh),
      status: (state, detail) => this.onStatus(state, detail),
    });
  }

  start(): void {
    this.conn.connect();
  }

  /* ---- Editor interface ---- */

  page(): Page | null {
    return this.store.page(this.pageId) ?? this.store.pages()[0] ?? null;
  }

  agg(key: string): AggEntry | null {
    return this.aggs.get(key) ?? null;
  }

  /* THE EDITING ROOT: the page, or — inside an entered instance — the component shaped as
     one (a ComponentDef is {id, name, children} too, and its children array is the LIVE
     array, so the drop plans splice what the document holds). Null while looking at an
     unforked built-in: its nodes are nobody's to edit. */
  root(): Page | null {
    const ctx = this.contexts[this.contexts.length - 1];
    if (!ctx) return this.page();
    if (!ctx.component) return null;
    const comp = this.store.node(ctx.component);
    return comp
      ? { id: comp.id, name: comp.name ?? "", children: comp.children ?? [] }
      : null;
  }

  artboard(): { w: number; h: number } {
    const ctx = this.contexts[this.contexts.length - 1];
    return ctx ? { w: ctx.w, h: ctx.h } : { w: CANVAS_W, h: CANVAS_H };
  }

  /* ENTER A COMPONENT: the instance's component becomes the editing context — the same
     artboard editing on its own design frame, editing the COMPONENT (every instance
     follows) — previewed at this instance's rendered size, with this instance's data.
     An unforked built-in enters READ-ONLY (component 0): its nodes carry no ids until
     Override copies it into the document, and the context upgrades itself when that
     echo lands (settleContexts). */
  enterComponent(id: number, path?: string): void {
    const inst = this.store.instance(id);
    const type = inst?.type ?? "";
    if (!inst || !type) return;
    const comp = this.store.components().find((c) => c.name === type) ?? null;
    if (!comp && !this.builtins.some((b) => b?.name === type)) return;
    const box = this.canvasBox(id);
    const spec = (this.registry?.components ?? []).find((t) => t.name === type);
    const w = Math.max(44, Math.round(box?.w ?? spec?.design_w ?? 240));
    const h = Math.max(44, Math.round(box?.h ?? spec?.design_h ?? 120));
    this.contexts.push({ component: comp?.id ?? 0, builtin: comp ? "" : type,
                         from: id, w, h, w0: w, h0: h });
    this.view.selection = [];
    this.view.element = "";
    this.setHover(0);
    /* land selected on the internal node the author pointed at (a fenced tree row):
       the path is template names joined with dots, walked down the component's own
       children by name */
    if (path && comp) {
      let at: Node | undefined;
      let kids: Node[] = comp.children ?? [];
      for (const segment of path.split(".")) {
        at = kids.find((n) => (n.name || n.kind) === segment);
        if (!at) break;
        kids = at.children ?? [];
      }
      if (at) this.view.selection = [at.id];
    }
    this.queueSidebars();
  }

  /* step out to `depth` contexts (0 = the page), landing selected on the instance the
     dropped context was entered through — back exactly where the author left */
  exitTo(depth: number): void {
    if (depth >= this.contexts.length) return;
    const dropped = this.contexts[depth];
    this.contexts.length = depth;
    this.view.selection = dropped && this.store.nodeAt(dropped.from) ? [dropped.from] : [];
    this.view.element = "";
    this.setHover(0);
    this.queueSidebars();
  }

  /* the context's preview box: session-local, never written anywhere */
  resizePreview(w: number, h: number): void {
    const ctx = this.contexts[this.contexts.length - 1];
    if (!ctx || (ctx.w === w && ctx.h === h)) return;
    ctx.w = w;
    ctx.h = h;
    this.queueSidebars();
  }

  /* a context stands while what it points at does. A deleted component (or entered-from
     instance) drops the stack from that level; an unforked built-in whose Override just
     landed upgrades IN PLACE to the doc component, which is what arms editing the moment
     the fork's echo arrives. */
  private settleContexts(): void {
    for (let i = 0; i < this.contexts.length; i++) {
      const ctx = this.contexts[i];
      if (!ctx.component && ctx.builtin) {
        const held = this.store.components().find((c) => c.name === ctx.builtin);
        if (held) {
          ctx.component = held.id;
          ctx.builtin = "";
        }
      }
      const alive = this.store.nodeAt(ctx.from) &&
        (ctx.component ? this.store.node(ctx.component) : ctx.builtin);
      if (!alive) {
        this.contexts.length = i;
        this.view.selection = this.view.selection.filter((id) => this.selectable(id));
        break;
      }
    }
  }

  selectedNode(): Node | null {
    const id = this.view.selection[0];
    return id ? this.store.nodeAt(id) : null;
  }

  /* the selection only where it is an INSTANCE: `store.instance` is the same question
     asked of one id, so the rule lives in exactly one place */
  selectedInstance(): Node | null {
    const id = this.view.selection[0];
    return id ? this.store.instance(id) : null;
  }

  apply(ops: Op[]): void {
    this.conn.apply(ops);
  }

  /* one gesture event out. The sequence is per-session monotonic — the backend drops
     what arrives out of order, which is also what lets its fail-safe synthesize a
     release for a session that vanished mid-press. */
  input(node: number, event: string, value?: Json, element?: string,
        repeat?: RepeatCopy | null): void {
    this.conn.input(node, event, value ?? null, this.inputSeq++, element ?? "",
                    repeat ?? null);
  }

  setPage(id: number): void {
    this.pageId = id;
    /* a page switch is a change of subject: whatever component was entered, the author
       asked for a different page, not that component on it */
    this.contexts = [];
    this.view.selection = [];
    this.view.element = "";
    this.conn.view(id, true);
    this.renderAll();
  }

  /* the backend issues the id, so the switch happens on the echo (onOps) */
  addPage(): void {
    const taken = new Set(this.store.pages().map((p) => p.name));
    let n = this.store.pages().length + 1;
    while (taken.has("Page " + n)) n++;
    this.pendingPage = true;
    this.apply([{ op: "insert", parent: 0, list: "pages", node: { name: "Page " + n } }]);
  }

  /* land on a consumer named elsewhere (the Data workspace's where-used) */
  reveal(instance: number): void {
    const parent = this.store.parentOf(instance);
    if (parent && typeof parent.id === "number" && this.page()?.id !== parent.id)
      this.setPage(parent.id);
    /* the revealed instance lives on the page: whatever was entered steps aside */
    this.contexts = [];
    this.select([instance]);
    this.setWorkspace("content");
  }

  /* The page selection and the component selection are no longer mutually exclusive:
     they belong to different workspaces, so clearing one when the other moves would
     lose your place in Design every time you touched the artboard. */
  select(ids: number[]): void {
    this.view.selection = ids;
    this.view.element = "";
    this.queueSidebars();
  }

  /* WHAT THE POINTER IS ON. Deliberately not queueSidebars: no sidebar's shape mentions
     hover, and rebuilding one per row the pointer crosses would throw away focus, scroll
     and open dropdowns for a highlight. The stage repositions its overlays (an unchanged
     signature rebuilds nothing) and exactly one Layers row changes class. */
  setHover(id: number): void {
    if (this.view.hover === id) return;
    this.view.hover = id;
    renderStage(this.nodes.stage, this);
    this.shellHost.querySelector(".layers .layer-row.hover")?.classList.remove("hover");
    if (!id) return;
    /* ONE row key for one kind of node: the tree stopped needing to know which of two
       shapes a row stood for the day there stopped being two */
    this.shellHost.querySelector('.layers [data-key="n' + id + '"]')?.classList.add("hover");
  }

  /* one preview mechanism for both drags: the tree hands its plan straight through to the
     stage, so a row dragged in the sidebar reflows the page exactly as dragging the node
     itself does. Nothing about it touches the document. */
  previewMove(node: number, plan: DropPlan | null): void {
    previewArrangement(this.nodes.stage, this, node, plan);
  }

  /* element selection: the instance is selected and the focus narrows to one named
     template node; the inspector scopes to it */
  selectElement(id: number, path: string): void {
    this.view.selection = [id];
    this.view.element = path;
    this.queueSidebars();
  }

  /* the Design workspace's selection: a component, or one element node inside it. The two
     component selections ARE exclusive of each other (one inspector, one subject); the
     page selection is untouched, since it belongs to another workspace. */
  selectComponent(component: number, node: number): void {
    this.componentSel = component ? { component, node: node || component } : null;
    this.builtinSel = null;
    this.setWorkspace("design");
    this.queueSidebars();
  }

  /* browse a built-in read-only (reading the shipped definition is
     what precedes overriding it). It is not in the document, so there is nothing to
     select by id — the Design inspector alone changes. */
  selectBuiltin(name: string, path: string): void {
    this.builtinSel = name ? { name, path } : null;
    this.componentSel = null;
    this.setWorkspace("design");
    this.queueSidebars();
  }

  /* fork a built-in: ONE ordinary insert of its served document form (the backend
     issues every id through prepare); the echo resolves the selection by name */
  forkBuiltin(name: string): void {
    const held = this.store.components().find((c) => c.name === name);
    if (held) {
      this.selectComponent(held.id, held.id);
      return;
    }
    const source = this.builtins.find((b) => b?.name === name);
    if (!source) return;
    this.pendingComponent = name;
    this.apply([
      { op: "insert", parent: 0, list: "components", node: JSON.parse(JSON.stringify(source)) },
    ]);
  }

  /* "Duplicate as…": copy a built-in OR a doc component (either is a valid source) under
     a fresh name, ids stripped so the backend issues its own — the source and every
     instance of it are untouched, unlike forkBuiltin which deliberately shadows */
  duplicateComponent(name: string): void {
    const source = this.store.components().find((c) => c.name === name) ??
      this.builtins.find((b) => b?.name === name);
    if (!source) return;
    const taken = new Set<string>(this.store.components().map((c) => c.name));
    for (const b of this.builtins) if (b?.name) taken.add(b.name);
    /* strip a prior "<root> <n>" suffix so duplicating a duplicate counts up from the
       root name instead of growing a "Knob 2 2" tail */
    const root = name.replace(/ \d+$/, "");
    let n = 2;
    while (taken.has(root + " " + n)) n++;
    const fresh = root + " " + n;
    const copy = stripIds(JSON.parse(JSON.stringify(source))) as Json;
    copy.name = fresh;
    this.pendingComponent = fresh;
    this.apply([{ op: "insert", parent: 0, list: "components", node: copy }]);
  }

  /* A minimal fresh component: one text node wired to one starter property, so the new
     type renders (and binds) something the moment it is placed. The component record IS
     the root frame; the label fills it, in fractions of whatever box an instance gives.

     IT IS OPERABLE FROM BIRTH. A component with no gesture and no events is a picture: an
     instance of it offers nothing to trigger a flow on, which reads as the editor refusing
     to let a custom component do anything at all. So it starts with the press gesture on its
     root — which brings the whole press family with it, fixed signatures and all (the
     closed vocabulary in types.ts; nothing is declared). A drag or a pick is one change
     of the root's gesture away; the events section holds only what the component
     INVENTS and raises itself. */
  addComponent(): void {
    const taken = new Set<string>(this.store.components().map((c) => c.name));
    for (const type of this.registry?.components ?? []) taken.add(type.name);
    let name = "Custom1";
    for (let n = 1; taken.has(name); n++) name = "Custom" + n;
    const press = primitiveDef("press");
    this.pendingComponent = name;
    this.apply([
      {
        op: "insert",
        parent: 0,
        list: "components",
        node: {
          name,
          props: [{ name: "text", shape: "text", default: "new", group: "appearance" }],
          /* no declared events: the press gesture on the root brings the whole family
             (tap, press, release, pressrelease, held) — events here are only what the
             component INVENTS and raises itself */
          events: [],
          attrs: {},
          interact: { primitive: "press", params: { ...press?.params } },
          children: [{ kind: "text", name: "label",
                       attrs: { text: "text", align: "'center'" } }],
        },
      },
    ]);
  }

  /* the theme preview mode: the artboard repaints in the other half of
     every token; the editor's own chrome is deliberately untouched */
  setThemeMode(mode: "dark" | "light"): void {
    if (this.view.themeMode === mode) return;
    this.view.themeMode = mode;
    localStorage.setItem("theme-mode", mode);
    this.queueSidebars();
  }

  private queueSidebars(): void {
    this.sidebarsDirty = true;
    this.schedule();
  }

  /* Everything arriving from the wire is coalesced into one frame, so a burst of op echoes
     and 30 Hz live frames costs one pass, not one pass each. The stage renders on every
     pass, including while operating (there are no sidebars there, and the page is the
     whole point of that view); it decides for itself whether anything it draws moved. */
  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.sidebarsDirty) {
        this.sidebarsDirty = false;
        this.renderSidebars();
      }
      renderStage(this.nodes.stage, this);
    });
  }

  refresh(): void {
    this.queueSidebars();
  }

  /* ---- protocol ----
   *
   * A frame's `aggs` entries are DELTAS, so both entry points below fold them into the
   * standing copies (editor.ts holds the fold and its erase-and-rebaseline rule). A
   * SNAPSHOT clears the store first: a recompile can move which cell a key names, and a
   * snapshot's own block carries every aggregate cell whole anyway. */

  private onSnapshot(doc: Doc, registry: Registry, live: Live, diag: Diag[], mesh: Mesh,
                     lang: Lang, attrTable: AttrTable, builtins: BuiltinDef[],
                     nodeAttrs: Record<string, NodeAttrs>): void {
    this.store.load(doc);
    this.registry = registry;
    this.nodeAttrs = nodeAttrs;
    this.live = live;
    this.aggs.clear();
    foldAggs(this.aggs, live?.aggs);
    this.mesh = { entities: mesh?.entities ?? [], types: mesh?.types ?? [] };
    this.lang = lang;
    this.attrTable = attrTable;
    this.builtins = Array.isArray(builtins) ? builtins : [];
    this.onDiag(diag, false);
    const page = this.page();
    this.pageId = page ? page.id : 0;
    this.conn.view(this.pageId, true);
    this.view.selection = this.view.selection.filter((id) => this.selectable(id));
    if (!this.view.selection.length) this.view.element = "";
    this.settleComponentSel();
    this.settleContexts();
    this.renderAll();
  }

  /* A selection survives an echo while the node it names still exists. Frames count:
     one is selected from the Layers tree and edited in the inspector, so dropping it on
     the echo of its own edit would empty the inspector under the author's hands. */
  private selectable(id: number): boolean {
    return Boolean(this.store.instance(id) ?? this.store.nodeAt(id));
  }

  private onOps(version: number, ops: Op[]): void {
    this.store.apply(version, ops);
    this.view.selection = this.view.selection.filter((id) => this.selectable(id));
    if (!this.view.selection.length) this.view.element = "";
    if (!this.page()) this.pageId = this.store.pages()[0]?.id ?? 0;
    /* our "+ New page" echo names the issued id: switch to the fresh page */
    if (this.pendingPage)
      for (const op of ops)
        if (op.op === "insert" && op.list === "pages" &&
            typeof (op.node as Json)?.id === "number") {
          this.pendingPage = false;
          this.setPage((op.node as Json).id);
          break;
        }
    /* our group's echo opens with the insert of the box it made: select it, so the thing
       the author just created is the thing the inspector is showing */
    if (this.pendingGroup)
      for (const op of ops)
        if (op.op === "insert" && op.list === "children" &&
            (op.node as Json)?.kind === "frame" && typeof (op.node as Json)?.id === "number") {
          this.pendingGroup = false;
          this.select([(op.node as Json).id]);
          break;
        }
    this.settleComponentSel();
    this.settleContexts();
    this.renderAll();
  }

  /* a fork or add resolves to its selection here (the echo carries the issued ids);
     a component selection whose nodes an edit removed steps out rather than dangling */
  private settleComponentSel(): void {
    if (this.pendingComponent) {
      const held = this.store.components().find((c) => c.name === this.pendingComponent);
      if (held) {
        this.pendingComponent = null;
        this.componentSel = { component: held.id, node: held.id };
        this.view.selection = [];
        this.view.element = "";
      }
    }
    if (!this.componentSel) return;
    if (!this.store.node(this.componentSel.component)) this.componentSel = null;
    else if (!this.store.node(this.componentSel.node))
      this.componentSel.node = this.componentSel.component;
  }

  /* Diagnostics arrive addressed to a document node, which may be a feed, a step or a
   * variable. The Layers tree can only badge an INSTANCE, so each finding is walked up to the
   * instance that owns it; a global variable's finding belongs to no instance and stays in the
   * list. */
  private onDiag(rows: Diag[], render = true): void {
    this.diagnostics = Array.isArray(rows) ? rows : [];
    this.view.faults = {};
    for (const row of this.diagnostics) {
      const instance = this.store.owningInstance(row.node);
      if (!instance) continue;
      const worst = this.view.faults[instance];
      if (worst === "error" || (worst === "warning" && row.grade === "info")) continue;
      this.view.faults[instance] = row.grade;
    }
    const errors = this.diagnostics.filter((row) => row.grade === "error").length;
    const notes = this.diagnostics.length - errors;
    this.nodes.problems.textContent = errors
      ? errors + (errors === 1 ? " problem" : " problems")
      : notes
        ? notes + (notes === 1 ? " note" : " notes")
        : "";
    this.nodes.problems.className = "problems" + (errors ? " bad" : notes ? " note" : " none");
    if (render) this.renderAll();
  }

  /* the first thing worth looking at: select its instance and say what is wrong */
  private showProblem(): void {
    const row =
      this.diagnostics.find((d) => d.grade === "error") ?? this.diagnostics[0] ?? null;
    if (!row) return;
    const instance = this.store.owningInstance(row.node);
    if (instance) this.select([instance]);
    this.flash(row.message);
  }

  /* every finding about this instance or anything inside it */
  diagFor(instance: number): Diag[] {
    return this.diagnostics.filter((row) => this.store.owningInstance(row.node) === instance);
  }

  diagAt(node: number, where?: string): Diag[] {
    return this.diagnostics.filter(
      (row) => row.node === node && (row.where ?? "") === (where ?? ""),
    );
  }

  diagNode(node: number): Diag[] {
    return this.diagnostics.filter((row) => row.node === node);
  }

  private onStatus(state: Status, detail: string): void {
    this.nodes.pill.className = "pill " + state;
    this.nodes.pill.title = state;
    if (state === "live" && detail.startsWith("edit refused")) this.flash(detail);
    else if (state !== "live") this.flash(detail + " (retrying)");
    else this.flash("");
  }

  private flash(text: string): void {
    this.nodes.banner.textContent = text;
    this.nodes.banner.classList.toggle("on", text.length > 0);
  }

  /* ---- rendering ---- */

  private renderAll(): void {
    this.queueSidebars();
  }


  /* Each sidebar decides for itself. It is handed the shape of the document it draws from,
   * and rebuilds only if that shape moved; otherwise every control it already built
   * re-reads and assigns. So an arriving value does no layout, keeps focus, hover, open
   * dropdowns and scroll untouched, and needs nothing put back afterwards. */
  private renderSidebars(): void {
    if (this.operate) return; /* the deployed view has no sidebars to keep current */
    this.sidebars.left.render(leftShape(this), (host) => renderLeftSidebar(host, this));
    this.sidebars.inspector.render(inspectorShape(this), (host) => renderInspector(host, this));
    /* the topbar page selector and the hidden workspaces reconcile like sidebars:
       kept alive, always current (a mesh frame or page op lands here too) */
    this.pagePanel?.render(pageSelectShape(this), (host) => renderPageSelect(host, this));
    this.stylePanel?.render(styleShape(this), (host) => renderStyleWorkspace(host, this));
    this.dataTreePanel?.render(dataShape(this), (host) => renderDataTree(host, this));
    this.dataDetailPanel?.render(dataShape(this), (host) => renderDataDetail(host, this));
    this.designTreePanel?.render(designShape(this), (host) => renderDesignTree(host, this));
    this.designInspectorPanel?.render(designInspectorShape(this),
                                      (host) => renderDesignInspector(host, this));
  }

  /* ---- shell construction ---- */

  private build(): void {
    clear(this.shellHost);
    const pill = el("span", { class: "pill connecting", title: "connecting" });
    /* clicking a compile finding selects the instance it names */
    const problems = el("button", { class: "problems", onclick: () => this.showProblem() });
    const left = el("aside", { class: "sidebar left" });
    const inspector = el("aside", { class: "sidebar right" });
    /* the middle column: stage.ts renders the current page into it as real DOM, and the
       selection rings sit over that, which is why it is a positioned box */
    const stage = el("section", { class: "stage" });
    const banner = el("div", { class: "banner" });

    this.nodes = { left, inspector, stage, banner, problems, pill };
    this.sidebars = { left: new Panel(left), inspector: new Panel(inspector) };

    /* #app is a ROW since the log landed: the whole shell (topbar, workspaces, banner)
       stands in one column beside the log sidebar, so opening or resizing the log
       narrows the workspace rather than covering it */
    const shellMain = el("div", { class: "shell-main" });

    if (this.operate) {
      /* the deployed view: the page, full window, and nothing else. The banner stays —
         reconnects and refused edits still need a voice. The problems button and pill
         exist unattached, so the status handlers have somewhere to write. */
      shellMain.appendChild(el("main", { class: "workspace" }, [stage]));
      shellMain.appendChild(banner);
    } else {
      const content = el("main", { class: "workspace" }, [
        left,
        this.gutter("left"),
        stage,
        this.gutter("right"),
        inspector,
      ]);
      const style = el("main", { class: "workspace-style", "data-input": "scroll" });
      this.stylePanel = new Panel(style);
      /* the Data workspace: two independently scrolling columns, each its own panel so
         an expansion rebuild in the tree keeps the detail pane's scroll (and vice versa) */
      const dataTree = el("aside", { class: "data-tree", "data-input": "scroll" });
      const dataDetail = el("section", { class: "data-detail", "data-input": "scroll" });
      const data = el("main", { class: "workspace-data" }, [dataTree, dataDetail]);
      this.dataTreePanel = new Panel(dataTree);
      this.dataDetailPanel = new Panel(dataDetail);
      /* Design: the component tree and the component/element inspector, either side of an
         empty middle. The preview that used to stand between them was a second artboard
         with its own camera; it goes with the first one, and comes back as the multi-size
         gallery the rebuild plans. Authoring a component still works — the tree selects,
         the inspector edits — it just cannot be watched while it happens. */
      const designTree = el("aside", { class: "sidebar design-tree", "data-input": "scroll" });
      const designInspector = el("aside", { class: "sidebar design-inspector", "data-input": "scroll" });
      const designStage = el("section", { class: "stage empty" });
      const design =
        el("main", { class: "workspace-design" }, [designTree, designStage, designInspector]);
      this.designTreePanel = new Panel(designTree);
      this.designInspectorPanel = new Panel(designInspector);
      this.workspaces = buildWorkspaces(content, design, data, style);

      const modes = el(
        "div",
        { class: "seg" },
        (["edit", "test"] as Mode[]).map((mode) =>
          el("button", {
            class: mode === this.view.mode ? "on" : "",
            text: mode,
            "data-mode": mode,
            onclick: () => this.setMode(mode),
          }),
        ),
      );
      /* operate is a destination, not a mode chip: play opens the deployed view */
      const play = iconButton("play", "open the operate view in a new tab", () =>
        window.open(window.location.pathname + "?operate", "_blank"), true);
      play.classList.add("play");

      /* the page selector is centred on the bar (out of the flex flow, styles.css) so
         that hiding it over Data or Style leaves the tabs where they were */
      const pageHost = el("div", { class: "page-host" });
      this.pagePanel = new Panel(pageHost);
      this.stageTools = [pageHost, modes, play];

      const tabs = el(
        "nav",
        { class: "tabs" },
        this.workspaces.map((ws) =>
          el("button", {
            class: ws.id === this.workspace ? "on" : "",
            text: ws.label,
            "data-workspace": ws.id,
            onclick: () => this.setWorkspace(ws.id),
          }),
        ),
      );

      shellMain.appendChild(
        el("header", { class: "topbar" }, [
          el("div", { class: "wordmark", text: "DART HMI" }),
          tabs,
          pageHost,
          el("div", { class: "status" }, [modes, play, problems, pill]),
        ]),
      );
      for (const ws of this.workspaces) {
        ws.root.hidden = ws.id !== this.workspace;
        shellMain.appendChild(ws.root);
      }
      shellMain.appendChild(banner);
      this.restoreSidebarWidths();
    }

    this.shellHost.appendChild(shellMain);
    /* the log sidebar, its gutter and the toast host, on #app's row beside the shell */
    this.logView = new LogView(this.shellHost);

    /* the stage's own click (selection) is stage.ts's, next to the DOM it hit-tests; the
       right-click belongs here, where the menu and the insert verbs live */
    stage.addEventListener("contextmenu", (ev) => this.onContextMenu(ev as MouseEvent));
    window.addEventListener("keydown", (ev) => this.onKey(ev));
  }

  private gutter(side: "left" | "right"): HTMLElement {
    const node = el("div", { class: "gutter", "data-side": side });
    node.addEventListener("pointerdown", (ev) => {
      const start = (ev as PointerEvent).clientX;
      const sidebar = side === "left" ? this.nodes.left : this.nodes.inspector;
      const from = sidebar.getBoundingClientRect().width;
      const move = (m: PointerEvent) => {
        const delta = side === "left" ? m.clientX - start : start - m.clientX;
        const width = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, from + delta));
        document.documentElement.style.setProperty("--sidebar-" + side, width + "px");
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        localStorage.setItem(
          "sidebar-" + side,
          document.documentElement.style.getPropertyValue("--sidebar-" + side),
        );
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      ev.preventDefault();
    });
    return node;
  }

  private restoreSidebarWidths(): void {
    for (const side of ["left", "right"]) {
      const saved = localStorage.getItem("sidebar-" + side);
      if (saved) document.documentElement.style.setProperty("--sidebar-" + side, saved);
    }
  }

  /* pure view routing: the hidden workspaces stay alive (their reconciled sidebars keep
     rendering), and the connection and document never notice a switch */
  private setWorkspace(id: WorkspaceId): void {
    this.workspace = id;
    for (const ws of this.workspaces) ws.root.hidden = ws.id !== id;
    for (const tab of Array.from(this.shellHost.querySelectorAll("button[data-workspace]")))
      tab.classList.toggle("on", (tab as HTMLElement).dataset.workspace === id);
    /* the mode switch and play act on the artboard: they mean nothing over Data or Style */
    for (const tool of this.stageTools) tool.hidden = id !== "content";
  }

  private setMode(mode: Mode): void {
    this.view.mode = mode;
    /* direct manipulation is edit mode's alone, and so is the highlight that leads it */
    this.setHover(0);
    this.shellHost.setAttribute("data-mode", mode);
    for (const button of Array.from(this.shellHost.querySelectorAll("button[data-mode]")))
      button.classList.toggle("on", (button as HTMLElement).dataset.mode === mode);
    this.renderAll();
  }

  /* The four interaction primitives live in gestures.ts now, on ordinary DOM events:
     the stage arms the node the served interact rides, the browser hit-tests, and this
     shell's only job is `input()` above — a gesture is a report, never a decision. */

  private onKey(ev: KeyboardEvent): void {
    const typing = (ev.target as HTMLElement)?.matches?.("input, select, textarea");
    if (typing) return;
    /* the log toggles from anywhere typing does not own the key — every workspace,
       every mode, the operate view included */
    if ((ev.key === "l" || ev.key === "L") && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      this.logView.toggle();
      ev.preventDefault();
      return;
    }
    if (ev.key === "Escape") {
      closeMenu();
      /* Escape steps out one level WITHIN the active workspace: in Design, element ->
         component -> none; in Content, an instance's element -> the instance ->
         selection -> the entered component's own context, one crumb at a time -> none. */
      if (this.workspace !== "design") {
        if (this.view.element && this.view.selection.length)
          this.selectElement(this.view.selection[0], "");
        else if (this.view.selection.length) this.select([]);
        else if (this.contexts.length) this.exitTo(this.contexts.length - 1);
        return;
      }
      if (this.componentSel) {
        if (this.componentSel.node !== this.componentSel.component)
          this.selectComponent(this.componentSel.component, this.componentSel.component);
        else this.selectComponent(0, 0);
      } else if (this.builtinSel) {
        /* the browsed built-in steps out one path segment at a time, then off */
        const at = this.builtinSel.path.lastIndexOf(".");
        if (this.builtinSel.path)
          this.selectBuiltin(this.builtinSel.name,
                             at < 0 ? "" : this.builtinSel.path.slice(0, at));
        else this.selectBuiltin("", "");
      }
    }
    /* edit shortcuts only over the artboard: a Delete in another workspace must not
       silently remove the selection it cannot show */
    if (this.view.mode !== "edit" || this.workspace !== "content") return;
    if (ev.key === "Delete") {
      this.removeSelection();
      ev.preventDefault();
    }
    if (ev.key === "d" && (ev.ctrlKey || ev.metaKey)) {
      this.duplicate();
      ev.preventDefault();
    }
  }

  /* ---- context menu (right-click) ---- */

  /* The stage is real DOM again, so the pointer names a node: the browser's own hit test
     hands the event to the leaf or frame div it landed on. What it never names is a
     POSITION — insertion is by tree position only, appending into whichever frame was
     clicked (the page itself when the click missed every frame). */
  private onContextMenu(ev: MouseEvent): void {
    if (this.view.mode !== "edit") return;
    ev.preventDefault();
    const hit = (ev.target as HTMLElement | null)?.closest?.("[data-id]") as HTMLElement | null;
    this.openContextAt(ev.clientX, ev.clientY, hit ? Number(hit.getAttribute("data-id")) : 0);
  }

  /* The verbs of one node, wherever the right-click came from: the stage hands us what the
     browser's hit test named, the Layers tree what the row stands for. Same node, same
     menu — a frame answers from its row or from its own pixels on the stage alike. */
  openNodeMenu(clientX: number, clientY: number, node: number): void {
    this.openContextAt(clientX, clientY, node);
  }

  private openContextAt(clientX: number, clientY: number, at: number): void {
    /* the editing root: the page, or the entered component. Null means an unforked
       built-in is on the artboard — read-only, so no verbs at all. */
    const page = this.root();
    if (!page || this.view.mode !== "edit") return;

    /* on an instance: its own verbs, acting on it — a right-click selects what it acts on */
    const instance = at ? this.store.instance(at) : null;
    if (instance) {
      this.select([instance.id]);
      openMenu(clientX, clientY, instance.type ?? "", [
        { label: "Group", icon: "frame", run: () => this.group([instance.id]) },
        { separator: true },
        { label: "Duplicate", icon: "copy", run: () => this.duplicate() },
        { label: "Delete", icon: "trash", danger: true, run: () => this.removeSelection() },
      ]);
      return;
    }

    /* WHAT CAN BE ADDED INTO IT, and what can be done TO it. The node under the pointer
       receives the insert only if it can hold a child — an instance cannot, since what is
       inside it belongs to its component, so an insert aimed at one goes to the frame that
       holds IT, which is what the author was pointing at anyway. The page background keeps
       the Add group alone: there is no node there to act on. */
    const node = at ? this.store.nodeAt(at) : null;
    const parent = holds(node) ? at
                 : node ? (this.store.parentOf(at)?.id ?? page.id)
                 : page.id;
    if (node) this.select([node.id]);
    const types = this.registry?.components ?? [];
    openMenu(clientX, clientY, node?.name || node?.type || page.name, [
      {
        label: "Add component ▸",
        icon: "layers",
        /* the type list is the same menu re-opened where it stands: a real flyout is a
           menu.ts feature and this milestone does not need one. The dismiss overlay is
           about to see this very click, so it is told to let one through. */
        run: () => {
          armSwallow();
          openMenu(clientX, clientY, "Add component", types.map((type) => ({
            label: type.name,
            icon: type.name,
            run: () => this.addInstance(type.name, parent),
          })));
        },
      },
      { separator: true },
      /* ONE box: a frame is a box and a box is all a frame is */
      { label: "Add box", icon: "frame", run: () => this.addBox(parent) },
      { separator: true },
      /* THE INK: text, a glyph and an outline are ordinary nodes, so a page can hold a
         caption or a mimic line without a component around it */
      { label: "Add text", icon: "node-text", run: () => this.addLeaf("text", parent) },
      { label: "Add icon", icon: "node-icon", run: () => this.addLeaf("icon", parent) },
      { label: "Add path", icon: "node-path", run: () => this.addLeaf("path", parent) },
      ...(node
        ? [
            { separator: true } as const,
            { label: "Group", icon: "frame", run: () => this.group([node.id]) } as const,
            ...(holds(node)
              ? [{ label: "Ungroup", icon: "unlink",
                   run: () => this.ungroup(node.id) } as const]
              : []),
            {
              label: "Delete",
              icon: "trash",
              danger: true,
              run: () => this.apply([{ op: "remove", node: node.id }]),
            },
          ]
        : []),
    ]);
  }

  /* a node's box in ARTBOARD px relative to its parent's origin, read off the rendered
     page — the one place the truth of a stretch or an expression-driven position lives */
  private canvasBox(id: number): { x: number; y: number; w: number; h: number } | null {
    const host = this.nodes.stage;
    const pageEl = host?.querySelector(".page") as HTMLElement | null;
    const el = host?.querySelector('.page [data-id="' + id + '"]') as HTMLElement | null;
    if (!pageEl || !el) return null;
    const k = stageScale(host);
    if (!(k > 0)) return null;
    const parent = this.store.parentOf(id);
    const pel = (typeof parent?.id === "number"
      ? host!.querySelector('.page [data-id="' + parent.id + '"]') as HTMLElement | null
      : null) ?? pageEl;
    const pat = pel.getBoundingClientRect();
    const at = el.getBoundingClientRect();
    return {
      x: (at.left - pat.left) / k - pel.clientLeft,
      y: (at.top - pat.top) / k - pel.clientTop,
      w: at.width / k,
      h: at.height / k,
    };
  }

  /* which unit system writes under `parent` take: canvas px on a page, fractions of the
     parent's own rendered box inside a component. `pw`/`ph` are that box's size in
     artboard px — the artboard itself when the parent IS the component root. */
  private writeSpace(parent: number): { frac: boolean; pw: number; ph: number } {
    const ctx = this.contexts[this.contexts.length - 1];
    if (!ctx || !ctx.component) return { frac: false, pw: 1, ph: 1 };
    if (parent === ctx.component) return { frac: true, pw: ctx.w, ph: ctx.h };
    const box = this.canvasBox(parent);
    return { frac: true, pw: box?.w || ctx.w, ph: box?.h || ctx.h };
  }

  private fmtCoord(space: { frac: boolean; pw: number; ph: number }, value: number,
                   axis: "x" | "y"): string {
    return space.frac ? fmtFraction(value / (axis === "x" ? space.pw : space.ph))
                      : fmtPx(value);
  }

  /* GROUPING is one op because the box it makes has an id only the backend can issue
     (ops.cpp); the echo comes back as that insert plus a move per node, and the selection
     follows the box the same way a new page's does. The box's geometry is ours to
     compute — the bbox of the children as rendered — and the children's own literal x/y
     re-base under the new origin in the same batch, so nothing on screen moves. A child
     whose position is authored logic keeps its expression untouched.
     Inside a component the same rules hold in FRACTIONS: the box's attrs are fractions
     of the parent, and a child's literals re-scale from the parent's box to the group's
     — x/y re-base AND re-scale, w/h re-scale, all through the rendered px both boxes
     share. */
  private group(ids: number[]): void {
    if (!ids.length) return;
    const root = this.root();
    if (!root) return;
    const boxes = ids.map((id) => this.canvasBox(id));
    if (boxes.some((b) => b === null)) return;
    const x0 = Math.min(...boxes.map((b) => b!.x));
    const y0 = Math.min(...boxes.map((b) => b!.y));
    const x1 = Math.max(...boxes.map((b) => b!.x + b!.w));
    const y1 = Math.max(...boxes.map((b) => b!.y + b!.h));
    const bw = x1 - x0;
    const bh = y1 - y0;
    if (!(bw > 0) || !(bh > 0)) return;
    const parent = this.store.parentOf(ids[0]);
    const pid = typeof parent?.id === "number" ? parent.id : root.id;
    const space = this.writeSpace(pid);
    /* the parent's own px box: what a child's `right`/`bottom` inset measures from, so a
       far edge can re-base under the group's the same way a near one does under x0/y0.
       Unmeasurable (no rendered box) skips those fields, exactly as authored logic does. */
    const span = space.frac ? { w: space.pw, h: space.ph }
      : pid === root.id ? { w: this.artboard().w, h: this.artboard().h }
      : (() => { const b = this.canvasBox(pid); return { w: b?.w ?? NaN, h: b?.h ?? NaN }; })();
    const ops: Op[] = [{
      op: "group", nodes: ids,
      attrs: { left: this.fmtCoord(space, x0, "x"), top: this.fmtCoord(space, y0, "y"),
               w: this.fmtCoord(space, bw, "x"), h: this.fmtCoord(space, bh, "y") },
    }];
    for (const id of ids) {
      const node = this.store.nodeAt(id);
      if (!node) continue;
      const attrs: Record<string, string> = { ...(node.attrs ?? {}) };
      let moved = false;
      const rebase = (key: string, axis: "x" | "y", delta: number): void => {
        if (!Number.isFinite(delta)) return;
        const text = attrs[key];
        if (text === undefined || String(text).trim() === "") return;
        const lit = literalNumber(text, 0);
        if (lit === null) return;
        if (space.frac) {
          const px = lit * (axis === "x" ? space.pw : space.ph);
          attrs[key] = fmtFraction((px - delta) / (axis === "x" ? bw : bh));
        } else {
          attrs[key] = fmtPx(lit - delta);
        }
        moved = true;
      };
      rebase("left", "x", x0);
      rebase("top", "y", y0);
      /* a far edge's inset shrinks by the GROUP's own inset from the parent's far edge:
         the same picture, measured from the new box's edge instead */
      rebase("right", "x", Number.isFinite(span.w) ? span.w - x1 : NaN);
      rebase("bottom", "y", Number.isFinite(span.h) ? span.h - y1 : NaN);
      /* a px size means the same inside the box; a fraction was of the PARENT and must
         become one of the group */
      if (space.frac) {
        rebase("w", "x", 0);
        rebase("h", "y", 0);
      }
      if (moved) ops.push({ op: "set_prop", node: id, key: "attrs", value: attrs });
    }
    this.pendingGroup = true;
    this.apply(ops);
  }

  /* Ungrouping needs no op of its own: every id is already known, so it is a batch. Each
     child lands at base + k in the group's own parent with its literal x/y carried back
     out through the group's origin, then the empty box goes.
     In FRACTIONS the carry-out is closed-form over the literals alone: the group sits at
     gx with size gw (fractions of ITS parent), so a child's x becomes gx + x*gw and its
     w becomes w*gw — no rendering consulted. An axis whose group size is authored logic
     is skipped: there is no constant to carry the child out through. */
  private ungroup(frameId: number): void {
    const frame = this.store.nodeAt(frameId);
    const parent = this.store.parentOf(frameId);
    if (!frame || !parent || typeof parent.id !== "number") return;
    const base = (parent.children as Node[]).findIndex((n) => n.id === frameId);
    if (base < 0) return;
    const ctx = this.contexts[this.contexts.length - 1];
    const frac = !!ctx && !!ctx.component;
    const gx = literalNumber(frame.attrs?.left, 0) ?? 0;
    const gy = literalNumber(frame.attrs?.top, 0) ?? 0;
    const gw = literalNumber(frame.attrs?.w, NaN);
    const gh = literalNumber(frame.attrs?.h, NaN);
    /* what a child's far-edge inset carries out through: the group's own inset from the
       PARENT's far edge — 1 - gx - gw in fractions, span - gx - gw in px, the span read
       off the rendered page (the artboard itself at the root). Where the group's box or
       the span is not a constant there is nothing to carry through, and the field keeps
       its number exactly as an authored-logic position keeps its expression. */
    const span = frac ? { w: 1, h: 1 }
      : parent.id === this.root()?.id
        ? { w: this.artboard().w, h: this.artboard().h }
        : (() => { const b = this.canvasBox(parent.id as number);
                   return { w: b?.w ?? NaN, h: b?.h ?? NaN }; })();
    const ops: Op[] = (frame.children ?? []).map((child, k) => ({
      op: "move",
      node: child.id,
      parent: parent.id as number,
      list: "children",
      index: base + k,
    }));
    for (const child of frame.children ?? []) {
      const attrs: Record<string, string> = { ...(child.attrs ?? {}) };
      let moved = false;
      const carry = (key: string, shift: number, scale: number | null): void => {
        if (scale === null || !Number.isFinite(scale) || !Number.isFinite(shift)) return;
        const text = attrs[key];
        if (text === undefined || String(text).trim() === "") return;
        const lit = literalNumber(text, 0);
        if (lit === null) return;
        const next = shift + lit * scale;
        if (next === lit) return;
        attrs[key] = frac ? fmtFraction(next) : fmtPx(next);
        moved = true;
      };
      if (frac) {
        carry("left", gx, gw);
        carry("top", gy, gh);
        carry("right", gw === null ? NaN : 1 - gx - gw, gw);
        carry("bottom", gh === null ? NaN : 1 - gy - gh, gh);
        carry("w", 0, gw);
        carry("h", 0, gh);
      } else {
        carry("left", gx, 1);
        carry("top", gy, 1);
        carry("right", span.w - gx - (gw === null ? NaN : gw), 1);
        carry("bottom", span.h - gy - (gh === null ? NaN : gh), 1);
      }
      if (moved) ops.push({ op: "set_prop", node: child.id, key: "attrs", value: attrs });
    }
    ops.push({ op: "remove", node: frameId });
    this.apply(ops);
    this.view.selection = [];
  }

  /* where a fresh node lands: centred on the artboard when it joins the root, a couple of
     cells in when it joins a box — deterministic, on the grid, and always in view */
  private freshSpot(parent: number, w: number, h: number): { x: number; y: number } {
    const root = this.root();
    const art = this.artboard();
    return parent === root?.id
      ? { x: snapPx((art.w - w) / 2), y: snapPx((art.h - h) / 2) }
      : { x: 44, y: 44 };
  }

  /* one insert of one node with a starter box, wherever it goes: the spot and size are
     figured in artboard px and written in the space the parent reads — px on a page,
     fractions of the parent inside a component */
  private insertNode(parent: number, node: Json, w: number, h: number): void {
    const at = this.freshSpot(parent, w, h);
    const space = this.writeSpace(parent);
    node.attrs = {
      ...(node.attrs ?? {}),
      left: this.fmtCoord(space, at.x, "x"), top: this.fmtCoord(space, at.y, "y"),
      w: this.fmtCoord(space, w, "x"), h: this.fmtCoord(space, h, "y"),
    };
    this.apply([{ op: "insert", parent, list: "children", node }]);
  }

  /* AN INSTANCE IS A FRAME THAT NAMES A COMPONENT — there is no instance kind to ask for — so
     this inserts the same node `addBox` does, carrying a `type`, at the component's own
     NATURAL SIZE: the design frame it was authored against. */
  private addInstance(type: string, parent: number): void {
    const spec = (this.registry?.components ?? []).find((t) => t.name === type);
    const w = Math.max(22, snapPx(spec?.design_w ?? 240));
    const h = Math.max(22, snapPx(spec?.design_h ?? 120));
    this.insertNode(parent, { kind: "frame", type, name: type }, w, h);
  }

  private addBox(parent: number): void {
    this.insertNode(parent, { kind: "frame", name: "Box" }, 352, 264);
  }

  /* the ink kinds, added the same way: one node, one insert, each with a starter box so
     it lands graspable rather than stretched over its whole parent */
  private addLeaf(kind: NodeKind, parent: number): void {
    const size = kind === "text" ? { w: 264, h: 44 }
               : kind === "icon" ? { w: 66, h: 66 }
               : { w: 264, h: 264 };
    this.insertNode(parent, { kind, name: kind }, size.w, size.h);
  }

  /* duplicate every selected instance OR frame into its OWN parent, directly after it: a
     frame's child duplicates back into that frame, a page-level node back onto the page.
     The copy used to be nudged one cell down and right so it did not hide under its
     original; a list has no "under", so it simply follows. */
  private duplicate(): void {
    const ops: Op[] = [];
    for (const id of this.view.selection) {
      const node = this.store.instance(id) ?? this.store.nodeAt(id);
      if (!node) continue;
      const parent = this.store.parentOf(id);
      if (!parent || typeof parent.id !== "number") continue;
      ops.push({
        op: "insert",
        parent: parent.id,
        list: "children",
        node: stripIds(JSON.parse(JSON.stringify(node))),
      });
    }
    if (ops.length) this.apply(ops);
  }

  private removeSelection(): void {
    const ops: Op[] = this.view.selection.map((id) => ({ op: "remove", node: id }));
    if (ops.length) this.apply(ops);
    this.view.selection = [];
  }
}

/* ids are the backend's to issue: a copy asks for new ones by carrying none */
function stripIds(node: Json): Json {
  if (Array.isArray(node)) return node.map(stripIds);
  if (node && typeof node === "object") {
    const out: Json = {};
    for (const [key, value] of Object.entries(node)) if (key !== "id") out[key] = stripIds(value);
    return out;
  }
  return node;
}
