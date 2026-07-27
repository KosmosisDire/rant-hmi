/* The application shell: three columns, the mode switch, and the wiring between the
 * connection, the document mirror and the rails. The shell holds only view state
 * (selection, hover, mode, rail widths); every edit leaves as an op and comes back as a
 * broadcast, so two windows are always looking at the same document.
 *
 * Direct manipulation follows the old designer: click selects, shift-click extends, drag
 * moves the whole selection, the grips resize its bbox, and a dashed ghost shows where it
 * will land. The document is only touched on release, by one op. */

import { bboxOf, cellSize, hitTest, renderContent, renderOverlay, ViewState } from "./canvas.js";
import { DocStore } from "./doc.js";
import { clear, el, nodeAt, pathOf, svg } from "./dom.js";
import { Editor, refreshLive } from "./editor.js";
import { iconMarkup } from "./icons.js";
import { closeMenu, openMenu } from "./menu.js";
import { renderInspector, renderLeftRail } from "./inspector/panel.js";
import { Connection, Status } from "./protocol.js";
import { run } from "./program.js";
import { cellsFor, fedSlots, resolveSlot, typeOf } from "./slots.js";
import { Rect } from "./template.js";
import { Doc, Interact, Json, Live, Op, Page, Registry, Widget, WidgetType } from "./types.js";
import { Viewport } from "./viewport.js";

type Mode = "edit" | "run" | "operate";

const RAIL_MIN = 200;
const RAIL_MAX = 640;
const MIN_SIZE = 20;

export class App implements Editor {
  store = new DocStore();
  registry: Registry | null = null;
  live: Live | null = null;
  view: ViewState = { mode: "edit", selection: [], hover: 0, scale: 1, ghost: null, state: {} };

  private conn: Connection;
  private viewport: Viewport | null = null;
  private pageId = 0;
  private nodes!: {
    left: HTMLElement;
    inspector: HTMLElement;
    stage: HTMLElement;
    layer: HTMLElement;
    art: SVGSVGElement;
    overlay: SVGSVGElement;
    banner: HTMLElement;
    version: HTMLElement;
    pill: HTMLElement;
    palette: HTMLElement;
  };
  private drag: Json = null;
  private control: Json = null;
  private inputSequence = 0;
  private frame = 0;
  private contentDirty = true;
  private lastContent = "";
  private lastOverlay = "";

  constructor(private root: HTMLElement, url: string) {
    this.build();
    this.conn = new Connection(url, {
      snapshot: (doc, registry, live) => this.onSnapshot(doc, registry, live),
      ops: (version, ops) => this.onOps(version, ops),
      live: (live) => {
        this.live = live;
        this.queueCanvas(true);
        refreshLive(this.nodes.left, live);
        refreshLive(this.nodes.inspector, live);
      },
      diag: () => undefined,
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
    this.conn.view(id, true);
    this.renderAll();
  }

  select(ids: number[]): void {
    this.view.selection = ids;
    this.queueCanvas();
    this.renderRails();
  }

  /* the artboard and its editing overlay are separate layers: only the overlay depends on
     the view transform, so panning and zooming redraw a handful of shapes */
  private queueCanvas(content = false): void {
    this.contentDirty = this.contentDirty || content;
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.renderCanvas();
    });
  }

  refresh(): void {
    this.renderRails();
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
    this.queueCanvas(true);
    this.renderRails();
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
      const content = renderContent(doc, page, this.registry, this.live, this.view);
      if (content !== this.lastContent) {
        this.lastContent = content;
        this.nodes.art.setAttribute("viewBox", viewBox);
        this.nodes.art.innerHTML = content;
      }
    }
    const overlay = renderOverlay(page, this.view);
    if (overlay === this.lastOverlay) return;
    this.lastOverlay = overlay;
    this.nodes.overlay.setAttribute("viewBox", viewBox);
    this.nodes.overlay.innerHTML = overlay;
  }

  /* Both rails are rebuilt on every version, then the control the user was in is found
   * again and its caret restored. Text the user had typed but not committed outlives the
   * rebuild: the document has not seen it yet, so the fresh field would otherwise throw it
   * away (spec 4.2, until node-busy markers land). */
  private renderRails(): void {
    const keep = this.captureFocus();
    renderLeftRail(this.nodes.left, this);
    renderInspector(this.nodes.inspector, this);
    this.restoreFocus(keep);
  }

  private captureFocus(): Json {
    const node = document.activeElement as HTMLElement | null;
    const rail = node?.closest?.(".rail");
    if (!node || !rail) return null;
    const path = pathOf(rail, node);
    if (!path) return null;
    const field = node as HTMLInputElement;
    const text = field.type === "text" || field.type === "number";
    return {
      rail,
      path,
      tag: node.tagName,
      type: field.type ?? "",
      value: typeof field.value === "string" ? field.value : null,
      start: text ? field.selectionStart : null,
      end: text ? field.selectionEnd : null,
    };
  }

  private restoreFocus(keep: Json): void {
    if (!keep) return;
    const node = nodeAt(keep.rail, keep.path) as HTMLInputElement | null;
    if (!node || node.tagName !== keep.tag || (node.type ?? "") !== keep.type) return;
    node.focus();
    if (keep.value !== null && typeof node.value === "string" && node.value !== keep.value)
      node.value = keep.value;
    if (keep.start === null || !node.setSelectionRange) return;
    try {
      node.setSelectionRange(keep.start, keep.end);
    } catch {
      /* a number input refuses a selection range in some browsers; the focus is enough */
    }
  }

  /* ---- shell construction ---- */

  private build(): void {
    clear(this.root);
    const pill = el("span", { class: "pill connecting", text: "connecting" });
    const version = el("span", { class: "version", text: "v0" });
    const palette = el("div", { class: "tools" });
    const left = el("aside", { class: "rail left" });
    const inspector = el("aside", { class: "rail right" });
    const art = svg("svg", { class: "artboard", width: "100%", height: "100%" }) as SVGSVGElement;
    const overlay = svg("svg", { class: "artboard overlay", width: "100%", height: "100%" }) as SVGSVGElement;
    const layer = el("div", { class: "layer" }, [art as unknown as Node, overlay as unknown as Node]);
    const stage = el("section", { class: "stage" }, [layer]);
    const banner = el("div", { class: "banner" });

    const modes = el(
      "div",
      { class: "seg" },
      (["edit", "run", "operate"] as Mode[]).map((mode) =>
        el("button", {
          class: mode === this.view.mode ? "on" : "",
          text: mode === "run" ? "debug" : mode,
          "data-mode": mode,
          onclick: () => this.setMode(mode),
        }),
      ),
    );

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
    this.root.appendChild(
      el("main", { class: "workspace" }, [
        left,
        this.gutter("left"),
        stage,
        this.gutter("right"),
        inspector,
      ]),
    );
    this.root.appendChild(banner);

    this.nodes = { left, inspector, stage, layer, art, overlay, banner, version, pill, palette };
    this.restoreRailWidths();

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
    this.view.ghost = null;
    this.root.setAttribute("data-mode", mode);
    for (const button of Array.from(this.root.querySelectorAll(".seg button[data-mode]")))
      button.classList.toggle("on", (button as HTMLElement).dataset.mode === mode);
    /* an operator surface stays still; editing wants pan and zoom everywhere */
    this.viewport?.setLocked(mode === "operate" && window.innerWidth > 900);
    this.renderAll();
  }

  /* ---- selection and direct manipulation ---- */

  private grabbable(ev: PointerEvent): boolean {
    const target = ev.target as Element | null;
    if (this.view.mode !== "edit") return Boolean(target?.closest?.("[data-id]"));
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
    if (!handle && widgetNode) {
      const id = Number(widgetNode.dataset.id);
      if (selection.indexOf(id) < 0) {
        this.clickSelect(id, ev.shiftKey);
        selection = this.view.selection.slice();
      }
    }
    const widgets = selection
      .map((id) => this.store.widget(id))
      .filter(Boolean) as Widget[];
    if (!widgets.length) return;

    const at = this.viewport.toArtboard(ev.clientX, ev.clientY);
    this.drag = {
      mode: handle?.dataset.handle ?? "move",
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

  private interaction(type: WidgetType | null): Interact | null {
    const walk = (node: Json): Interact | null => {
      if (!node) return null;
      if (node.interact) return node.interact as Interact;
      for (const child of node.children ?? []) {
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    return type ? walk(type.template) : null;
  }

  private controlCells(widget: Widget, type: WidgetType): (cell: string) => Json {
    return cellsFor(widget, type, this.live, this.view.state[widget.id] ?? {});
  }

  private eventValue(widget: Widget, type: WidgetType, event: string, down: boolean): Json {
    const shape = type.events.find((row) => row.name === event)?.x ?? "bool";
    const fed = fedSlots(widget);
    const value = resolveSlot(widget, type, this.live, fed, "value");
    if (shape === "num") return typeof value === "number" ? value : null;
    if (shape === "text" || shape === "enum") return typeof value === "string" ? value : null;
    if (shape === "bool") return down;
    return down;
  }

  private emitInput(widget: Widget, event: string | undefined, value: Json): void {
    if (!event) return;
    this.conn.input(widget.id, event, value, ++this.inputSequence);
  }

  private onControlDown(ev: PointerEvent): void {
    if (ev.button !== 0 || !this.viewport) return;
    const page = this.page();
    if (!page) return;
    const at = this.viewport.toArtboard(ev.clientX, ev.clientY);
    const widget = this.store.widget(hitTest(page, at.x, at.y));
    if (!widget) return;
    const type = typeOf(this.registry, widget.type);
    const interact = this.interaction(type);
    if (!type || !interact) return;
    const fed = fedSlots(widget);
    if (resolveSlot(widget, type, this.live, fed, "enabled") !== true) return;
    this.control = {
      pointer: ev.pointerId,
      widget,
      type,
      interact,
      started: performance.now(),
    };
    this.view.state[widget.id] = {
      ...(this.view.state[widget.id] ?? {}),
      pressed: interact.primitive === "press",
      dragging: interact.primitive === "drag1d",
      open: interact.primitive === "pick",
    };
    if (interact.primitive === "press")
      this.emitInput(widget, interact.emits.press,
        this.eventValue(widget, type, interact.emits.press, true));
    else if (interact.primitive === "pick")
      this.emitInput(widget, interact.emits.open,
        this.eventValue(widget, type, interact.emits.open, true));
    this.queueCanvas(true);
    ev.preventDefault();
    ev.stopPropagation();
  }

  private onControlMove(ev: PointerEvent): void {
    const control = this.control;
    if (!control || control.pointer !== ev.pointerId || !this.viewport) return;
    if (control.interact.primitive !== "drag1d") return;
    const widget = control.widget as Widget;
    const type = control.type as WidgetType;
    const at = this.viewport.toArtboard(ev.clientX, ev.clientY);
    const cells = this.controlCells(widget, type);
    const axis = String(run(control.interact.params.axis, cells) ?? "x");
    const lo = Number(run(control.interact.params.min, cells) ?? 0);
    const hi = Number(run(control.interact.params.max, cells) ?? 1);
    const step = Math.max(0, Number(run(control.interact.params.step, cells) ?? 0));
    const fraction = axis === "y"
      ? 1 - (at.y - widget.geom.y) / widget.geom.h
      : (at.x - widget.geom.x) / widget.geom.w;
    let value = lo + Math.max(0, Math.min(1, fraction)) * (hi - lo);
    if (step > 0) value = lo + Math.round((value - lo) / step) * step;
    control.value = value;
    this.emitInput(widget, control.interact.emits.input, value);
    ev.preventDefault();
  }

  private onControlUp(ev: PointerEvent, cancelled: boolean): void {
    const control = this.control;
    if (!control || (ev.pointerId !== undefined && control.pointer !== ev.pointerId)) return;
    this.control = null;
    const widget = control.widget as Widget;
    const type = control.type as WidgetType;
    const interact = control.interact as Interact;
    const state = this.view.state[widget.id] ?? {};
    state.pressed = state.dragging = state.open = false;
    if (interact.primitive === "press") {
      this.emitInput(widget, interact.emits.release,
        this.eventValue(widget, type, interact.emits.release, false));
      const hold = Number(run(interact.params.hold_ms, this.controlCells(widget, type)) ?? 600);
      if (!cancelled && performance.now() - control.started < hold)
        this.emitInput(widget, interact.emits.tap,
          this.eventValue(widget, type, interact.emits.tap, true));
    } else if (interact.primitive === "drag1d") {
      if (!cancelled && control.value !== undefined)
        this.emitInput(widget, interact.emits.commit, control.value);
    } else if (interact.primitive === "pick" && !cancelled) {
      const options = run(interact.params.options, this.controlCells(widget, type));
      if (Array.isArray(options) && options.length) {
        const current = this.eventValue(widget, type, interact.emits.select, true);
        const at = Math.max(-1, options.indexOf(current));
        this.emitInput(widget, interact.emits.select, options[(at + 1) % options.length]);
      }
    }
    this.queueCanvas(true);
  }

  private cancelControl(): void {
    if (!this.control) return;
    this.onControlUp({ pointerId: this.control.pointer } as PointerEvent, true);
  }

  /* Where the selection bbox lands: snapped to the cell grid unless Alt frees it. The drag
   * is passed in, never read from the field: the release path clears the field first. */
  private targetBox(drag: Json, dx: number, dy: number, free: boolean): Rect {
    const doc = this.store.doc;
    const cell = doc ? cellSize(doc.canvas) : 30;
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
      this.select([]);
    }
    if (this.view.mode !== "edit") return;
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

  private buildPalette(): void {
    const palette = this.nodes.palette;
    clear(palette);
    const names = (this.registry?.types ?? []).map((t) => t.name);
    if (!names.length) return;
    palette.appendChild(
      el("button", {
        class: "btn primary",
        html: iconMarkup("plus", 11, 2) + "<span>widget</span>",
        onclick: (ev: MouseEvent) =>
          openMenu(
            ev.clientX,
            ev.clientY + 8,
            "Add widget",
            names.map((name) => ({
              label: name,
              icon: name,
              run: () => this.addWidget(name),
            })),
          ),
      }),
    );
    palette.appendChild(
      el("button", {
        class: "btn",
        html: iconMarkup("copy", 11, 1.6) + "<span>duplicate</span>",
        onclick: () => this.duplicate(),
      }),
    );
    palette.appendChild(
      el("button", {
        class: "btn",
        html: iconMarkup("trash", 11, 1.6) + "<span>delete</span>",
        onclick: () => this.removeSelection(),
      }),
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
