/* The application shell: three columns, the mode switch, and the wiring between the
 * connection, the document mirror and the rails. The shell holds only view state
 * (selection, mode, fold, rail widths); every edit leaves as an op and comes back as a
 * broadcast, so two windows are always looking at the same document. */

import { hitTest, renderArtboard, ViewState } from "./canvas.js";
import { DocStore } from "./doc.js";
import { clear, el, select, svg } from "./dom.js";
import { Connection, Status } from "./protocol.js";
import { renderInspector, renderLeftRail } from "./rails.js";
import { Viewport } from "./viewport.js";
import { Doc, Json, Live, Op, Page, Registry, Widget } from "./types.js";

type Mode = "edit" | "run" | "operate";

const RAIL_MIN = 200;
const RAIL_MAX = 560;

export class App {
  store = new DocStore();
  registry: Registry | null = null;
  live: Live | null = null;
  view: ViewState = { mode: "edit", selection: [], state: {} };

  private conn: Connection;
  private viewport: Viewport | null = null;
  private pageId = 0;
  private nodes!: {
    root: HTMLElement;
    left: HTMLElement;
    inspector: HTMLElement;
    stage: HTMLElement;
    layer: HTMLElement;
    art: SVGSVGElement;
    banner: HTMLElement;
    version: HTMLElement;
    pill: HTMLElement;
    palette: HTMLElement;
  };
  private drag: Json = null;
  private pendingRails = false;

  constructor(private root: HTMLElement, url: string) {
    this.build();
    this.conn = new Connection(url, {
      snapshot: (doc, registry, live) => this.onSnapshot(doc, registry, live),
      ops: (version, ops) => this.onOps(version, ops),
      live: (live) => {
        this.live = live;
        this.renderCanvas();
        this.renderRails();
      },
      diag: () => undefined,
      status: (state, detail) => this.onStatus(state, detail),
    });
  }

  start(): void {
    this.conn.connect();
  }

  /* ---- Editor interface (rails.ts) ---- */

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
    this.conn.view(id, true);
    this.renderAll();
  }

  select(ids: number[]): void {
    this.view.selection = ids;
    this.renderCanvas();
    this.renderRails(true);
  }

  /* ---- protocol ---- */

  private onSnapshot(doc: Doc, registry: Registry, live: Live): void {
    this.store.load(doc);
    this.registry = registry;
    this.live = live;
    const page = this.page();
    this.pageId = page ? page.id : 0;
    this.viewport?.setArtboard(doc.canvas.unit_w, doc.canvas.unit_h);
    this.buildPalette();
    this.conn.view(this.pageId, true);
    this.view.selection = this.view.selection.filter((id) => this.store.widget(id));
    this.renderAll();
  }

  private onOps(version: number, ops: Op[]): void {
    this.store.apply(version, ops);
    this.view.selection = this.view.selection.filter((id) => this.store.widget(id));
    if (!this.page()) this.pageId = this.store.pages()[0]?.id ?? 0;
    this.renderAll();
  }

  private onStatus(state: Status, detail: string): void {
    this.nodes.pill.className = "pill " + state;
    this.nodes.pill.textContent = state === "live" ? "live" : state;
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
    this.nodes.version.textContent = "v" + this.store.version();
    this.renderCanvas();
    this.renderRails();
  }

  private renderCanvas(): void {
    const doc = this.store.doc;
    const page = this.page();
    if (!doc || !page) {
      this.nodes.art.innerHTML = "";
      return;
    }
    this.nodes.art.setAttribute("viewBox", `0 0 ${doc.canvas.unit_w} ${doc.canvas.unit_h}`);
    this.nodes.art.innerHTML = renderArtboard(doc, page, this.registry, this.live, this.view);
  }

  /* A rail holding the caret is left alone until focus leaves it: a document broadcast
   * must never eat half-typed text (spec 4.2). */
  private renderRails(force = false): void {
    const focused = document.activeElement as HTMLElement | null;
    const busy = !force && focused ? focused.closest(".rail") : null;
    if (busy && !this.pendingRails) {
      this.pendingRails = true;
      busy.addEventListener(
        "focusout",
        () => {
          this.pendingRails = false;
          window.setTimeout(() => this.renderRails(), 0);
        },
        { once: true },
      );
    }
    if (busy !== this.nodes.left) renderLeftRail(this.nodes.left, this);
    if (busy !== this.nodes.inspector) renderInspector(this.nodes.inspector, this);
  }

  /* ---- shell construction ---- */

  private build(): void {
    clear(this.root);
    const pill = el("span", { class: "pill connecting", text: "connecting" });
    const version = el("span", { class: "version", text: "v0" });
    const palette = el("div", { class: "palette" });
    const left = el("aside", { class: "rail left" });
    const inspector = el("aside", { class: "rail right" });
    const art = svg("svg", { class: "artboard", width: "100%", height: "100%" }) as SVGSVGElement;
    const layer = el("div", { class: "layer" }, [art as unknown as Node]);
    const stage = el("section", { class: "stage" }, [layer]);
    const banner = el("div", { class: "banner" });

    const modes = el(
      "div",
      { class: "modes" },
      (["edit", "run", "operate"] as Mode[]).map((mode) =>
        el("button", {
          class: "mode" + (mode === this.view.mode ? " on" : ""),
          text: mode === "run" ? "debug run" : mode,
          "data-mode": mode,
          onclick: () => this.setMode(mode),
        }),
      ),
    );

    const workspace = el("main", { class: "workspace" }, [
      left,
      this.gutter("left"),
      stage,
      this.gutter("right"),
      inspector,
    ]);

    this.root.appendChild(
      el("header", { class: "topbar" }, [
        el("div", { class: "brand" }, [
          el("span", { class: "logo", text: "H" }),
          el("span", { class: "name", text: "HMI Designer" }),
        ]),
        modes,
        palette,
        el("div", { class: "status" }, [version, pill]),
      ]),
    );
    this.root.appendChild(workspace);
    this.root.appendChild(banner);

    this.nodes = { root: this.root, left, inspector, stage, layer, art, banner, version, pill, palette };
    this.restoreRailWidths();

    this.viewport = new Viewport(stage, layer, {
      canPan: (ev) => !(ev.target as Element)?.closest?.("[data-id]"),
      onTap: (x, y) => {
        const page = this.page();
        if (!page || this.view.mode !== "edit") return;
        this.select(hitTest(page, x, y) ? [hitTest(page, x, y)] : []);
      },
    });

    stage.addEventListener("pointerdown", (ev) => this.onStageDown(ev as PointerEvent), true);
    window.addEventListener("pointermove", (ev) => this.onStageMove(ev as PointerEvent));
    window.addEventListener("pointerup", (ev) => this.onStageUp(ev as PointerEvent));
    window.addEventListener("keydown", (ev) => this.onKey(ev));
  }

  private gutter(side: "left" | "right"): HTMLElement {
    const node = el("div", { class: "gutter", "data-side": side });
    node.addEventListener("pointerdown", (ev) => {
      const start = (ev as PointerEvent).clientX;
      const rail = side === "left" ? this.nodes.left : this.nodes.inspector;
      const from = rail.getBoundingClientRect().width;
      const move = (m: PointerEvent) => {
        const delta = side === "left" ? m.clientX - start : start - m.clientX;
        const width = Math.max(RAIL_MIN, Math.min(RAIL_MAX, from + delta));
        document.documentElement.style.setProperty("--rail-" + side, width + "px");
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        localStorage.setItem(
          "rail-" + side,
          document.documentElement.style.getPropertyValue("--rail-" + side),
        );
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      ev.preventDefault();
    });
    return node;
  }

  private restoreRailWidths(): void {
    for (const side of ["left", "right"]) {
      const saved = localStorage.getItem("rail-" + side);
      if (saved) document.documentElement.style.setProperty("--rail-" + side, saved);
    }
  }

  private setMode(mode: Mode): void {
    this.view.mode = mode;
    this.root.setAttribute("data-mode", mode);
    for (const button of Array.from(this.root.querySelectorAll(".mode")))
      button.classList.toggle("on", (button as HTMLElement).dataset.mode === mode);
    /* an operator surface stays still; editing wants pan and zoom everywhere */
    if (this.viewport) this.viewport.setLocked(mode === "operate" && window.innerWidth > 900);
    this.renderAll();
  }

  /* ---- direct manipulation: move and resize a widget, one op on release ---- */

  private onStageDown(ev: PointerEvent): void {
    if (this.view.mode !== "edit" || ev.button !== 0) return;
    const target = (ev.target as Element)?.closest?.("[data-id]") as HTMLElement | null;
    if (!target) return;
    const id = Number(target.dataset.id);
    const widget = this.store.widget(id);
    if (!widget) return;
    this.select([id]);
    const at = this.viewport!.toArtboard(ev.clientX, ev.clientY);
    this.drag = {
      id,
      mode: target.dataset.handle ? "resize" : "move",
      x0: at.x,
      y0: at.y,
      geom: { ...widget.geom },
      moved: false,
    };
    ev.stopPropagation();
    ev.preventDefault();
  }

  private onStageMove(ev: PointerEvent): void {
    if (!this.drag) return;
    const widget = this.store.widget(this.drag.id);
    if (!widget) return;
    const at = this.viewport!.toArtboard(ev.clientX, ev.clientY);
    const dx = at.x - this.drag.x0;
    const dy = at.y - this.drag.y0;
    if (!this.drag.moved && Math.hypot(dx, dy) < 3) return;
    this.drag.moved = true;
    const g = this.drag.geom;
    /* the local doc carries the preview; the op on release is what makes it true */
    if (this.drag.mode === "move") {
      widget.geom = { ...g, x: g.x + dx, y: g.y + dy };
    } else {
      widget.geom = { ...g, w: Math.max(20, g.w + dx), h: Math.max(20, g.h + dy) };
    }
    this.renderCanvas();
  }

  private onStageUp(ev: PointerEvent): void {
    if (!this.drag) return;
    const drag = this.drag;
    this.drag = null;
    const widget = this.store.widget(drag.id);
    if (!widget || !drag.moved) return;
    const cell = this.store.doc ? this.store.doc.canvas.unit_w / this.store.doc.canvas.cols : 30;
    const snap = (v: number) => (ev.altKey ? Math.round(v) : Math.round(v / cell) * cell);
    const geom = {
      x: snap(widget.geom.x),
      y: snap(widget.geom.y),
      w: Math.max(cell, snap(widget.geom.w)),
      h: Math.max(cell, snap(widget.geom.h)),
    };
    widget.geom = geom;
    this.renderCanvas();
    this.apply([{ op: "set_prop", node: drag.id, key: "geom", value: geom }]);
  }

  private onKey(ev: KeyboardEvent): void {
    const typing = (ev.target as HTMLElement)?.matches?.("input, select, textarea");
    if (typing || this.view.mode !== "edit") return;
    if (ev.key === "Delete" || ev.key === "Backspace") {
      this.removeSelection();
      ev.preventDefault();
    }
    if (ev.key === "Escape") this.select([]);
  }

  /* ---- palette actions ---- */

  private buildPalette(): void {
    const palette = this.nodes.palette;
    clear(palette);
    const names = (this.registry?.types ?? []).map((t) => t.name);
    if (!names.length) return;
    let choice = names[0];
    palette.appendChild(select(names, choice, (name) => (choice = name)));
    palette.appendChild(
      el("button", { class: "btn primary", text: "+ widget", onclick: () => this.addWidget(choice) }),
    );
    palette.appendChild(
      el("button", { class: "btn", text: "duplicate", onclick: () => this.duplicate() }),
    );
    palette.appendChild(
      el("button", { class: "btn", text: "delete", onclick: () => this.removeSelection() }),
    );
  }

  private addWidget(type: string): void {
    const page = this.page();
    const doc = this.store.doc;
    if (!page || !doc) return;
    const cell = doc.canvas.unit_w / doc.canvas.cols;
    /* first free spot on the grid, scanning in reading order */
    const w = 6 * cell;
    const h = 3 * cell;
    let x = cell;
    let y = cell;
    const clash = (px: number, py: number) =>
      (page.widgets ?? []).some(
        (other) =>
          !(px + w <= other.geom.x || other.geom.x + other.geom.w <= px ||
            py + h <= other.geom.y || other.geom.y + other.geom.h <= py),
      );
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
    const widget = this.selectedWidget();
    const page = this.page();
    const doc = this.store.doc;
    if (!widget || !page || !doc) return;
    const cell = doc.canvas.unit_w / doc.canvas.cols;
    const copy = stripIds(JSON.parse(JSON.stringify(widget)));
    copy.geom = { ...widget.geom, x: widget.geom.x + cell, y: widget.geom.y + cell };
    this.apply([{ op: "insert", parent: page.id, list: "widgets", node: copy }]);
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
