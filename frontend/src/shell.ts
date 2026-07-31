/* The application shell: the frame (topbar, workspace tabs, mode switch) around the
 * workspaces, and the wiring between the connection, the document mirror and the
 * sidebars. The content workspace is the three-column editor; the shell holds only view
 * state (selection, mode, active workspace, sidebar widths); every edit leaves as an op
 * and comes back as a broadcast, so two windows are always looking at the same document.
 *
 * THE STAGE IS EMPTY. Everything that drew a page or answered a gesture on it — the two
 * artboard SVGs, the template renderer behind them, the pan/zoom camera, hit testing,
 * drag-move and the resize grips, the four interaction primitives — has been removed
 * rather than adapted, because the substrate under all of it changed: a page becomes real
 * DOM laid out by the browser, so hit testing, dragging and scaling all become things the
 * browser already does and none of the machinery here would have survived the port. What
 * remains is the half that was never about pixels: the connection, the document mirror,
 * selection, the four workspaces' panels, and structural editing by TREE POSITION rather
 * than by coordinate. */

import { DocStore } from "./doc.js";
import { clear, el, iconButton } from "./dom.js";
import { Editor, Mode, ViewState } from "./editor.js";
import { closeMenu, openMenu } from "./menu.js";
import { inspectorShape, leftShape, renderInspector, renderLeftSidebar } from "./inspector/panel.js";
import { refreshSourceTree } from "./inspector/sourcetree.js";
import { pageSelectShape, renderPageSelect } from "./pageselect.js";
import { Connection, Status } from "./protocol.js";
import { Panel } from "./reconcile.js";
import { AttrTable, BuiltinDef, Diag, Doc, Frame, Json, Lang, Live, Mesh, Op, Page, Registry, Widget } from "./types.js";
import { buildWorkspaces, Workspace, WorkspaceId } from "./workspaces.js";
import { dataShape, renderDataDetail, renderDataTree } from "./workspaces/data.js";
import { designInspectorShape, designShape, renderDesignInspector, renderDesignTree } from "./workspaces/design.js";
import { renderStyleWorkspace, styleShape } from "./workspaces/style.js";

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 640;

export class App implements Editor {
  store = new DocStore();
  registry: Registry | null = null;
  /* the reflected entity tree, served by the backend: the "dart" root of the coming
     source picker (stage 6); the "hmi" root is the document's own variables */
  mesh: Mesh = { entities: [], types: [] };
  /* the served expression vocabulary: autocomplete reads exactly what compiles */
  lang: Lang | null = null;
  /* the closed attr vocabulary (spec 2.3), snapshot-only like `lang`: the part
     inspector's Attrs section lists exactly this, set or not */
  attrTable: AttrTable | null = null;
  /* the built-ins' editable document form, snapshot-only (it never changes at runtime):
     the Components tree browses it and a fork copies one entry into doc.components */
  builtins: BuiltinDef[] = [];
  /* the component-edit selection; mutually exclusive with the widget selection */
  componentSel: { component: number; node: number } | null = null;
  /* the built-in being browsed read-only: its name plus a child-index path into its
     parts ("" = the component itself). Mutually exclusive with the other two. */
  builtinSel: { name: string; path: string } | null = null;
  live: Live | null = null;
  diagnostics: Diag[] = [];
  view: ViewState = {
    mode: "edit", selection: [], part: "", hover: 0, state: {}, faults: {},
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
  /* a just-forked or just-added component's name: its insert is in flight, and the ids
     the backend issues arrive with the echo, so selection resolves there by name */
  private pendingComponent: string | null = null;
  private frame = 0;
  private sidebarsDirty = true;

  /* `operate` is the deployed view: no topbar, no sidebars, the artboard alone */
  constructor(private root: HTMLElement, url: string, private operate = false) {
    this.build();
    if (this.operate) this.setMode("operate");
    this.conn = new Connection(url, {
      snapshot: (doc, registry, live, diag, mesh, lang, attrTable, builtins) =>
        this.onSnapshot(doc, registry, live, diag, mesh, lang, attrTable, builtins),
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

  /* the selected FRAME, when the (single) selection names one: selected only from the
     Layers tree (spec 2.8), never by clicking the artboard */
  selectedFrame(): Frame | null {
    const id = this.view.selection[0];
    return id ? this.store.frame(id) : null;
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

  /* The page selection and the component selection are no longer mutually exclusive:
     they belong to different workspaces, so clearing one when the other moves would
     lose your place in Design every time you touched the artboard. */
  select(ids: number[]): void {
    this.view.selection = ids;
    this.view.part = "";
    this.queueSidebars();
  }

  /* part selection: the widget is selected and the focus narrows to one named template
     node; the inspector scopes to it */
  selectPart(id: number, path: string): void {
    this.view.selection = [id];
    this.view.part = path;
    this.queueSidebars();
  }

  /* the Design workspace's selection: a component, or one part node inside it. The two
     component selections ARE exclusive of each other (one inspector, one subject); the
     page selection is untouched, since it belongs to another workspace. */
  selectComponent(component: number, node: number): void {
    this.componentSel = component ? { component, node: node || component } : null;
    this.builtinSel = null;
    this.setWorkspace("design");
    this.queueSidebars();
  }

  /* browse a built-in read-only (spec 2.3 Forking: reading the shipped definition is
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
    this.queueSidebars();
  }

  private queueSidebars(): void {
    this.sidebarsDirty = true;
    this.schedule();
  }

  /* Everything arriving from the wire is coalesced into one frame, so a burst of op echoes
     and 30 Hz live frames costs one pass, not one pass each. */
  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.sidebarsDirty) {
        this.sidebarsDirty = false;
        this.renderSidebars();
      }
    });
  }

  refresh(): void {
    this.queueSidebars();
  }

  /* ---- protocol ----
   *
   * Neither entry point below reads a frame's `hist` deltas any more. The wire still
   * delivers them — the backend owns trend history and nothing about that changed — but
   * the standing views this shell folded them into existed for one reader, the Trend
   * widget's plot, which went with the renderer. Accumulating them for nobody would be
   * keeping a buffer warm against a consumer whose shape is not decided yet, so the
   * rebuild folds them again, where it knows what it needs. */

  private onSnapshot(doc: Doc, registry: Registry, live: Live, diag: Diag[], mesh: Mesh,
                     lang: Lang, attrTable: AttrTable, builtins: BuiltinDef[]): void {
    this.store.load(doc);
    this.registry = registry;
    this.live = live;
    this.mesh = { entities: mesh?.entities ?? [], types: mesh?.types ?? [] };
    this.lang = lang;
    this.attrTable = attrTable;
    this.builtins = Array.isArray(builtins) ? builtins : [];
    this.onDiag(diag, false);
    const page = this.page();
    this.pageId = page ? page.id : 0;
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
      const widget = this.store.owningWidget(row.node);
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
    const widget = this.store.owningWidget(row.node);
    if (widget) this.select([widget]);
    this.flash(row.message);
  }

  /* every finding about this widget or anything inside it */
  diagFor(widget: number): Diag[] {
    return this.diagnostics.filter((row) => this.store.owningWidget(row.node) === widget);
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
    clear(this.root);
    const pill = el("span", { class: "pill connecting", title: "connecting" });
    /* clicking a compile finding selects the widget it names */
    const problems = el("button", { class: "problems", onclick: () => this.showProblem() });
    const left = el("aside", { class: "sidebar left" });
    const inspector = el("aside", { class: "sidebar right" });
    /* An honest empty pane. It is a real element and it holds the layout's middle column
       so the two sidebars and their gutters still have something to sit either side of;
       it just draws nothing, because nothing here can draw a page any more. */
    const stage = el("section", { class: "stage empty" });
    const banner = el("div", { class: "banner" });

    this.nodes = { left, inspector, stage, banner, problems, pill };
    this.sidebars = { left: new Panel(left), inspector: new Panel(inspector) };

    if (this.operate) {
      /* the deployed view: nothing to deploy while the stage is empty. The banner stays:
         reconnects and refused edits still need a voice. The problems button and pill
         exist unattached, so the status handlers have somewhere to write. */
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
      /* Design: the component tree and the component/part inspector, either side of an
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

      this.root.appendChild(
        el("header", { class: "topbar" }, [
          el("div", { class: "wordmark", text: "DART HMI" }),
          tabs,
          pageHost,
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

    /* The stage listens for one thing: a right-click asking to add a widget. There is
       nothing under the pointer to hit-test against, so the menu adds by TREE POSITION
       (append to the current page) rather than at the coordinate clicked. */
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
    for (const tab of Array.from(this.root.querySelectorAll("button[data-workspace]")))
      tab.classList.toggle("on", (tab as HTMLElement).dataset.workspace === id);
    /* the mode switch and play act on the artboard: they mean nothing over Data or Style */
    for (const tool of this.stageTools) tool.hidden = id !== "content";
  }

  private setMode(mode: Mode): void {
    this.view.mode = mode;
    this.root.setAttribute("data-mode", mode);
    for (const button of Array.from(this.root.querySelectorAll("button[data-mode]")))
      button.classList.toggle("on", (button as HTMLElement).dataset.mode === mode);
    this.renderAll();
  }

  /* Direct manipulation and the four interaction primitives (press, drag1d, drag_radial
     and the pick tray) stood here and are gone. Both rested on the same two things: a
     coordinate space this view owned, and a hit test it performed itself against resolved
     rects. Under DOM neither is ours — the browser hit-tests, and a gesture arrives already
     addressed to the element it landed on — so every line of it would have been rewritten
     rather than moved. Selection now comes from the Layers tree only, and TEST MODE drives
     nothing until the primitives are rebuilt on ordinary DOM events. */


  private onKey(ev: KeyboardEvent): void {
    const typing = (ev.target as HTMLElement)?.matches?.("input, select, textarea");
    if (typing) return;
    if (ev.key === "Escape") {
      closeMenu();
      /* Escape steps out one level WITHIN the active workspace: in Design, part ->
         component -> none; in Content, widget part -> widget -> none. */
      if (this.workspace !== "design") {
        if (this.view.part && this.view.selection.length)
          this.selectPart(this.view.selection[0], "");
        else this.select([]);
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
    if (this.view.mode !== "edit") return;
    ev.preventDefault();
    this.openContextAt(ev.clientX, ev.clientY);
  }

  /* The menu no longer asks WHERE it was opened, only WHAT is selected. With nothing
     drawn there is nothing under the pointer to hit-test, so the click cannot name a
     widget and cannot name a position: a selection (made in the Layers tree) offers its
     own verbs, and an empty selection offers the type list, which appends. */
  private openContextAt(clientX: number, clientY: number): void {
    const page = this.page();
    if (!page || this.view.mode !== "edit") return;
    if (this.view.selection.length) {
      const widget = this.store.widget(this.view.selection[0]);
      openMenu(clientX, clientY, widget ? widget.type : "Selection", [
        { label: "Duplicate", icon: "copy", run: () => this.duplicate() },
        { label: "Delete", icon: "trash", danger: true, run: () => this.removeSelection() },
      ]);
      return;
    }
    openMenu(
      clientX,
      clientY,
      "Add widget",
      (this.registry?.types ?? []).map((type) => ({
        label: type.name,
        icon: type.name,
        run: () => this.addWidget(type.name),
      })),
    );
  }

  /* Append to the current page. Placement used to be a clash search over every resolved
     rect, looking for a free patch of grid; there is no grid and no free patch to find,
     because order in the tree is the only thing that will place a frame's child. `geom`
     is left off entirely — the schema still fills its default, and that default is on its
     way out with the rest of manual geometry. */
  private addWidget(type: string): void {
    const page = this.page();
    if (!page) return;
    this.apply([
      {
        op: "insert",
        parent: page.id,
        list: "children",
        node: { kind: "widget", type, label: type },
      },
    ]);
  }

  /* duplicate every selected widget OR frame into its OWN parent, directly after it: a
     frame's child duplicates back into that frame, a page-level node back onto the page.
     The copy used to be nudged one cell down and right so it did not hide under its
     original; a list has no "under", so it simply follows. */
  private duplicate(): void {
    const ops: Op[] = [];
    for (const id of this.view.selection) {
      const node = this.store.widget(id) ?? this.store.frame(id);
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
