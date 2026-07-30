/* The application shell: the frame (topbar, workspace tabs, mode switch) around the
 * workspaces, and the wiring between the connection, the document mirror and the
 * sidebars. The content workspace is the three-column editor; the shell holds only view
 * state (selection, hover, mode, active workspace, sidebar widths); every edit leaves as
 * an op and comes back as a broadcast, so two windows are always looking at the same
 * document. An `?operate` URL is the deployed view: the same app with a minimal frame,
 * just the artboard, started straight in operate mode.
 *
 * Direct manipulation follows the old designer: click selects, shift-click extends, drag
 * moves the whole selection, the grips resize its bbox, and a dashed ghost shows where it
 * will land. The document is only touched on release, by one op. */

import { bboxOf, cellSize, hitTest, renderContent, renderOverlay, ViewState } from "./canvas.js";
import { DocStore } from "./doc.js";
import { clear, el, iconButton, svg } from "./dom.js";
import { Editor } from "./editor.js";
import { iconMarkup } from "./icons.js";
import { closeMenu, openMenu } from "./menu.js";
import { inspectorShape, leftShape, renderInspector, renderLeftSidebar } from "./inspector/panel.js";
import { refreshSourceTree } from "./inspector/sourcetree.js";
import { pageSelectShape, renderPageSelect } from "./pageselect.js";
import { Connection, Status } from "./protocol.js";
import { Panel } from "./reconcile.js";
import { run } from "./program.js";
import { cellsFor, fedSlots, resolveSlot, runtimeSlots, themedSlot, typeOf, widgetOptions } from "./slots.js";
import { PartRect, Rect } from "./template.js";
import { BuiltinDef, Diag, Doc, HistView, Interact, Json, Lang, Live, Mesh, Op, Page, Registry, Token, Widget, WidgetType } from "./types.js";
import { Viewport } from "./viewport.js";
import { buildWorkspaces, Workspace, WorkspaceId } from "./workspaces.js";
import { dataShape, renderDataDetail, renderDataTree } from "./workspaces/data.js";
import { renderStyleWorkspace, styleShape } from "./workspaces/style.js";

type Mode = "edit" | "test" | "operate";

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 640;
const MIN_SIZE = 20;

export class App implements Editor {
  store = new DocStore();
  registry: Registry | null = null;
  /* the reflected entity tree, served by the backend: the "dart" root of the coming
     source picker (stage 6); the "hmi" root is the document's own variables */
  mesh: Mesh = { entities: [], types: [] };
  /* the served expression vocabulary: autocomplete reads exactly what compiles */
  lang: Lang | null = null;
  /* the built-ins' editable document form, snapshot-only (it never changes at runtime):
     the Components tree browses it and a fork copies one entry into doc.components */
  builtins: BuiltinDef[] = [];
  /* the component-edit selection; mutually exclusive with the widget selection */
  componentSel: { component: number; node: number } | null = null;
  /* the built-in being browsed read-only: its name plus a child-index path into its
     parts ("" = the component itself). Mutually exclusive with the other two. */
  builtinSel: { name: string; path: string } | null = null;
  live: Live | null = null;
  hists: Record<string, HistView> = {};
  diagnostics: Diag[] = [];
  /* where every named template node landed on the last content render: widget id ->
     part path -> rect in artboard units (the overlay's part ring reads this) */
  partRects: Map<number, Map<string, PartRect>> = new Map();
  /* a `code` part's error from the last content render, per widget (spec 2.3): rebuilt
     fresh every render, so a fixed body drops out of it exactly as a cleared compile
     finding drops out of `view.faults` */
  codeFaults: Map<number, string> = new Map();
  view: ViewState = {
    mode: "edit", selection: [], part: "", hover: 0, scale: 1, ghost: null, state: {}, faults: {},
    /* the theme preview mode is a local preference, like the sidebar widths */
    themeMode: localStorage.getItem("theme-mode") === "light" ? "light" : "dark",
  };

  private conn: Connection;
  private viewport: Viewport | null = null;
  private pageId = 0;
  private workspaces: Workspace[] = [];
  private workspace: WorkspaceId = "content";
  /* the topbar controls that act on the artboard: hidden over Data and Style */
  private stageTools: HTMLElement[] = [];
  private nodes!: {
    left: HTMLElement;
    inspector: HTMLElement;
    stage: HTMLElement;
    layer: HTMLElement;
    art: SVGSVGElement;
    overlay: SVGSVGElement;
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
  private pagePanel: Panel | null = null;
  /* our "+ New page" is in flight: the echo carries the issued id, switch to it there */
  private pendingPage = false;
  private drag: Json = null;
  private control: Json = null;
  /* a just-forked or just-added component's name: its insert is in flight, and the ids
     the backend issues arrive with the echo, so selection resolves there by name */
  private pendingComponent: string | null = null;
  private inputSequence = 0;
  private frame = 0;
  private contentDirty = true;
  private sidebarsDirty = true;
  private lastContent = "";
  private lastOverlay = "";

  /* `operate` is the deployed view: no topbar, no sidebars, the artboard alone */
  constructor(private root: HTMLElement, url: string, private operate = false) {
    this.build();
    if (this.operate) this.setMode("operate");
    this.conn = new Connection(url, {
      snapshot: (doc, registry, live, diag, mesh, lang, builtins) =>
        this.onSnapshot(doc, registry, live, diag, mesh, lang, builtins),
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
        this.absorbHist(live.hist);
        this.queueCanvas(true);
        this.queueSidebars();
      },
      diag: (rows) => this.onDiag(rows),
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

  selectedWidget(): Widget | null {
    const id = this.view.selection[0];
    return id ? this.store.widget(id) : null;
  }

  apply(ops: Op[]): void {
    this.conn.apply(ops);
  }

  setPage(id: number): void {
    this.pageId = id;
    this.view.selection = [];
    this.view.part = "";
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
  reveal(widget: number): void {
    const parent = this.store.parentOf(widget);
    if (parent && typeof parent.id === "number" && this.page()?.id !== parent.id)
      this.setPage(parent.id);
    this.select([widget]);
    this.setWorkspace("content");
  }

  select(ids: number[]): void {
    this.view.selection = ids;
    this.view.part = "";
    this.componentSel = null;
    this.builtinSel = null;
    this.queueCanvas();
    this.queueSidebars();
  }

  /* part selection: the widget is selected and the focus narrows to one named template
     node; the inspector scopes to it and the overlay rings where it landed */
  selectPart(id: number, path: string): void {
    this.view.selection = [id];
    this.view.part = path;
    this.componentSel = null;
    this.builtinSel = null;
    this.queueCanvas();
    this.queueSidebars();
  }

  /* component selection: the inspector scopes to the component (or one part node in
     it) and the widget selection clears — the overlay owns instance space only, so no
     part ring is drawn for a component part (partRects are per instance) */
  selectComponent(component: number, node: number): void {
    this.componentSel = component ? { component, node: node || component } : null;
    this.builtinSel = null;
    this.view.selection = [];
    this.view.part = "";
    this.queueCanvas();
    this.queueSidebars();
  }

  /* browse a built-in read-only (spec 2.3 Forking: reading the shipped definition is
     what precedes overriding it). It is not in the document, so there is nothing to
     select by id and nothing to ring on the artboard — the inspector alone changes. */
  selectBuiltin(name: string, path: string): void {
    this.builtinSel = name ? { name, path } : null;
    this.componentSel = null;
    this.view.selection = [];
    this.view.part = "";
    this.queueCanvas();
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

  /* a minimal fresh component: a body box holding one text part wired to one starter
     property, so the new type renders (and binds) something the moment it is placed */
  addComponent(): void {
    const taken = new Set<string>(this.store.components().map((c) => c.name));
    for (const type of this.registry?.types ?? []) taken.add(type.name);
    let name = "Custom1";
    for (let n = 1; taken.has(name); n++) name = "Custom" + n;
    this.pendingComponent = name;
    this.apply([
      {
        op: "insert",
        parent: 0,
        list: "components",
        node: {
          name,
          props: [{ name: "text", shape: "text", default: "new", group: "appearance" }],
          parts: [
            {
              kind: "box",
              name: "body",
              dir: "stack",
              attrs: {},
              children: [{ kind: "text", name: "label", attrs: { text: "text" } }],
            },
          ],
        },
      },
    ]);
  }

  /* the theme preview mode (spec 2.10): the artboard repaints in the other half of
     every token; the editor's own chrome is deliberately untouched */
  setThemeMode(mode: "dark" | "light"): void {
    if (this.view.themeMode === mode) return;
    this.view.themeMode = mode;
    localStorage.setItem("theme-mode", mode);
    this.queueCanvas(true);
    this.queueSidebars();
  }

  /* the theme every paint site resolves colors through: this view's mode over the
     document's tokens */
  private theme(): { tokens: Token[]; mode: "dark" | "light" } {
    return { tokens: this.store.tokens(), mode: this.view.themeMode ?? "dark" };
  }

  /* the artboard and its editing overlay are separate layers: only the overlay depends on
     the view transform, so panning and zooming redraw a handful of shapes */
  private queueCanvas(content = false): void {
    this.contentDirty = this.contentDirty || content;
    this.schedule();
  }

  private queueSidebars(): void {
    this.sidebarsDirty = true;
    this.schedule();
  }

  /* One frame for both. Everything arriving from the wire is coalesced here, so a burst of
     op echoes and 30 Hz live frames costs one pass, not one pass each. */
  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.sidebarsDirty) {
        this.sidebarsDirty = false;
        this.renderSidebars();
      }
      this.renderCanvas();
    });
  }

  refresh(): void {
    this.queueSidebars();
  }

  /* ---- protocol ---- */

  /* Fold a frame's history deltas into the standing views. `from` is the absolute index
   * of the first delivered sample: contiguous appends extend, a jump forward pads the
   * gap with unknowns, and anything else (a snapshot, a recompile's full resend, a
   * series-width change) replaces the view outright. */
  private absorbHist(hist: Record<string, Json> | undefined): void {
    if (!hist) return;
    for (const key of Object.keys(hist)) {
      const entry = hist[key] as Json;
      if (!entry || typeof entry !== "object") continue;
      const series = Math.max(1, Number(entry.series ?? 1));
      const flat = Array.isArray(entry.values) ? (entry.values as (number | null)[]) : [];
      const samples: (number | null)[][] = [];
      for (let at = 0; at + series <= flat.length; at += series)
        samples.push(flat.slice(at, at + series));
      const from = Number(entry.from ?? 0);
      const cap = Math.max(2, Number(entry.cap ?? 600));
      const view = this.hists[key];
      if (view && view.series === series && from >= view.total) {
        for (let pad = view.total; pad < from; ++pad)
          view.samples.push(new Array(series).fill(null));
        view.samples.push(...samples);
        view.total = from + samples.length;
        view.cap = cap;
        view.rate = Number(entry.rate ?? view.rate);
        if (view.samples.length > cap) view.samples.splice(0, view.samples.length - cap);
      } else {
        this.hists[key] = {
          rate: Number(entry.rate ?? 10),
          series,
          cap,
          total: from + samples.length,
          samples,
        };
      }
    }
  }

  private onSnapshot(doc: Doc, registry: Registry, live: Live, diag: Diag[], mesh: Mesh,
                     lang: Lang, builtins: BuiltinDef[]): void {
    this.store.load(doc);
    this.registry = registry;
    this.live = live;
    this.hists = {};
    this.absorbHist(live.hist);
    this.mesh = { entities: mesh?.entities ?? [], types: mesh?.types ?? [] };
    this.lang = lang;
    this.builtins = Array.isArray(builtins) ? builtins : [];
    this.onDiag(diag, false);
    const page = this.page();
    this.pageId = page ? page.id : 0;
    this.viewport?.setArtboard(doc.canvas.unit_w, doc.canvas.unit_h);
    this.conn.view(this.pageId, true);
    this.view.selection = this.view.selection.filter((id) => this.store.widget(id));
    if (!this.view.selection.length) this.view.part = "";
    this.settleComponentSel();
    this.renderAll();
  }

  private onOps(version: number, ops: Op[]): void {
    this.store.apply(version, ops);
    this.view.selection = this.view.selection.filter((id) => this.store.widget(id));
    if (!this.view.selection.length) this.view.part = "";
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
    this.settleComponentSel();
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
        this.view.part = "";
      }
    }
    if (!this.componentSel) return;
    if (!this.store.node(this.componentSel.component)) this.componentSel = null;
    else if (!this.store.node(this.componentSel.node))
      this.componentSel.node = this.componentSel.component;
  }

  /* Diagnostics arrive addressed to a document node, which may be a feed, a step or a
   * variable. The canvas can only mark a WIDGET, so each finding is walked up to the widget
   * that owns it; a global variable's finding belongs to no widget and stays in the list. */
  private onDiag(rows: Diag[], render = true): void {
    this.diagnostics = Array.isArray(rows) ? rows : [];
    this.view.faults = {};
    for (const row of this.diagnostics) {
      const widget = this.owningWidget(row.node);
      if (!widget) continue;
      const worst = this.view.faults[widget];
      if (worst === "error" || (worst === "warning" && row.grade === "info")) continue;
      this.view.faults[widget] = row.grade;
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

  /* the first thing worth looking at: select its widget and say what is wrong */
  private showProblem(): void {
    const row =
      this.diagnostics.find((d) => d.grade === "error") ?? this.diagnostics[0] ?? null;
    if (!row) return;
    const widget = this.owningWidget(row.node);
    if (widget) this.select([widget]);
    this.flash(row.message);
  }

  private owningWidget(node: number): number {
    let at: Json = this.store.node(node);
    let id = node;
    while (at) {
      if (at.type !== undefined && at.geom !== undefined) return id;
      const parent = this.store.parentOf(id);
      if (!parent || typeof parent.id !== "number") return 0;
      id = parent.id;
      at = parent;
    }
    return 0;
  }

  /* every finding about this widget or anything inside it */
  diagFor(widget: number): Diag[] {
    return this.diagnostics.filter((row) => this.owningWidget(row.node) === widget);
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
    this.queueCanvas(true);
    this.queueSidebars();
  }

  private renderCanvas(): void {
    const doc = this.store.doc;
    const page = this.page();
    if (!doc || !page) {
      this.nodes.art.innerHTML = "";
      this.nodes.overlay.innerHTML = "";
      this.lastContent = this.lastOverlay = "";
      return;
    }
    this.view.scale = this.viewport?.scale() ?? 1;
    const viewBox = `0 0 ${doc.canvas.unit_w} ${doc.canvas.unit_h}`;
    if (this.contentDirty) {
      this.contentDirty = false;
      this.partRects = new Map();
      this.codeFaults = new Map();
      const content = renderContent(doc, page, this.registry, this.live, this.view, this.mesh,
                                    this.hists, this.partRects, this.codeFaults);
      if (content !== this.lastContent) {
        this.lastContent = content;
        this.nodes.art.setAttribute("viewBox", viewBox);
        this.nodes.art.innerHTML = content;
      }
    }
    const overlay = renderOverlay(page, this.view, this.partRects);
    if (overlay === this.lastOverlay) return;
    this.lastOverlay = overlay;
    this.nodes.overlay.setAttribute("viewBox", viewBox);
    this.nodes.overlay.innerHTML = overlay;
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
  }

  /* ---- shell construction ---- */

  private build(): void {
    clear(this.root);
    const pill = el("span", { class: "pill connecting", title: "connecting" });
    /* clicking a compile finding selects the widget it names */
    const problems = el("button", { class: "problems", onclick: () => this.showProblem() });
    const left = el("aside", { class: "sidebar left" });
    const inspector = el("aside", { class: "sidebar right" });
    const art = svg("svg", { class: "artboard", width: "100%", height: "100%" }) as SVGSVGElement;
    const overlay = svg("svg", { class: "artboard overlay", width: "100%", height: "100%" }) as SVGSVGElement;
    const layer = el("div", { class: "layer" }, [art as unknown as Node, overlay as unknown as Node]);
    const stage = el("section", { class: "stage" }, [layer]);
    const banner = el("div", { class: "banner" });

    this.nodes = {
      left, inspector, stage, layer, art, overlay, banner, problems, pill,
    };
    this.sidebars = { left: new Panel(left), inspector: new Panel(inspector) };

    if (this.operate) {
      /* the deployed view: the artboard alone. The banner stays: reconnects and refused
         edits still need a voice. The problems button and pill exist unattached, so the
         status handlers have somewhere to write. */
      this.root.appendChild(el("main", { class: "workspace" }, [stage]));
      this.root.appendChild(banner);
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
      this.workspaces = buildWorkspaces(content, data, style);

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

      /* the page selector sits between the wordmark and the tabs and, like the mode
         seg and play, means nothing over Data or Style */
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

      this.root.appendChild(
        el("header", { class: "topbar" }, [
          el("div", { class: "wordmark", text: "DART HMI" }),
          pageHost,
          tabs,
          el("div", { class: "status" }, [modes, play, problems, pill]),
        ]),
      );
      for (const ws of this.workspaces) {
        ws.root.hidden = ws.id !== this.workspace;
        this.root.appendChild(ws.root);
      }
      this.root.appendChild(banner);
      this.restoreSidebarWidths();
    }

    this.viewport = new Viewport(stage, layer, {
      canPan: (ev) => !this.grabbable(ev),
      onTap: (x, y, ev) => {
        if (this.view.mode !== "edit") return;
        const page = this.page();
        const id = page ? hitTest(page, x, y) : 0;
        this.clickSelect(id, ev.shiftKey);
      },
      onViewChange: () => this.queueCanvas(),
      onLongPress: (x, y, ev) => this.openContextAt(x, y, ev.clientX, ev.clientY),
    });

    stage.addEventListener("pointerdown", (ev) => this.onStageDown(ev as PointerEvent), true);
    stage.addEventListener("pointermove", (ev) => this.onStageHover(ev as PointerEvent));
    stage.addEventListener("pointerleave", () => {
      if (this.view.hover) {
        this.view.hover = 0;
        this.queueCanvas();
      }
    });
    stage.addEventListener("contextmenu", (ev) => this.onContextMenu(ev as MouseEvent));
    window.addEventListener("pointermove", (ev) => this.onStageMove(ev as PointerEvent));
    window.addEventListener("pointerup", (ev) => this.onStageUp(ev as PointerEvent));
    window.addEventListener("pointercancel", (ev) => this.onControlUp(ev as PointerEvent, true));
    window.addEventListener("blur", () => this.cancelControl());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.cancelControl();
    });
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

  /* pure view routing: the hidden workspaces stay alive (viewport transform, reconciled
     sidebars), and the connection and document never notice a switch */
  private setWorkspace(id: WorkspaceId): void {
    this.workspace = id;
    for (const ws of this.workspaces) ws.root.hidden = ws.id !== id;
    for (const tab of Array.from(this.root.querySelectorAll("button[data-workspace]")))
      tab.classList.toggle("on", (tab as HTMLElement).dataset.workspace === id);
    /* the mode switch and play act on the artboard: they mean nothing over Data or Style */
    for (const tool of this.stageTools) tool.hidden = id !== "content";
  }

  private setMode(mode: Mode): void {
    this.view.mode = mode;
    this.view.ghost = null;
    this.root.setAttribute("data-mode", mode);
    for (const button of Array.from(this.root.querySelectorAll("button[data-mode]")))
      button.classList.toggle("on", (button as HTMLElement).dataset.mode === mode);
    /* an operator surface stays still; editing wants pan and zoom everywhere */
    this.viewport?.setLocked(mode === "operate" && window.innerWidth > 900);
    this.renderAll();
  }

  /* ---- selection and direct manipulation ---- */

  private grabbable(ev: PointerEvent): boolean {
    const target = ev.target as Element | null;
    /* operating: only an interactive ELEMENT claims the pointer, so a touch on a
       widget's inert background can still pan the viewport */
    if (this.view.mode !== "edit") return Boolean(target?.closest?.("[data-act]"));
    return Boolean(target?.closest?.("[data-id], [data-handle]"));
  }

  private clickSelect(id: number, extend: boolean): void {
    if (!id) {
      this.select([]);
      return;
    }
    if (!extend) {
      this.select([id]);
      return;
    }
    const at = this.view.selection.indexOf(id);
    this.select(at >= 0
      ? this.view.selection.filter((other) => other !== id)
      : this.view.selection.concat([id]));
  }

  private onStageHover(ev: PointerEvent): void {
    if (this.view.mode !== "edit" || this.drag) return;
    const page = this.page();
    if (!page || !this.viewport) return;
    const at = this.viewport.toArtboard(ev.clientX, ev.clientY);
    const id = hitTest(page, at.x, at.y);
    if (id === this.view.hover) return;
    this.view.hover = id;
    this.queueCanvas();
  }

  private onStageDown(ev: PointerEvent): void {
    if (this.view.mode !== "edit") {
      this.onControlDown(ev);
      return;
    }
    if (ev.button !== 0 || !this.viewport) return;
    const target = ev.target as HTMLElement | null;
    const handle = target?.closest?.("[data-handle]") as HTMLElement | null;
    const widgetNode = target?.closest?.("[data-id]") as HTMLElement | null;
    if (!handle && !widgetNode) return;

    let selection = this.view.selection.slice();
    let descend: string | null = null;
    if (!handle && widgetNode) {
      const id = Number(widgetNode.dataset.id);
      if (selection.indexOf(id) < 0) {
        this.clickSelect(id, ev.shiftKey);
        selection = this.view.selection.slice();
      } else if (!ev.shiftKey && selection.length === 1 && selection[0] === id) {
        /* a second click on the already-selected widget descends into the part under
           the pointer: the browser's own hit test names it (the overlay is
           click-through, so the target rides the art SVG). Committed at the up edge,
           so a drag never descends. */
        const partNode = target?.closest?.("[data-part]") as Element | null;
        if (partNode && partNode.closest("[data-id]") === widgetNode)
          descend = partNode.getAttribute("data-part");
      }
    }
    const widgets = selection
      .map((id) => this.store.widget(id))
      .filter(Boolean) as Widget[];
    if (!widgets.length) return;

    const at = this.viewport.toArtboard(ev.clientX, ev.clientY);
    this.drag = {
      mode: handle?.dataset.handle ?? "move",
      part: descend,
      widgets,
      start: bboxOf(widgets),
      geoms: widgets.map((w) => ({ ...w.geom })),
      x0: at.x,
      y0: at.y,
      moved: false,
    };
    ev.stopPropagation();
    ev.preventDefault();
  }

  private onStageMove(ev: PointerEvent): void {
    if (this.control) {
      this.onControlMove(ev);
      return;
    }
    if (!this.drag || !this.viewport) return;
    const at = this.viewport.toArtboard(ev.clientX, ev.clientY);
    const dx = at.x - this.drag.x0;
    const dy = at.y - this.drag.y0;
    if (!this.drag.moved && Math.hypot(dx, dy) * this.view.scale < 4) return;
    this.drag.moved = true;
    this.view.ghost = this.targetBox(this.drag, dx, dy, ev.altKey);
    this.queueCanvas();
  }

  private onStageUp(ev: PointerEvent): void {
    if (this.control) {
      this.onControlUp(ev, false);
      return;
    }
    if (!this.drag) return;
    const drag = this.drag;
    this.drag = null;
    this.view.ghost = null;
    if (!drag.moved || !this.viewport) {
      /* the second click that never dragged: descend into the noted part; with no part
         under the pointer the widget selection simply stands */
      if (typeof drag.part === "string" && drag.part)
        this.selectPart((drag.widgets as Widget[])[0].id, drag.part);
      this.queueCanvas();
      return;
    }
    const at = this.viewport.toArtboard(ev.clientX, ev.clientY);
    const box = this.targetBox(drag, at.x - drag.x0, at.y - drag.y0, ev.altKey);
    const from: Rect = drag.start;
    const scaleX = from.w ? box.w / from.w : 1;
    const scaleY = from.h ? box.h / from.h : 1;
    /* a group resize maps each widget through the bbox transform, so relative placement
       survives; for a single widget it is just the new rect */
    const ops: Op[] = drag.widgets.map((widget: Widget, index: number) => {
      const geom = drag.geoms[index];
      return {
        op: "set_prop",
        node: widget.id,
        key: "geom",
        value: {
          x: Math.round(box.x + (geom.x - from.x) * scaleX),
          y: Math.round(box.y + (geom.y - from.y) * scaleY),
          w: Math.max(MIN_SIZE, Math.round(geom.w * scaleX)),
          h: Math.max(MIN_SIZE, Math.round(geom.h * scaleY)),
        },
      };
    });
    this.apply(ops);
    this.queueCanvas();
  }

  /* the type's interacts in template PREORDER: the same order the renderer counts them
     off into data-act ordinals, so a hit group names its interact by index */
  private interactions(type: WidgetType | null): Interact[] {
    const out: Interact[] = [];
    const walk = (node: Json): void => {
      if (!node) return;
      if (node.interact) out.push(node.interact as Interact);
      for (const child of node.children ?? []) walk(child);
    };
    if (type) walk(type.template);
    return out;
  }

  private controlCells(widget: Widget, type: WidgetType): (cell: string) => Json {
    return cellsFor(widget, type, this.live, this.view.state[widget.id] ?? {}, this.mesh,
                    null, this.theme());
  }

  /* What the gesture itself reports. Where the type declares where `x` comes from, that
     is the backend's to derive and this sends nothing: a view holding its own copy of a
     value the backend already owns is exactly the truth this tier must not hold. */
  private eventValue(type: WidgetType, event: string, down: boolean): Json {
    return type.events.find((row) => row.name === event)?.value ? null : down;
  }

  private emitInput(widget: Widget, event: string | undefined, value: Json): void {
    if (!event) return;
    this.conn.input(widget.id, event, value, ++this.inputSequence);
  }

  private onControlDown(ev: PointerEvent): void {
    if (ev.button !== 0 || !this.viewport) return;
    /* The browser's own SVG hit test decides what is interactive: a gesture starts only
       on something PAINTED by an interact-carrying template element, so a circle hits
       inside the circle and a toggle only on its pill, never the tile around it. The
       group's ordinal names which of the type's interacts was hit. */
    const target = ev.target as Element | null;
    const hit = (target?.closest?.("[data-act]") ?? null) as Element | null;
    if (!hit) return;
    const holder = hit.closest("[data-id]");
    const widget = this.store.widget(Number(holder?.getAttribute("data-id") ?? 0));
    if (!widget) return;
    const type = typeOf(this.registry, widget.type);
    const interact = type
      ? this.interactions(type)[Number(hit.getAttribute("data-act") ?? 0)] ?? null
      : null;
    if (!type || !interact) return;
    const at = this.viewport.toArtboard(ev.clientX, ev.clientY);
    const fed = fedSlots(widget);
    if (resolveSlot(widget, type, this.live, fed, "enabled") !== true) return;
    /* a radial gesture pivots on the CENTER of what the interact painted (the dial),
       measured in client pixels once at the down edge; linear mode instead anchors on
       the down point and the fraction the control held there. The dial OWNS the fit
       (spec 2.3): its own area already IS the fitted circle's bounding square, and the
       renderer gives an interact-carrying node an invisible full-area rect so its
       bbox is that whole square rather than just whatever a partial sweep painted —
       so the plain bbox center is always the right pivot, no fit params to re-derive. */
    const pivot = hit.getBoundingClientRect();
    const cells = this.controlCells(widget, type);
    const f0 = interact.params.fraction ? run(interact.params.fraction, cells) : null;
    const cx = pivot.left + pivot.width / 2;
    const cy = pivot.top + pivot.height / 2;
    this.control = {
      pointer: ev.pointerId,
      widget,
      type,
      interact,
      started: performance.now(),
      cx,
      cy,
      downX: ev.clientX,
      downY: ev.clientY,
      f0: typeof f0 === "number" ? Math.max(0, Math.min(1, f0)) : 0,
    };
    this.view.state[widget.id] = {
      ...(this.view.state[widget.id] ?? {}),
      pressed: interact.primitive === "press",
      dragging: interact.primitive === "drag1d" || interact.primitive === "drag_radial",
      open: interact.primitive === "pick",
    };
    if (interact.primitive === "press")
      this.emitInput(widget, interact.emits.press,
        this.eventValue(type, interact.emits.press, true));
    else if (interact.primitive === "pick")
      this.emitInput(widget, interact.emits.open,
        this.eventValue(type, interact.emits.open, true));
    else if (interact.primitive === "drag1d")
      /* a press on the track IS a drag to that point: without this, a click that never
         moves emits nothing at all and the knob ignores it */
      this.emitDrag(widget, type, interact, at.x, at.y);
    else if (interact.primitive === "drag_radial")
      /* linear mode emits nothing at the down edge: the value moves relative to the
         drag, and a click that never drags jumps at the UP edge instead */
      this.emitRadial(widget, type, interact, ev.clientX, ev.clientY);
    this.queueCanvas(true);
    ev.preventDefault();
    ev.stopPropagation();
  }

  /* the drag1d primitive: map a point in the tile onto the range its params declare, and
     report it. The value it computes is not truth, it is an input event like any other */
  private emitDrag(widget: Widget, type: WidgetType, interact: Interact, x: number, y: number): void {
    const cells = this.controlCells(widget, type);
    const axis = String(run(interact.params.axis, cells) ?? "x");
    const lo = Number(run(interact.params.min, cells) ?? 0);
    const hi = Number(run(interact.params.max, cells) ?? 1);
    const step = Math.max(0, Number(run(interact.params.step, cells) ?? 0));
    const fraction = axis === "y"
      ? 1 - (y - widget.geom.y) / widget.geom.h
      : (x - widget.geom.x) / widget.geom.w;
    let value = lo + Math.max(0, Math.min(1, fraction)) * (hi - lo);
    if (step > 0) value = lo + Math.round((value - lo) / step) * step;
    if (this.control) this.control.value = value;
    this.emitInput(widget, interact.emits.input, value);
  }

  /* The drag_radial primitive: the pointer's bearing from the control's center, mapped
   * onto the sweep the params declare (degrees, 0 = up, clockwise; the same convention
   * the arc parts draw with). A bearing outside the sweep clamps to the nearer end, so
   * dragging past the stop holds it there. With `mode` "linear" (the default) the same
   * control DRAGS like a fader instead: horizontal motion moves the value RELATIVE to
   * where it stood at pointer-down (the `fraction` param), full range over ~220 px; a
   * CLICK that never drags still jumps to the clicked bearing (`jump`, sent from the
   * up edge), so pointing at a position works in both modes. With `options`, the range
   * is a detent per option and the gesture reports the SELECTED NAME (on change only);
   * without, it reports the min..max value like drag1d. */
  private emitRadial(widget: Widget, type: WidgetType, interact: Interact,
                     clientX: number, clientY: number, jump = false): void {
    const cells = this.controlCells(widget, type);
    let fraction: number;
    if (!jump && String(run(interact.params.mode, cells) ?? "radial") === "linear") {
      const moved = clientX - Number(this.control?.downX ?? clientX);
      if (!moved) return;
      fraction = Math.max(0, Math.min(1, Number(this.control?.f0 ?? 0) + moved / 220));
    } else {
      const start = Number(run(interact.params.start, cells) ?? -135);
      const sweep = Math.max(1, Math.min(360, Number(run(interact.params.sweep, cells) ?? 270)));
      const dx = clientX - Number(this.control?.cx ?? 0);
      const dy = clientY - Number(this.control?.cy ?? 0);
      if (dx * dx + dy * dy < 9) return;              /* dead zone: no bearing yet */
      const bearing = (Math.atan2(dx, -dy) * 180) / Math.PI;   /* [-180, 180], 0 = up */
      let rel = ((bearing - start) % 360 + 360) % 360;          /* into [0, 360) */
      /* past the open end: snap to whichever stop is closer around the gap */
      if (rel > sweep) rel = rel - sweep < (360 - rel) ? sweep : 0;
      fraction = rel / sweep;
    }

    if (interact.params.options) {
      const options = widgetOptions(widget, type, this.live, fedSlots(widget), this.mesh,
                                    run(interact.params.options, cells));
      if (options.length < 2) return;
      const name = options[Math.round(fraction * (options.length - 1))];
      if (this.control && this.control.value !== name) {
        this.control.value = name;
        this.emitInput(widget, interact.emits.select, name);
      }
      return;
    }

    const lo = Number(run(interact.params.min, cells) ?? 0);
    const hi = Number(run(interact.params.max, cells) ?? 1);
    const step = Math.max(0, Number(run(interact.params.step, cells) ?? 0));
    let value = lo + fraction * (hi - lo);
    if (step > 0) value = lo + Math.round((value - lo) / step) * step;
    if (this.control) this.control.value = value;
    this.emitInput(widget, interact.emits.input, value);
  }

  private onControlMove(ev: PointerEvent): void {
    const control = this.control;
    if (!control || control.pointer !== ev.pointerId || !this.viewport) return;
    if (control.interact.primitive === "drag_radial") {
      /* a real drag, once the pointer has left the click slop */
      const slopX = ev.clientX - Number(control.downX ?? ev.clientX);
      const slopY = ev.clientY - Number(control.downY ?? ev.clientY);
      if (control.moved || slopX * slopX + slopY * slopY > 16) control.moved = true;
      if (control.moved)
        this.emitRadial(control.widget as Widget, control.type as WidgetType,
                        control.interact, ev.clientX, ev.clientY);
      ev.preventDefault();
      return;
    }
    if (control.interact.primitive !== "drag1d") return;
    const at = this.viewport.toArtboard(ev.clientX, ev.clientY);
    this.emitDrag(control.widget as Widget, control.type as WidgetType, control.interact, at.x, at.y);
    ev.preventDefault();
  }

  private onControlUp(ev: PointerEvent, cancelled: boolean): void {
    const control = this.control;
    if (!control || (ev.pointerId !== undefined && control.pointer !== ev.pointerId)) return;
    /* the gesture stays current until the end of this handler: the click-jump below
       still needs its pivot (cx/cy) and down point */
    const widget = control.widget as Widget;
    const type = control.type as WidgetType;
    const interact = control.interact as Interact;
    const state = this.view.state[widget.id] ?? {};
    state.pressed = state.dragging = state.open = false;
    if (interact.primitive === "press") {
      this.emitInput(widget, interact.emits.release,
        this.eventValue(type, interact.emits.release, false));
      const hold = Number(run(interact.params.hold_ms, this.controlCells(widget, type)) ?? 600);
      if (!cancelled && performance.now() - control.started < hold)
        this.emitInput(widget, interact.emits.tap,
          this.eventValue(type, interact.emits.tap, true));
    } else if (interact.primitive === "drag1d" || interact.primitive === "drag_radial") {
      /* a CLICK on a radial control (nothing emitted yet) jumps to the clicked
         bearing, whatever the drag mode: pointing at a position always works */
      if (interact.primitive === "drag_radial" && !cancelled && control.value === undefined)
        this.emitRadial(widget, type, interact, ev.clientX, ev.clientY, true);
      if (!cancelled && control.value !== undefined)
        this.emitInput(widget, interact.emits.commit, control.value);
    } else if (interact.primitive === "pick" && !cancelled) {
      /* a REAL menu: the options slot holds a TypeRef naming an enum (spec 6.2), and
         the variant names come off the served type table, so the list can never drift
         from the schema. Selection is an input event like any other. */
      const options = widgetOptions(widget, type, this.live, fedSlots(widget), this.mesh,
                                    run(interact.params.options, this.controlCells(widget, type)));
      if (options.length) {
        const current = String(
          resolveSlot(widget, type, this.live, fedSlots(widget), "value") ?? "");
        this.openPickTray(widget, type, options, current, (option) =>
          this.emitInput(widget, interact.emits.select, option));
      }
    }
    this.control = null;
    this.queueCanvas(true);
  }

  /* The Dropdown's tray is WIDGET chrome, not editor chrome: it hangs under the field
     at the field's own width and wears the widget's resolved surface, border, radius
     and text colour, so the open control reads as one piece of the same widget. */
  private openPickTray(widget: Widget, type: WidgetType, options: string[],
                       current: string, pick: (option: string) => void): void {
    const anchor = document.querySelector('[data-id="' + widget.id + '"]');
    const rect = anchor?.getBoundingClientRect();
    if (!rect || !rect.width) return;
    const fed = fedSlots(widget);
    const runtime = runtimeSlots(widget, type);
    const theme = this.theme();
    const slot = (name: string) => resolveSlot(widget, type, this.live, fed, name);
    /* the tray wears the widget's colors, so they resolve exactly as the canvas does */
    const color = (name: string) =>
      themedSlot(widget, type, this.live, fed, runtime, theme, name);
    /* the frame's radius rule (canvas.ts): auto nests inside the island's corner at
       the panel inset; units become pixels at the widget's own on-screen scale */
    const panelPad = Number(slot("panel_pad") ?? -1);
    const inset = panelPad < 0 ? 5 : panelPad;
    const rawRadius = Number(slot("radius") ?? -1);
    const units = rawRadius < 0 ? Math.max(0, 16 - inset) : rawRadius;
    const scale = rect.height / Math.max(1, widget.geom.h - 2 * inset);

    const overlay = el("div", { class: "pick-shade" });
    const tray = el("div", { class: "pick-tray", "data-input": "scroll" });
    tray.style.left = rect.left + "px";
    tray.style.top = rect.bottom + 4 + "px";
    tray.style.width = rect.width + "px";
    tray.style.maxHeight = Math.max(60, window.innerHeight - rect.bottom - 16) + "px";
    tray.style.background = String(color("surface") ?? "#141414");
    tray.style.border = "1px solid " + String(color("border") ?? "#2e2e2e");
    tray.style.borderRadius = Math.round(units * scale) + "px";
    tray.style.color = String(color("text_color") ?? "#ececec");
    const close = () => overlay.remove();
    overlay.addEventListener("pointerdown", (pd) => {
      if (pd.target === overlay) close();
    });
    for (const option of options) {
      const row = el("button", { class: "pick-row" }, [
        el("span", {
          class: "pick-check",
          html: option === current ? iconMarkup("check", 11, 2) : "",
        }),
        el("span", { text: option }),
      ]);
      row.addEventListener("click", () => {
        close();
        pick(option);
      });
      tray.appendChild(row);
    }
    overlay.appendChild(tray);
    document.body.appendChild(overlay);
    /* no room below: hang it above the field instead */
    if (rect.bottom + 4 + tray.offsetHeight > window.innerHeight - 8)
      tray.style.top = Math.max(8, rect.top - tray.offsetHeight - 4) + "px";
  }

  private cancelControl(): void {
    if (!this.control) return;
    this.onControlUp({ pointerId: this.control.pointer } as PointerEvent, true);
  }

  /* Where the selection bbox lands: snapped to the cell grid unless Alt frees it. The drag
   * is passed in, never read from the field: the release path clears the field first. */
  private targetBox(drag: Json, dx: number, dy: number, free: boolean): Rect {
    const doc = this.store.doc;
    const cell = doc ? cellSize(doc.canvas) : 22;
    const snap = (v: number) => (free ? Math.round(v) : Math.round(v / cell) * cell);
    const from: Rect = drag.start;
    const mode: string = drag.mode;
    if (mode === "move")
      return { x: snap(from.x + dx), y: snap(from.y + dy), w: from.w, h: from.h };

    let { x, y, w, h } = from;
    if (mode.includes("L")) {
      const right = x + w;
      x = Math.min(snap(x + dx), right - MIN_SIZE);
      w = right - x;
    }
    if (mode.includes("R")) w = Math.max(MIN_SIZE, snap(x + w + dx) - x);
    if (mode.includes("T")) {
      const bottom = y + h;
      y = Math.min(snap(y + dy), bottom - MIN_SIZE);
      h = bottom - y;
    }
    if (mode.includes("B")) h = Math.max(MIN_SIZE, snap(y + h + dy) - y);
    return { x, y, w, h };
  }

  private onKey(ev: KeyboardEvent): void {
    const typing = (ev.target as HTMLElement)?.matches?.("input, select, textarea");
    if (typing) return;
    if (ev.key === "Escape") {
      closeMenu();
      /* the inner level steps out first: component part -> component -> none, and a
         selected widget part -> widget -> none, one level per press */
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
      } else if (this.view.part && this.view.selection.length)
        this.selectPart(this.view.selection[0], "");
      else this.select([]);
    }
    /* edit shortcuts only over the artboard: a Delete in another workspace must not
       silently remove the selection it cannot show */
    if (this.view.mode !== "edit" || this.workspace !== "content") return;
    if (ev.key === "Delete" || ev.key === "Backspace") {
      this.removeSelection();
      ev.preventDefault();
    }
    if (ev.key === "d" && (ev.ctrlKey || ev.metaKey)) {
      this.duplicate();
      ev.preventDefault();
    }
  }

  /* ---- context menu (right-click, or long-press on touch) ---- */

  private onContextMenu(ev: MouseEvent): void {
    if (this.view.mode !== "edit" || !this.viewport) return;
    ev.preventDefault();
    const at = this.viewport.toArtboard(ev.clientX, ev.clientY);
    this.openContextAt(at.x, at.y, ev.clientX, ev.clientY);
  }

  /* right-click on the desktop, long-press on touch: the same menu either way */
  private openContextAt(x: number, y: number, clientX: number, clientY: number): void {
    const page = this.page();
    if (!page || this.view.mode !== "edit") return;
    const ev = { clientX, clientY };
    const at = { x, y };
    const id = hitTest(page, at.x, at.y);
    if (id) {
      if (this.view.selection.indexOf(id) < 0) this.select([id]);
      const widget = this.store.widget(id);
      openMenu(ev.clientX, ev.clientY, widget ? widget.type : "Widget", [
        { label: "Duplicate", icon: "copy", run: () => this.duplicate() },
        { label: "Delete", icon: "trash", danger: true, run: () => this.removeSelection() },
      ]);
      return;
    }
    this.select([]);
    openMenu(
      ev.clientX,
      ev.clientY,
      "Add widget",
      (this.registry?.types ?? []).map((type) => ({
        label: type.name,
        icon: type.name,
        run: () => this.addWidget(type.name, at.x, at.y),
      })),
    );
  }

  private addWidget(type: string, atX?: number, atY?: number): void {
    const page = this.page();
    const doc = this.store.doc;
    if (!page || !doc) return;
    const cell = cellSize(doc.canvas);
    const w = 6 * cell;
    const h = 3 * cell;
    const clash = (px: number, py: number) =>
      (page.widgets ?? []).some(
        (other) =>
          !(px + w <= other.geom.x || other.geom.x + other.geom.w <= px ||
            py + h <= other.geom.y || other.geom.y + other.geom.h <= py),
      );
    let x = atX === undefined ? cell : Math.round(atX / cell) * cell;
    let y = atY === undefined ? cell : Math.round(atY / cell) * cell;
    if (atX === undefined)
      for (let row = 1; row < doc.canvas.rows - 3 && clash(x, y); row++)
        for (let col = 1; col < doc.canvas.cols - 6; col++) {
          x = col * cell;
          y = row * cell;
          if (!clash(x, y)) break;
        }
    this.apply([
      {
        op: "insert",
        parent: page.id,
        list: "widgets",
        node: { type, label: type, geom: { x, y, w, h } },
      },
    ]);
  }

  private duplicate(): void {
    const page = this.page();
    const doc = this.store.doc;
    if (!page || !doc) return;
    const cell = cellSize(doc.canvas);
    const ops: Op[] = [];
    for (const id of this.view.selection) {
      const widget = this.store.widget(id);
      if (!widget) continue;
      const copy = stripIds(JSON.parse(JSON.stringify(widget)));
      copy.geom = { ...widget.geom, x: widget.geom.x + cell, y: widget.geom.y + cell };
      ops.push({ op: "insert", parent: page.id, list: "widgets", node: copy });
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
