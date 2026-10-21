// A page drawn as HTML: each element an absolutely placed div, its properties resolved
// live. The Design and Run tabs both draw with this, so what is edited is what runs.

import { createEffect, createMemo, createSignal, For, Index, Match, onCleanup, Show, Switch } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { Dynamic } from "solid-js/web";
import type { Element } from "../protocol/Element";
import type { Page } from "../protocol/Page";
import type { Value } from "../protocol/Value";
import { type At, bareRef, componentScope, docScope, type Kept, originAt, pageScope, percentOf, placement, repeatScope, resolve, type Scope } from "../state/bind";
import { fields, short } from "../state/format";
import { play, stopPlaying } from "../net/video";
import { component, entity, live, notify, state } from "../state/store";
import { ImagePlay } from "../ui/icons";
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

/** A box the editor shows in place of an element's own while a drag lands. */
export type Overrides = (id: string) => Box | undefined;

/** The size of what holds an element, which a percent in its placement is a share of, and
 *  its origin, the point its children's x and y count from, the corner when unset. */
export interface Room {
  w: number;
  h: number;
  ox?: number;
  oy?: number;
}

/** Ours, never CSS: the rest of an element's properties are CSS. */
export const OWN = new Set(["name", "repeat", "x", "y", "w", "h", "origin", "text", "value", "viewbox", "src", "fit", "markup"]);

/** What a drawing holds: SVG shapes, whose every property but the name is an attribute. */
export const SHAPES = new Set(["path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "text", "g"]);

/** Attributes SVG spells with a capital, which the file writes in small letters. */
const CASED: Record<string, string> = { pathlength: "pathLength", textlength: "textLength", gradienttransform: "gradientTransform" };

/** How a drawing's view box fits its box: whole, filling it, or stretched to it, as a
 *  picture's fit does, so an overlay lines up with its picture. */
const FITS: Record<string, string> = { meet: "xMidYMid meet", slice: "xMidYMid slice", stretch: "none" };

/** At most this many copies of a repeat, so a mistaken one never floods the page. */
const COPIES = 500;

/** The events a press on the element itself starts, which make it look pressable. */
const PRESSES = POINTER.filter((e) => e !== "outside");

/** The instance pressed last, drawn above the others so what it opens is never hidden. */
const [raised, setRaised] = createSignal<Element | null>(null);

/** How often a repeat may run at the most, in ms, as the HMI's own timers. */
const QUICKEST = 50;

/** CSS lengths that read a bare number as pixels. */
const LENGTHS = new Set(["font-size", "border-radius", "border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius", "border-width", "padding", "margin", "gap", "letter-spacing", "outline-width"]);

/** A page's ground from its fill, none for the default or a component. */
export function pageGround(page: Page): string | undefined {
  if (page.interface || !page.fill) return undefined;
  const r = resolve(page.fill, pageScope);
  return r.ok && r.value !== undefined && r.value !== null && r.value !== "" ? String(r.value) : undefined;
}

/** The space between blocks a narrow screen stacks. */
const GAP = 22;

/** A page as a narrow screen shows it: its top level elements one under another in reading
 *  order, rows by how far down they start, left to right within a row. */
export function stacked(page: Page): { width: number; height: number; at: Overrides } {
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

/** A page, or a component drawn on its own with its inputs' defaults. `size` stands in for
 *  the page's own, as when a narrow screen stacks it. */
export function PageView(p: { page: Page; overrides?: Overrides; size?: { width: number; height: number }; design?: boolean; act?: Act }) {
  const scope = createMemo(() => docScope(p.page));
  const size = () => p.size ?? p.page;
  return (
    <div class="page" classList={{ design: p.design }} style={{ width: `${size().width}px`, height: `${size().height}px`, "--page-ground": pageGround(p.page) }}>
      <For each={p.page.children}>{(e) => <Placed element={e} scope={scope()} room={{ w: p.page.width, h: p.page.height }} overrides={p.overrides} design={p.design} act={p.act} />}</For>
    </div>
  );
}

function css(key: string, v: unknown): string {
  const text = String(v);
  if (!/^-?\d+(\.\d+)?$/.test(text)) return text;
  return LENGTHS.has(key) ? `${text}px` : key === "rotate" ? `${text}deg` : text;
}

/** How a shape turns, as CSS: about its origin, a point of its own box, never the drawing's
 *  corner. SVG's own rotate attribute turns a text's letters instead. */
const TURNS: Record<string, string> = { rotate: "rotate", origin: "transform-origin" };

function words(v: unknown): string {
  if (v === undefined || v === null) return "";
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : short(v as Value);
}

interface ElementProps {
  element: Element;
  scope: Scope;
  room: Room;
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
 *  and a tap needs the release over the element. */
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
  const down = (e: PointerEvent & { currentTarget: Element | globalThis.Element }) => {
    if (!live() || e.button !== 0 || pressed()) return;
    const el = e.currentTarget as globalThis.Element;
    const on = (e.target as globalThis.Element).closest<HTMLElement | SVGElement>(".el[data-name]")?.dataset.name ?? null;
    setPressed(true);
    fire("press", pointer(el, e, on));
    fire("drag", pointer(el, e, on));
    let last: PointerEvent = e;
    const ms = msOf("hold");
    const held = ms === undefined ? undefined : setTimeout(() => fire("hold", pointer(el, last, on)), ms);
    // a repeat runs at once, then on each beat until the press ends
    const every = msOf("repeat");
    if (every !== undefined) fire("repeat", pointer(el, e, on));
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
  // a press anywhere else is this element's outside, as closes what it opened
  let self: globalThis.Element | undefined;
  createEffect(() => {
    if (!p.act || !p.element.handlers.some((h) => h.event === "outside")) return;
    const away = (e: PointerEvent) => {
      if (self && !self.contains(e.target as Node)) fire("outside", pointer(self, e, null));
    };
    window.addEventListener("pointerdown", away, true);
    onCleanup(() => window.removeEventListener("pointerdown", away, true));
  });
  return { pressed, live, down, ref: (el: globalThis.Element) => (self = el) };
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
    // an instance's other properties are its inputs, never CSS
    for (const key of p.element.tag === "use" ? [] : Object.keys(p.element.props)) {
      if (OWN.has(key)) continue;
      const v = take(key);
      if (v !== undefined && v !== null && v !== "") style[key] = css(key, v);
    }
    const o = p.overrides?.(p.element.id);
    const at = (k: keyof Box) => {
      if (o) return o[k];
      const { expr, percent } = percentOf(p.element.props[k]);
      const n = Number(take(k, expr) ?? 0);
      const whole = k === "x" || k === "w" ? p.room.w : p.room.h;
      return Number.isFinite(n) ? (percent ? (n * whole) / 100 : n) : 0;
    };
    // x and y place its origin, counted from the origin of what holds it, and it turns about it
    const [w, h] = [at("w"), at("h")];
    const own = originAt(take("origin"), w, h);
    style.left = `${o ? o.x : (p.room.ox ?? 0) + at("x") - own.x}px`;
    style.top = `${o ? o.y : (p.room.oy ?? 0) + at("y") - own.y}px`;
    style.width = `${w}px`;
    style.height = `${h}px`;
    style["transform-origin"] = `${own.x}px ${own.y}px`;
    const text = p.element.tag === "span" ? words(take("text")) : "";
    const value = p.element.tag === "input" ? take("value") : undefined;
    const drawing = p.element.tag === "svg" ? { box: take("viewbox"), fit: take("fit") } : undefined;
    const markup = p.element.tag === "markup" ? svgFrom(take("markup"), faults) : undefined;
    const media = p.element.tag === "media" ? { alias: playable(p.element.props.src, () => take("src")), src: take("src"), fit: String(take("fit") ?? "meet") } : undefined;
    return { style, unknown, faults, text, value, drawing, markup, media, w, h, ox: own.x, oy: own.y };
  });
  const press = usePress(p);
  const inner = (c: Element) => <Placed element={c} scope={p.scope} room={{ w: look().w, h: look().h, ox: look().ox, oy: look().oy }} overrides={p.overrides} design={p.design} act={p.act} inside={p.inside} />;
  return (
    <div
      data-id={p.inside ? undefined : p.element.id}
      data-name={p.element.props.name}
      class="el"
      classList={{ text: p.element.tag === "span", unknown: look().unknown, faulty: p.design && look().faults.length > 0, live: press.live(), pressed: press.pressed() }}
      style={{ ...look().style, "z-index": raised() === p.element ? "1" : undefined }}
      title={p.design && look().faults.length > 0 ? look().faults.join("\n") : undefined}
      ref={(el) => {
        press.ref(el);
        if (p.element.tag === "use") el.addEventListener("pointerdown", () => p.act && setRaised(p.element), true);
      }}
      onPointerDown={press.down}
    >
      <Switch fallback={look().text}>
        <Match when={p.element.tag === "div"}>
          <For each={p.element.children}>{inner}</For>
        </Match>
        <Match when={look().drawing}>
          {(d) => (
            // its own units by default are its box's pixels
            <svg class="drawing" viewBox={d().box ? String(d().box) : `0 0 ${look().w} ${look().h}`} {...({ preserveAspectRatio: FITS[String(d().fit)] ?? FITS.meet } as Record<string, string>)}>
              <For each={p.element.children}>{inner}</For>
            </svg>
          )}
        </Match>
        <Match when={look().markup}>{(m) => <>{m()}</>}</Match>
        <Match when={look().media}>{(m) => <MediaView alias={m().alias} src={m().src} fit={m().fit} design={p.design} />}</Match>
        <Match when={p.element.tag === "use"}>
          <Instance element={p.element} scope={p.scope} w={look().w} h={look().h} design={p.design} act={p.act} />
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

/** A shape in a drawing: each property an SVG attribute, its value an expression. */
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
 *  come, a picture an expression gives, or a URL. In the editor one with nothing to show yet
 *  says so, so it can still be picked and placed. */
function MediaView(p: { alias: string | null; src: unknown; fit: string; design?: boolean }) {
  const pic = () => picture((p.alias ? live(p.alias).value : p.src) as Value);
  const url = () => (!p.alias && typeof p.src === "string" && p.src.trim() !== "" ? p.src : null);
  return (
    <Switch fallback={<Show when={p.design}>{<div class="el-picture-none">{<ImagePlay size={20} />}</div>}</Show>}>
      <Match when={p.alias && plays(p.alias) && p.alias}>{(a) => <VideoView alias={a()} fit={p.fit} design={p.design} />}</Match>
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

/** A video: an import's stream over WebRTC, fitted as a picture is. The editor marks it until
 *  its first frame shows. */
function VideoView(p: { alias: string | null; fit: string; design?: boolean }) {
  const [shows, setShows] = createSignal(false);
  let el!: HTMLVideoElement;
  createEffect(() => {
    const alias = p.alias;
    setShows(false);
    if (!alias) return;
    const stream = play(alias);
    createEffect(() => {
      el.srcObject = stream();
      void el.play().catch(() => {});
    });
    onCleanup(() => {
      el.srcObject = null;
      stopPlaying(alias);
    });
  });
  return (
    <>
      <video ref={el} class="el-picture" style={{ "object-fit": FIT[p.fit] ?? "contain" }} autoplay muted playsinline onLoadedData={() => setShows(true)} />
      <Show when={p.design && !shows()}>
        <div class="el-picture-none over">
          <ImagePlay size={20} />
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
  const r = el.getBoundingClientRect();
  const [dx, dy] = [e.clientX - r.left, e.clientY - r.top];
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const angle = (Math.atan2(dx - r.width / 2, r.height / 2 - dy) * 180) / Math.PI;
  return { x: clamp(dx / r.width), y: clamp(dy / r.height), angle, on, inside: dx >= 0 && dy >= 0 && dx <= r.width && dy <= r.height };
}

/** A component in an instance's box, scaled to fit and centred. While a pointer is down on it,
 *  what it writes shows at once, and after release what its bindings say. It keeps its own
 *  variables, and which of its parts the pointer presses or is over. */
function Instance(p: { element: Element; scope: Scope; w: number; h: number; design?: boolean; act?: Act }) {
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
  return (
    <Show when={component(name())} fallback={<div class="instance-missing">{name()} is missing</div>}>
      {(c) => {
        const scope = componentScope(c(), { props: p.element.props, outer: p.scope, own, kept: p.act ? kept : undefined });
        const act = p.act && componentAct(c(), scope, p.element, p.act);
        // a control whose values are all bound one way, and whose instance handles nothing,
        // only shows: it takes no input and does not look pressable
        const bindable = () => c().interface?.inputs.filter((i) => i.bindable) ?? [];
        const display = () => p.element.handlers.length === 0 && bindable().length > 0 && !bindable().some((i) => scope.writes(i.name));
        const k = () => Math.min(p.w / c().width, p.h / c().height);
        const place = () => `translate(${(p.w - c().width * k()) / 2}px, ${(p.h - c().height * k()) / 2}px) scale(${k()})`;
        return (
          // held from the capture, before any part's handler writes, and a part's press heard
          // after its own handlers, so a release handler still reads how long it was held
          <div
            class="instance"
            style={{ width: `${c().width}px`, height: `${c().height}px`, transform: place() }}
            ref={(el) => el.addEventListener("pointerdown", hold, true)}
            onPointerDown={(e) => p.act && !display() && kept.press(e)}
            onPointerOver={(e) => p.act && !display() && kept.over(e)}
            onPointerLeave={() => kept.leave()}
          >
            <For each={c().children}>{(e) => <Placed element={e} scope={scope} room={{ w: c().width, h: c().height }} design={p.design} act={display() ? undefined : act} inside />}</For>
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
