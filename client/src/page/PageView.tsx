// A page drawn as HTML: each element an absolutely placed div, its properties resolved
// live. The Design and Run tabs both draw with this, so what is edited is what runs.

import { createEffect, createMemo, createRoot, createSignal, For, Index, Match, onCleanup, Show, Switch } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { Dynamic } from "solid-js/web";
import type { Element } from "../protocol/Element";
import type { Page } from "../protocol/Page";
import type { Value } from "../protocol/Value";
import { type At, bareRef, componentScope, docScope, type Flow, flowOf, type Kept, originAt, originCss, pageScope, percentOf, placement, repeatScope, resolve, type Scope, sizeWord, tokenValue, UNIT } from "../state/bind";
import { fields, short } from "../state/format";
import { play, type Playing, stopPlaying, unplayable } from "../net/connection";
import { component, entity, live, notify, state } from "../state/store";
import { createSize } from "../ui/size";
import { ImagePlay, VideoOff } from "../ui/icons";
import { FIT, picture, PictureView } from "../ui/Picture";
import { follow } from "../ui/press";
import { componentAct, type Act } from "./act";
import { svgOf } from "./markup";
import { POINTER, TIMED } from "../state/events";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What a group holds, through the groups inside it, or the element itself: what has a place. */
export function leaves(e: Element): Element[] {
  return e.tag === "group" ? e.children.flatMap(leaves) : [e];
}

/** The box around `boxes`, an empty one at the corner for none. */
export function union(boxes: Box[]): Box {
  if (boxes.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const [x, y] = [Math.min(...boxes.map((b) => b.x)), Math.min(...boxes.map((b) => b.y))];
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
}

/** The scale that fits a `w` by `h` box whole in `room`, at most `most`, where it then sits
 *  centred, and the transform that puts it there. */
export function fitIn(w: number, h: number, room: { w: number; h: number }, most = Infinity) {
  const k = Math.min(most, room.w / w, room.h / h);
  const [x, y] = [(room.w - w * k) / 2, (room.h - h * k) / 2];
  return { k, x, y, transform: `translate(${x}px, ${y}px) scale(${k})` };
}

/** A box the editor shows in place of an element's own while a drag lands. */
export type Overrides = (id: string) => Box | undefined;

/** What holds an element: the origin its x and y count from, as CSS lengths, and the frame's
 *  flow when it lays out what it holds, which then waits on no x or y. */
export interface Holder {
  ox: string;
  oy: string;
  flow?: Flow;
  /** With the first part on top, the z-index it takes, each after it one less. */
  first?: number;
}

/** The page's corner, where its own elements count from. */
const CORNER: Holder = { ox: "0px", oy: "0px" };

/** Ours, never CSS: the rest of an element's properties are CSS. */
export const OWN = new Set(["name", "repeat", "x", "y", "w", "h", "origin", "layout", "wrap", "align", "stack", "text", "value", "viewbox", "src", "fit", "markup"]);

/** What a diagram holds: SVG shapes, whose every property but the name is an attribute. */
export const SHAPES = new Set(["path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "text", "g"]);

/** Attributes SVG spells with a capital, which the file writes in small letters. */
const CASED: Record<string, string> = { pathlength: "pathLength", textlength: "textLength", gradienttransform: "gradientTransform" };

/** How a diagram's view box fits its box: whole, filling it, or stretched to it, as a
 *  picture's fit does, so an overlay lines up with its picture. */
const FITS: Record<string, string> = { meet: "xMidYMid meet", slice: "xMidYMid slice", stretch: "none" };

/** A diagram's view box as x, y, width and height, or null when what it gives is not one. */
export function viewBox(v: unknown): [number, number, number, number] | null {
  const n = String(v ?? "").trim().split(/[\s,]+/).map(Number);
  return n.length === 4 && n.every(Number.isFinite) && n[2] > 0 && n[3] > 0 ? (n as [number, number, number, number]) : null;
}

/** At most this many copies of a repeat, so a mistaken one never floods the page. */
const COPIES = 500;

/** The events a press on the element itself starts, which make it look pressable. */
const PRESSES = POINTER.filter((e) => e !== "outside");

/** The instance pressed last, drawn above the others so what it opens is never hidden. */
const [raised, setRaised] = createSignal<Element | null>(null);

/** How often a repeat may run at the most, in ms, as the HMI's own timers. */
const QUICKEST = 50;

/** CSS lengths that read a bare number in units. */
const SIDES = ["top", "right", "bottom", "left"];
const LENGTHS = new Set([
  ...["font-size", "border-radius", "border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius"],
  ...["border-width", "padding", "margin", "gap", "row-gap", "column-gap", "letter-spacing", "outline-width", "outline-offset"],
  ...SIDES.flatMap((s) => [`padding-${s}`, `margin-${s}`, `border-${s}-width`]),
  ...["min-width", "max-width", "min-height", "max-height"],
]);

/** A page's ground from its fill, the theme's `$ground` when it has none. None for a component,
 *  or a project without that token, which take the default. */
export function pageGround(page: Page): string | undefined {
  if (page.interface) return undefined;
  const r = resolve(page.fill || "$ground", pageScope);
  return r.ok && r.value !== undefined && r.value !== null && r.value !== "" ? String(r.value) : undefined;
}

/** Every theme token as a CSS variable, `--t-text`, so what a page draws by default follows
 *  the theme. A number is a length in units. */
const themeVars = createRoot(() =>
  createMemo(() => {
    const vars: Record<string, string> = {};
    for (const t of state.tokens) {
      try {
        const v = tokenValue(t);
        if (typeof v === "number") vars[`--t-${t.name}`] = `${v * UNIT}px`;
        else if (typeof v === "string") vars[`--t-${t.name}`] = v;
      } catch {
        // one that cannot be worked out leaves the page's own default, and the theme says why
      }
    }
    return vars;
  }),
);

/** The space between blocks a narrow screen stacks, in units. */
const GAP = 2;

/** A page as a narrow screen shows it: its top level elements one under another in reading
 *  order, rows by how far down they start, left to right within a row. */
function stacked(page: Page): { width: number; height: number; at: Overrides } {
  // a box from its top left, as x and y place its origin
  const box = (e: Element): Box => {
    if (e.tag === "group") return union(e.children.map(box));
    const at = (k: keyof Box) => placement(e.props[k], k === "x" || k === "w" ? page.width : page.height);
    const [w, h] = [at("w"), at("h")];
    const r = e.props.origin === undefined ? undefined : resolve(e.props.origin, pageScope);
    const own = originAt(r?.ok ? r.value : undefined, w, h);
    return { x: at("x") - own.x, y: at("y") - own.y, w, h };
  };
  const boxes = page.children.map((e) => ({ e, b: box(e) }));
  boxes.sort((p, q) => p.b.y - q.b.y);
  const order: typeof boxes = [];
  for (let i = 0; i < boxes.length; ) {
    // a row holds each block that starts before the first one in it ends
    let j = i + 1;
    while (j < boxes.length && boxes[j].b.y < boxes[i].b.y + boxes[i].b.h) j++;
    order.push(...boxes.slice(i, j).sort((p, q) => p.b.x - q.b.x));
    i = j;
  }
  const places = new Map<string, Box>();
  let y = GAP;
  for (const { e, b } of order) {
    // what a group holds keeps its places within the group's box
    for (const l of leaves(e)) {
      const lb = box(l);
      places.set(l.id, { ...lb, x: GAP + lb.x - b.x, y: y + lb.y - b.y });
    }
    y += b.h + GAP;
  }
  return { width: Math.max(1, ...order.map(({ b }) => b.w)) + 2 * GAP, height: y, at: (id) => places.get(id) };
}

/** Whether a screen held upright stacks this page when it shows it first: one wider than tall. */
export const stacks = (page: Page) => page.width > page.height;

/** A page stacked to fill an upright screen's width at one zoom, `k`. Its ground reaches the
 *  screen's foot even when its blocks end above it. */
export function stackedIn(page: Page, screen: { w: number; h: number }) {
  const stack = stacked(page);
  const k = screen.w / (stack.width * UNIT);
  return { ...stack, k, height: Math.max(stack.height, Math.floor(screen.h / k / UNIT)) };
}

/** A page, or a component drawn on its own with its inputs' defaults. `size` stands in for
 *  the page's own, as when a narrow screen stacks it. */
export function PageView(p: { page: Page; overrides?: Overrides; size?: { width: number; height: number }; design?: boolean; act?: Act }) {
  const scope = createMemo(() => docScope(p.page));
  const size = () => p.size ?? p.page;
  return (
    <div class="page" classList={{ design: p.design }} style={{ ...themeVars(), width: `${size().width * UNIT}px`, height: `${size().height * UNIT}px`, "--page-ground": pageGround(p.page) }}>
      <For each={p.page.children}>{(e) => <Placed element={e} scope={scope()} room={CORNER} overrides={p.overrides} design={p.design} act={p.act} />}</For>
    </div>
  );
}

function css(key: string, v: unknown): string {
  const text = String(v);
  if (/^-?\d+(\.\d+)?$/.test(text)) return LENGTHS.has(key) ? `${Number(text) * UNIT}px` : key === "rotate" ? `${text}deg` : text;
  // CSS text whose bare numbers the browser refuses reads them in units, as a token's are
  if (CSS.supports(key, text)) return text;
  const units = text.replace(/(^|[\s(,])(-?\d*\.?\d+)(?=$|[\s),])/g, (_, before: string, n: string) => `${before}${Number(n) * UNIT}px`);
  return units !== text && CSS.supports(key, units) ? units : text;
}

/** Why the browser would drop a CSS value, as for a misspelt property or a colour it cannot
 *  read, or nothing when it takes it. */
export function cssFault(key: string, v: unknown): string | undefined {
  const text = css(key, v);
  return CSS.supports(key, text) ? undefined : `${text} is not a ${key} the browser takes`;
}

/** How a shape turns, as CSS: about its origin, a point of its own box, never the diagram's
 *  corner. SVG's own rotate attribute turns a text's letters instead. */
const TURNS: Record<string, string> = { rotate: "rotate", origin: "transform-origin" };

function words(v: unknown): string {
  if (v === undefined || v === null) return "";
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : short(v as Value);
}

interface ElementProps {
  element: Element;
  scope: Scope;
  room: Holder;
  /** Where it sits among what its frame holds. */
  order?: number;
  overrides?: Overrides;
  design?: boolean;
  act?: Act;
  inside?: boolean;
}

/** An element, or a copy of it per item when it repeats: a list, or a number of times. In
 *  the editor a repeat with nothing to show still draws one copy, so there is one to pick. */
function Placed(p: ElementProps) {
  const copies = createMemo(() => {
    const r = p.element.props.repeat;
    if (!r?.trim()) return null;
    const got = resolve(r, p.scope);
    const v = got.ok ? got.value : undefined;
    const items = typeof v === "number" ? Array.from({ length: Math.max(0, Math.min(COPIES, Math.floor(v))) }, (_, i) => i) : Array.isArray(v) ? v.slice(0, COPIES) : [];
    return items.length === 0 && p.design ? [undefined] : items;
  });
  return (
    <Show when={copies()} fallback={<ElementView {...p} />}>
      {(items) => (
        <Index each={items()}>
          {(item, index) => (
            <ElementView
              {...p}
              scope={repeatScope(p.scope, index, item)}
              at={{
                index,
                get item() {
                  return item();
                },
              }}
            />
          )}
        </Index>
      )}
    </Show>
  );
}

/** What pressing an element does: it shows pressed at once and sends press, drag, hold,
 *  release and tap. The release is heard on the window, so letting go anywhere ends a press,
 *  and a tap needs the release over the element. Where a press lands is read as it goes down
 *  the page, before any handler changes the page as it comes back up: Firefox before 125
 *  drops the rest of a touch when its pressed shape restyles and is measured in pointerdown. */
function usePress(p: ElementProps & { at?: At }) {
  const [pressed, setPressed] = createSignal(false);
  const live = () => !!p.act && p.element.handlers.some((h) => PRESSES.includes(h.event));
  const fire = (event: string, payload: Pointer) => p.act?.fire(p.element, event, payload, p.at);
  // a hold's or a repeat's time, an expression read where the element sits
  const msOf = (event: string) => {
    const h = p.element.handlers.find((x) => x.event === event);
    if (!h) return undefined;
    const r = resolve(h.ms || String(TIMED[event].ms), p.scope);
    const n = r.ok ? Number(r.value) : NaN;
    return Number.isFinite(n) ? n : TIMED[event].ms;
  };
  let self: globalThis.Element | undefined;
  let landed: { e: PointerEvent; at: Pointer } | undefined;
  const read = (e: PointerEvent) => {
    if (!self || !live() || e.button !== 0) return;
    const on = (e.target as globalThis.Element).closest<HTMLElement | SVGElement>(".el[data-name]")?.dataset.name ?? null;
    landed = { e, at: pointer(self, e, on) };
  };
  const down = (e: PointerEvent & { currentTarget: Element | globalThis.Element }) => {
    if (!live() || e.button !== 0 || pressed() || landed?.e !== e) return;
    const el = e.currentTarget as globalThis.Element;
    const at = landed.at;
    const on = at.on;
    landed = undefined;
    setPressed(true);
    fire("press", { ...at });
    fire("drag", { ...at });
    let last: PointerEvent = e;
    const ms = msOf("hold");
    const held = ms === undefined ? undefined : setTimeout(() => fire("hold", pointer(el, last, on)), ms);
    // a repeat runs at once, then on each beat until the press ends
    const every = msOf("repeat");
    if (every !== undefined) fire("repeat", { ...at });
    const beat = every === undefined ? undefined : setInterval(() => fire("repeat", pointer(el, last, on)), Math.max(every, QUICKEST));
    // a drag goes out at most once a frame, with the latest place
    let next: PointerEvent | null = null;
    const move = (m: PointerEvent) => {
      last = m;
      if (!next) {
        requestAnimationFrame(() => {
          if (next) fire("drag", pointer(el, next, on));
          next = null;
        });
      }
      next = m;
    };
    // a release missed ends the press where the pointer was last, and taps nothing
    const end = (u?: PointerEvent) => {
      next = null;
      clearTimeout(held);
      clearInterval(beat);
      setPressed(false);
      const at = pointer(el, u ?? last, on);
      fire("release", at);
      if (u?.type === "pointerup" && at.inside) fire("tap", at);
    };
    follow(e, { move, end });
  };
  // a press anywhere else is this element's outside, as closes what it opened, while its page
  // shows: the editor keeps its run hidden behind the other tabs, and a run its covered pages
  createEffect(() => {
    if (!p.act || !p.element.handlers.some((h) => h.event === "outside")) return;
    let away: { e: PointerEvent; at: Pointer } | undefined;
    const readAway = (e: PointerEvent) => {
      if (self && !self.contains(e.target as Node) && !self.closest("[hidden]")) away = { e, at: pointer(self, e, null) };
    };
    const actAway = (e: PointerEvent) => {
      if (away?.e === e) fire("outside", away.at);
      away = undefined;
    };
    window.addEventListener("pointerdown", readAway, true);
    window.addEventListener("pointerdown", actAway);
    onCleanup(() => {
      window.removeEventListener("pointerdown", readAway, true);
      window.removeEventListener("pointerdown", actAway);
    });
  });
  const ref = (el: globalThis.Element) => {
    self = el;
    el.addEventListener("pointerdown", read as EventListener, true);
  };
  return { pressed, live, down, ref };
}

/** One element. `inside` marks one drawn as part of an instance: it is the component's, not
 *  the page's, so it carries no id to pick it by. `at` is the copy of a repeat it is. */
function ElementView(p: ElementProps & { at?: At }) {
  if (SHAPES.has(p.element.tag)) return <ShapeView {...p} />;
  if (p.element.tag === "group") return <GroupView {...p} />;
  const look = createMemo(() => {
    const style: Record<string, string> = {};
    const faults: string[] = [];
    let unknown = false;
    const take = (key: string, text = p.element.props[key]): unknown => {
      const r = resolve(text, p.scope);
      if (r.ok) return r.value;
      if (r.unknown) unknown = true;
      else faults.push(`${key}: ${r.error}`);
      return undefined;
    };
    // none written draws in the page's units, and one not worked out yet draws nothing, null
    const diagramBox = () => {
      if (p.element.props.viewbox === undefined) return undefined;
      const given = take("viewbox");
      const box = viewBox(given);
      if (given !== undefined && box === null) faults.push(`viewbox: ${words(given)} is not x, y, width and height`);
      return box && box.join(" ");
    };
    // a frame that lays out what it holds, its gap "auto" spreading them over its length
    const flow = p.element.tag === "div" ? flowOf(take("layout")) : undefined;
    const spread = !!flow && take("gap") === "auto";
    // an instance's inputs are never CSS, the rest is CSS on its box, as without its component
    // all are inputs. Design draws no motion, so a drag and the outlines follow the pointer.
    const made = p.element.tag === "use" ? component(p.element.component ?? "") : undefined;
    const input = (key: string) => p.element.tag === "use" && (!made || !!made.interface?.inputs.some((i) => i.name === key));
    for (const key of Object.keys(p.element.props)) {
      if (OWN.has(key) || input(key) || (key === "gap" && spread)) continue;
      if (key === "transition" && p.design) continue;
      const v = take(key);
      if (v === undefined || v === null || v === "") continue;
      const bad = cssFault(key, v);
      if (bad) faults.push(bad);
      else style[key] = css(key, v);
    }
    // placed in CSS, so a size only the page knows, as a hug's or a fill's, still places it
    const length = (k: keyof Box) => {
      const { expr, percent } = percentOf(p.element.props[k]);
      const n = Number(take(k, expr) ?? 0);
      return !Number.isFinite(n) ? "0px" : percent ? `${n}%` : `${n * UNIT}px`;
    };
    const word = (k: "w" | "h") => sizeWord(p.element.props[k]);
    // a hugging instance takes its component's own size
    const size = (k: "w" | "h") => {
      if (word(k) === "fill") return "100%";
      if (word(k) === "hug") return made ? `${(k === "w" ? made.width : made.height) * UNIT}px` : undefined;
      return length(k);
    };
    const origin = take("origin");
    const [ox, oy] = originCss(origin) ?? ["0px", "0px"];
    const o = p.overrides?.(p.element.id);
    // its frame lays it out unless it is placed freely, out of the flow as CSS takes it
    if (p.room.flow && take("position") !== "absolute") {
      // x and y wait, and a fill takes the room left along the flow
      style.position = "relative";
      const along = p.room.flow === "right" || p.room.flow === "left" ? "w" : "h";
      for (const k of ["w", "h"] as const) {
        const side = k === "w" ? "width" : "height";
        // a size a grip holds is a number until the page carries it
        // a fill may shrink to nothing, or to the least its own min allows
        if (word(k) === "fill" && k === along && !o) Object.assign(style, { flex: "1 1 0", [`min-${side}`]: style[`min-${side}`] ?? "0" });
        else if (word(k) === "fill" && !o) style["align-self"] = "stretch";
        else {
          const s = o ? `${(k === "w" ? o.w : o.h) * UNIT}px` : size(k);
          if (s) style[side] = s;
          if (k === along) style["flex-shrink"] = "0";
        }
      }
    } else if (o) {
      Object.assign(style, { left: `${o.x * UNIT}px`, top: `${o.y * UNIT}px`, width: `${o.w * UNIT}px`, height: `${o.h * UNIT}px` });
    } else {
      // x and y place its origin, counted from the origin of what holds it
      const from = (o: string, k: "x" | "y") => (o === "0px" ? length(k) : `calc(${o} + ${length(k)})`);
      style.left = from(p.room.ox, "x");
      style.top = from(p.room.oy, "y");
      const back = originCss(origin, -1);
      if (back) style.translate = back.join(" ");
      for (const k of ["w", "h"] as const) {
        const s = size(k);
        if (s) style[k === "w" ? "width" : "height"] = s;
      }
    }
    // it turns about its origin
    style["transform-origin"] = `${ox} ${oy}`;
    // where parts overlap, the first on top when its frame says so, a repeat's copies in turn
    if (p.room.first !== undefined && p.order !== undefined) style["z-index"] = String(p.room.first - p.order * COPIES - (p.at?.index ?? 0));
    if (flow) Object.assign(style, layoutCss(flow, take("wrap") === true, take("align"), spread));
    const text = p.element.tag === "span" ? words(take("text")) : "";
    const value = p.element.tag === "input" ? take("value") : undefined;
    const diagram = p.element.tag === "svg" ? { box: diagramBox(), fit: take("fit") } : undefined;
    const markup = p.element.tag === "markup" ? svgFrom(take("markup"), faults) : undefined;
    const media = p.element.tag === "media" ? { alias: playable(p.element.props.src, () => take("src")), src: take("src"), fit: String(take("fit") ?? "meet") } : undefined;
    const first = p.element.tag === "div" && take("stack") === "first" ? p.element.children.length * COPIES : undefined;
    return { style, unknown, faults, text, value, diagram, markup, media, holder: { ox, oy, flow, first } as Holder };
  });
  const press = usePress(p);
  const inner = (c: Element, i: () => number) => <Placed element={c} scope={p.scope} room={look().holder} order={i()} overrides={p.overrides} design={p.design} act={p.act} inside={p.inside} />;
  return (
    <div
      data-id={p.inside ? undefined : p.element.id}
      data-name={p.element.props.name}
      class="el"
      classList={{ text: p.element.tag === "span", unknown: look().unknown, faulty: p.design && look().faults.length > 0, live: press.live(), pressed: press.pressed() }}
      style={{ ...look().style, "z-index": raised() === p.element ? String((p.room.first ?? 0) + 1) : look().style["z-index"] }}
      title={p.design && look().faults.length > 0 ? look().faults.join("\n") : undefined}
      ref={(el) => {
        press.ref(el);
        if (p.element.tag === "use") el.addEventListener("pointerdown", () => p.act && setRaised(p.element));
      }}
      onPointerDown={press.down}
    >
      <Switch fallback={look().text}>
        <Match when={p.element.tag === "div"}>
          <For each={p.element.children}>{inner}</For>
        </Match>
        <Match when={look().diagram}>
          {(d) => (
            // without a view box it draws in the page's units, from its box's corner inside any padding
            <svg class="diagram" viewBox={d().box ?? undefined} {...({ preserveAspectRatio: FITS[String(d().fit)] ?? FITS.meet } as Record<string, string>)}>
              <Show when={d().box !== null}>
                <Show
                  when={d().box}
                  fallback={
                    <g class="units" transform={`scale(${UNIT})`}>
                      <For each={p.element.children}>{inner}</For>
                    </g>
                  }
                >
                  <For each={p.element.children}>{inner}</For>
                </Show>
              </Show>
            </svg>
          )}
        </Match>
        <Match when={look().markup}>{(m) => <>{m()}</>}</Match>
        <Match when={look().media}>{(m) => <MediaView alias={m().alias} src={m().src} fit={m().fit} />}</Match>
        <Match when={p.element.tag === "use"}>
          <Instance element={p.element} scope={p.scope} design={p.design} act={p.act} />
        </Match>
        <Match when={p.element.tag === "input"}>
          <InputBox element={p.element} scope={p.scope} value={look().value} act={p.act} />
        </Match>
      </Switch>
    </div>
  );
}

/** A group: no box of its own, so what it holds sits in the room the group sits in. It still
 *  names a part a press or a hover is in. */
function GroupView(p: ElementProps) {
  return (
    <div data-id={p.inside ? undefined : p.element.id} data-name={p.element.props.name} class="el group">
      <For each={p.element.children}>{(c) => <Placed element={c} scope={p.scope} room={p.room} overrides={p.overrides} design={p.design} act={p.act} inside={p.inside} />}</For>
    </div>
  );
}

/** A layout frame as CSS: what it holds in a row or a column, wrapped or not, set at one of nine
 *  points such as "top left", or spread over its whole length. Its start is where the flow
 *  starts, so "left" stays left when it runs right to left. */
function layoutCss(flow: Flow, wrap: boolean, align: unknown, spread: boolean): Record<string, string> {
  const words = typeof align === "string" ? align.trim().split(/\s+/) : [];
  const middle = words.includes("center") ? "center" : undefined;
  const v = words.find((w) => w === "top" || w === "bottom") ?? middle ?? "top";
  const h = words.find((w) => w === "left" || w === "right") ?? middle ?? "left";
  const END: Record<string, string> = { top: "flex-start", left: "flex-start", center: "center", bottom: "flex-end", right: "flex-end" };
  const across = flow === "right" || flow === "left";
  const back = flow === "left" || flow === "up";
  const flip = (s: string) => (s === "flex-start" ? "flex-end" : s === "flex-end" ? "flex-start" : s);
  const main = END[across ? h : v];
  const cross = END[across ? v : h];
  return {
    display: "flex",
    "flex-direction": { right: "row", down: "column", left: "row-reverse", up: "column-reverse" }[flow],
    "flex-wrap": wrap ? "wrap" : "nowrap",
    "justify-content": spread ? "space-between" : back ? flip(main) : main,
    "align-items": cross,
    "align-content": cross,
  };
}

/** The SVG a markup element's code gives, as text or a list of it. Why it cannot be drawn
 *  joins `faults`. */
function svgFrom(code: unknown, faults: string[]): SVGSVGElement | undefined {
  if (code === undefined || code === null || code === "") return undefined;
  if (typeof code !== "string" && !Array.isArray(code)) {
    faults.push("markup: the code gives no SVG markup, which is text");
    return undefined;
  }
  const { svg, error } = svgOf(Array.isArray(code) ? code.join("") : code);
  if (error) faults.push(`markup: ${error}`);
  return svg;
}

/** A shape in a diagram: each property an SVG attribute, its value an expression. */
function ShapeView(p: ElementProps & { at?: At }) {
  const look = createMemo(() => {
    const attrs: Record<string, string> = {};
    const style: Record<string, string> = {};
    const faults: string[] = [];
    let unknown = false;
    let text = "";
    for (const [key, value] of Object.entries(p.element.props)) {
      if (key === "name" || key === "repeat") continue;
      const r = resolve(value, p.scope);
      if (!r.ok) {
        if (r.unknown) unknown = true;
        else faults.push(`${key}: ${r.error}`);
      } else if (key === "text") {
        text = words(r.value);
      } else if (r.value !== undefined && r.value !== null && r.value !== "") {
        if (key in TURNS) style[TURNS[key]] = css(key, r.value);
        else attrs[CASED[key] ?? key] = String(r.value);
      }
    }
    if (Object.keys(style).length > 0) Object.assign(style, { "transform-box": "fill-box", "transform-origin": style["transform-origin"] ?? "50% 50%" });
    return { attrs, style, faults, unknown, text };
  });
  const press = usePress(p);
  return (
    <Dynamic
      component={p.element.tag}
      {...look().attrs}
      style={look().style}
      data-id={p.inside ? undefined : p.element.id}
      data-name={p.element.props.name}
      class="el shape"
      classList={{ unknown: look().unknown, faulty: p.design && look().faults.length > 0, live: press.live(), pressed: press.pressed() }}
      ref={press.ref}
      onPointerDown={press.down}
    >
      <Show when={p.element.tag === "text"} fallback={<For each={p.element.children}>{(c) => <Placed element={c} scope={p.scope} room={p.room} overrides={p.overrides} design={p.design} act={p.act} inside={p.inside} />}</For>}>
        {look().text}
      </Show>
      <Show when={p.design && look().faults.length > 0}>
        <title>{look().faults.join("\n")}</title>
      </Show>
    </Dynamic>
  );
}

/** What media shows: an import's H264 over WebRTC when it has some, else its pictures as they
 *  come, a picture an expression gives, or a URL. One with nothing to show yet says so, as a
 *  camera that is missing or not up yet, and in the editor can still be picked and placed. */
function MediaView(p: { alias: string | null; src: unknown; fit: string }) {
  const pic = () => picture((p.alias ? live(p.alias).value : p.src) as Value);
  const url = () => (!p.alias && typeof p.src === "string" && p.src.trim() !== "" ? p.src : null);
  return (
    <Switch fallback={<div class="el-picture-none">{<ImagePlay size={20} />}</div>}>
      <Match when={p.alias && plays(p.alias) && p.alias}>{(a) => <VideoView alias={a()} fit={p.fit} />}</Match>
      <Match when={pic()}>{(x) => <PictureView picture={x()} fit={p.fit} />}</Match>
      <Match when={url()}>{(u) => <img class="el-picture" src={u()} alt="" draggable={false} style={{ "object-fit": FIT[p.fit] ?? "contain" }} />}</Match>
    </Switch>
  );
}

/** Whether an import has H264 to play: the Video child rant-transcoder makes, or its own frames. */
function plays(alias: string): boolean {
  const imp = state.imports.find((i) => i.alias === alias);
  if (imp && entity(`${imp.entity}/Video`)?.schema?.name === "VideoFrame") return true;
  return fields(live(alias).value)?.codec === "H264";
}

/** The import media shows: its source as a bare import name, or the name its expression gives
 *  as text, as a component's input passes it on. */
function playable(src: string | undefined, value: () => unknown): string | null {
  const imported = (name: unknown): name is string => typeof name === "string" && state.imports.some((i) => i.alias === name);
  const raw = (src ?? "").trim();
  if (imported(raw)) return raw;
  const v = value();
  return imported(v) ? v : null;
}

/** A video: an import's stream over WebRTC, or until that shows its frames from the socket
 *  decoded here, fitted as a picture is. Marked until a frame shows, and again while neither
 *  comes, with why when the screen cannot play it. */
function VideoView(p: { alias: string | null; fit: string }) {
  const [shows, setShows] = createSignal(false);
  const [drawn, setDrawn] = createSignal(false);
  const [playing, setPlaying] = createSignal<Playing | null>(null);
  let el!: HTMLVideoElement;
  let canvas!: HTMLCanvasElement;
  createEffect(() => {
    const alias = p.alias;
    setShows(false);
    setDrawn(false);
    if (!alias) return;
    const video = play(alias);
    setPlaying(video);
    createEffect(() => {
      el.srcObject = video.stream();
      setShows(false);
      void el.play().catch(() => {});
    });
    // the last frame decoded stays until the next, or until WebRTC's shows
    createEffect(() => {
      const decoded = video.decoded();
      if (!decoded) return;
      setDrawn(false);
      onCleanup(decoded.watch(canvas, () => setDrawn(true)));
    });
    onCleanup(() => {
      el.srcObject = null;
      setPlaying(null);
      stopPlaying(alias);
    });
  });
  const fit = () => FIT[p.fit] ?? "contain";
  const why = () => playing()?.decoded()?.fault() ?? unplayable();
  return (
    <>
      <canvas ref={canvas} class="el-picture over" hidden={shows() || !drawn()} style={{ "object-fit": fit() }} />
      <video ref={el} class="el-picture" style={{ "object-fit": fit() }} autoplay muted playsinline onLoadedData={() => setShows(true)} />
      <Show when={!shows() && !drawn()}>
        <div class="el-picture-none over" classList={{ cannot: !!why() }} title={why() ?? undefined}>
          <Show when={why()} fallback={<ImagePlay size={20} />}>
            {(w) => (
              <>
                <VideoOff size={20} />
                <span>{w()}</span>
              </>
            )}
          </Show>
        </div>
      </Show>
    </>
  );
}

/** An input showing its value. What an operator enters goes back through the value when it
 *  is a bare name such as `Speed`, read as the kind the value is now, then out as change. */
function InputBox(p: { element: Element; scope: Scope; value: unknown; act?: Act }) {
  const [draft, setDraft] = createSignal<string | null>(null);
  const [bad, setBad] = createSignal(false);
  const ref = () => bareRef(p.element.props.value);
  const open = () => !!p.act && !!ref() && p.scope.writes(ref()!.name);
  const read = (t: string): unknown => {
    if (typeof p.value === "number") return t.trim() !== "" && Number.isFinite(Number(t)) ? Number(t) : undefined;
    if (typeof p.value === "boolean") return t.trim() === "true" ? true : t.trim() === "false" ? false : undefined;
    return t;
  };
  const commit = () => {
    const t = draft();
    if (t === null) return true;
    const value = read(t);
    if (value === undefined) {
      setBad(true);
      return false;
    }
    setBad(false);
    setDraft(null);
    try {
      p.scope.set(ref()!.name, ref()!.fields, value);
    } catch (e) {
      notify(`${p.element.props.name ?? p.element.id}: ${(e as Error).message}`, "fault");
    }
    p.act?.fire(p.element, "change", { value });
    return true;
  };
  const drop = () => {
    setDraft(null);
    setBad(false);
  };
  return (
    <input
      class="el-input"
      classList={{ bad: bad() }}
      value={draft() ?? words(p.value)}
      readOnly={!open()}
      tabIndex={open() ? 0 : -1}
      title={bad() ? (typeof p.value === "number" ? "Enter a number" : "Enter true or false") : undefined}
      spellcheck={false}
      onInput={(e) => setDraft(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && commit()) e.currentTarget.blur();
        if (e.key === "Escape") {
          drop();
          e.currentTarget.blur();
        }
      }}
      onBlur={() => commit() || drop()}
    />
  );
}

/** What a pointer event brings: where across the element, 0 to 1, the angle around its
 *  centre (0 up, clockwise), the named part the press began on, and whether it is inside. */
interface Pointer {
  x: number;
  y: number;
  angle: number;
  on: string | null;
  inside: boolean;
}

function pointer(el: globalThis.Element, e: PointerEvent, on: string | null): Pointer {
  const at = local(el, e);
  // a diagram's matrix is single precision, so its noise is rounded away
  const clamp = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 1e5) / 1e5;
  const angle = (Math.atan2(at.x - at.w / 2, at.h / 2 - at.y) * 180) / Math.PI;
  return { x: clamp(at.w > 0 ? at.x / at.w : 0), y: clamp(at.h > 0 ? at.y / at.h : 0), angle, on, inside: at.x >= 0 && at.y >= 0 && at.x <= at.w && at.y <= at.h };
}

/** Where a pointer falls in an element as drawn, turned and scaled with all around it: from
 *  its own top left in its own units, with its own width and height. */
function local(el: globalThis.Element, e: PointerEvent): { x: number; y: number; w: number; h: number } {
  if (el instanceof SVGGraphicsElement) {
    const m = el.getScreenCTM();
    const b = el.getBBox();
    if (m) {
      const at = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
      return { x: at.x - b.x, y: at.y - b.y, w: b.width, h: b.height };
    }
  }
  const [w, h] = el instanceof HTMLElement ? [el.offsetWidth, el.offsetHeight] : [0, 0];
  // the turn of it and all around it, then the scale its drawn box shows
  let turn = 0;
  for (let a: globalThis.Element | null = el; a; a = a.parentElement) {
    const s = getComputedStyle(a);
    turn += parseFloat(s.rotate) || 0;
    if (s.transform !== "none") {
      const m = new DOMMatrix(s.transform);
      turn += (Math.atan2(m.b, m.a) * 180) / Math.PI;
    }
  }
  const t = (turn * Math.PI) / 180;
  const [cos, sin] = [Math.cos(t), Math.sin(t)];
  const r = el.getBoundingClientRect();
  const across = w * Math.abs(cos) + h * Math.abs(sin);
  const k = across > 0 ? r.width / across : 1;
  const [dx, dy] = [e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)];
  return { x: (cos * dx + sin * dy) / k + w / 2, y: (cos * dy - sin * dx) / k + h / 2, w, h };
}

/** A component in an instance's box, scaled to fit and centred. While a pointer is down on it,
 *  what it writes shows at once, and after release what its bindings say. It keeps its own
 *  variables, and which of its parts the pointer presses or is over. */
function Instance(p: { element: Element; scope: Scope; design?: boolean; act?: Act }) {
  const name = () => p.element.component ?? "";
  const [held, setHeld] = createSignal<Map<string, unknown> | null>(null);
  const hold = (e: PointerEvent) => {
    if (e.button !== 0) return;
    setHeld(new Map());
    follow(e, { end: () => setHeld(null) });
  };
  const own = {
    get: (input: string) => held()?.get(input),
    has: (input: string) => held()?.has(input) ?? false,
    set: (input: string, value: unknown) => {
      const h = held();
      if (h) setHeld(new Map(h).set(input, value));
    },
  };
  const kept = keep();
  // the box it is placed at, as the page lays it out, which a scaled component fits
  const placed = createSize();
  return (
    <Show when={component(name())} fallback={<div class="instance-missing">{name()} is missing</div>}>
      {(c) => {
        const scope = componentScope(c(), { props: p.element.props, outer: p.scope, own, kept: p.act ? kept : undefined });
        const act = p.act && componentAct(c(), scope, p.element, p.act);
        // a control whose values are all bound one way, and whose instance handles nothing,
        // only shows: it takes no input and does not look pressable
        const bindable = () => c().interface?.inputs.filter((i) => i.bindable) ?? [];
        const display = () => p.element.handlers.length === 0 && bindable().length > 0 && !bindable().some((i) => scope.writes(i.name));
        // scaled whole to fit and centred, or laid out in the box itself
        const fills = () => c().interface?.sizing === "fill";
        const [cw, ch] = [() => c().width * UNIT, () => c().height * UNIT];
        const place = () => (fills() ? "none" : fitIn(cw(), ch(), placed()).transform);
        return (
          // held as the press comes back up, after the parts read where it landed and before
          // their handlers write at the document, and a part's press heard after its own
          // handlers, so a release handler still reads how long it was held
          <div
            class="instance"
            style={{ width: fills() ? "100%" : `${cw()}px`, height: fills() ? "100%" : `${ch()}px`, transform: place() }}
            ref={(el) => {
              el.addEventListener("pointerdown", hold);
              // its element holds it only once the tree is built
              queueMicrotask(() => el.parentElement && placed.track(el.parentElement));
            }}
            onPointerDown={(e) => p.act && !display() && kept.press(e)}
            onPointerOver={(e) => p.act && !display() && kept.over(e)}
            onPointerLeave={() => kept.leave()}
          >
            <For each={c().children}>{(e) => <Placed element={e} scope={scope} room={CORNER} design={p.design} act={display() ? undefined : act} inside />}</For>
          </div>
        );
      }}
    </Show>
  );
}

/** The parts a pointer event is in: the named elements from the one hit out to the instance's
 *  box, those inside a nested instance left to it, and `root`. */
function partsAt(target: EventTarget | null, box: HTMLElement): string[] {
  const out = ["root"];
  for (let el = target as HTMLElement | null; el && el !== box; el = el.parentElement) {
    if (el.classList.contains("el") && el.dataset.name && el.closest(".instance") === box) out.push(el.dataset.name);
  }
  return out;
}

/** An instance's own variables and its parts' pointer state. `heldFor` ticks each frame while
 *  something is pressed, so an expression reading it fills as a hold goes on. */
function keep(): Kept & { press(e: PointerEvent): void; over(e: PointerEvent): void; leave(): void } {
  const [vars, setVars] = createStore<Record<string, unknown>>({});
  const [parts, setParts] = createStore<Record<string, { pressed: boolean; hovered: boolean; since: number }>>({});
  const [now, setNow] = createSignal(performance.now());
  let frame = 0;
  const tick = () => {
    setNow(performance.now());
    frame = Object.values(parts).some((s) => s.pressed) ? requestAnimationFrame(tick) : 0;
  };
  onCleanup(() => cancelAnimationFrame(frame));
  const mark = (names: string[], change: { pressed?: boolean; since?: number }) =>
    setParts(
      produce((all) => {
        for (const n of names) all[n] = { ...(all[n] ?? { pressed: false, hovered: false, since: 0 }), ...change };
      }),
    );
  return {
    get: (name) => vars[name],
    set: (name, path, value) =>
      setVars(
        produce((all) => {
          if (!path) {
            all[name] = value;
            return;
          }
          // a field of a variable that holds an object
          const steps = path.split(".");
          let at = all[name] as Record<string, unknown> | undefined;
          for (const s of steps.slice(0, -1)) at = at?.[s] as Record<string, unknown> | undefined;
          if (at && typeof at === "object") at[steps.at(-1)!] = value;
        }),
      ),
    part: (name) => {
      const s = parts[name];
      return { pressed: !!s?.pressed, hovered: !!s?.hovered, heldFor: s?.pressed ? Math.max(0, now() - s.since) : 0 };
    },
    press: (e) => {
      if (e.button !== 0) return;
      const names = partsAt(e.target, e.currentTarget as HTMLElement);
      mark(names, { pressed: true, since: performance.now() });
      if (!frame) frame = requestAnimationFrame(tick);
      follow(e, { end: () => mark(names, { pressed: false }) });
    },
    over: (e) => {
      const names = new Set(partsAt(e.target, e.currentTarget as HTMLElement));
      setParts(
        produce((all) => {
          for (const n of new Set([...Object.keys(all), ...names])) all[n] = { ...(all[n] ?? { pressed: false, since: 0 }), hovered: names.has(n) };
        }),
      );
    },
    leave: () => setParts(produce((all) => Object.values(all).forEach((s) => (s.hovered = false)))),
  };
}
