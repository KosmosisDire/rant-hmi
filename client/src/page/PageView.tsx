// A page drawn as HTML: each element an absolutely placed div, its properties resolved
// live. The Design and Run tabs both draw with this, so what is edited is what runs.

import { createMemo, createSignal, For, Index, Match, onCleanup, Show, Switch } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { Element } from "../protocol/Element";
import type { Page } from "../protocol/Page";
import type { JsonValue } from "../protocol/serde_json/JsonValue";
import { type At, bareRef, componentScope, docScope, type Kept, number, pageScope, repeatScope, resolve, type Scope } from "../state/bind";
import { short } from "../state/format";
import { component, notify } from "../state/store";
import { componentAct, type Act } from "./act";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A box the editor shows in place of an element's own while a drag lands. */
export type Overrides = (id: string) => Box | undefined;

/** Ours, never CSS: the rest of an element's properties are CSS. */
export const OWN = new Set(["name", "repeat", "x", "y", "w", "h", "text", "value"]);

/** At most this many copies of a repeat, so a mistaken one never floods the page. */
const COPIES = 500;

/** What a pointer does to any element but an input. */
export const POINTER = ["tap", "press", "release", "hold", "drag"];

/** How long a hold waits when its handler says nothing, in ms. */
const HOLD = 500;

/** CSS lengths that read a bare number as pixels. */
const LENGTHS = new Set(["font-size", "border-radius", "border-width", "padding", "margin", "gap", "letter-spacing", "outline-width"]);

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
  const boxes = page.children.map((e) => ({ id: e.id, b: { x: number(e.props.x), y: number(e.props.y), w: number(e.props.w), h: number(e.props.h) } }));
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
  for (const { id, b } of order) {
    places.set(id, { ...b, x: GAP, y });
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
      <For each={p.page.children}>{(e) => <Placed element={e} scope={scope()} overrides={p.overrides} design={p.design} act={p.act} />}</For>
    </div>
  );
}

function css(key: string, v: unknown): string {
  const text = String(v);
  return LENGTHS.has(key) && /^-?\d+(\.\d+)?$/.test(text) ? `${text}px` : text;
}

function words(v: unknown): string {
  if (v === undefined || v === null) return "";
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : short(v as JsonValue);
}

interface ElementProps {
  element: Element;
  scope: Scope;
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

/** One element. `inside` marks one drawn as part of an instance: it is the component's, not
 *  the page's, so it carries no id to pick it by. `at` is the copy of a repeat it is. */
function ElementView(p: ElementProps & { at?: At }) {
  const look = createMemo(() => {
    const style: Record<string, string> = {};
    const faults: string[] = [];
    let unknown = false;
    const take = (key: string): unknown => {
      const r = resolve(p.element.props[key], p.scope);
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
      const n = Number(take(k) ?? 0);
      return Number.isFinite(n) ? n : 0;
    };
    style.left = `${at("x")}px`;
    style.top = `${at("y")}px`;
    style.width = `${at("w")}px`;
    style.height = `${at("h")}px`;
    const text = p.element.tag === "span" ? words(take("text")) : "";
    const value = p.element.tag === "input" ? take("value") : undefined;
    return { style, unknown, faults, text, value, w: at("w"), h: at("h") };
  });
  // Pressed shows at once. Its release is heard on the window, so letting go anywhere ends
  // a press, and a tap needs the release over the element.
  const [pressed, setPressed] = createSignal(false);
  const live = () => !!p.act && p.element.handlers.some((h) => POINTER.includes(h.event));
  const fire = (event: string, payload: Pointer) => p.act?.fire(p.element, event, payload, p.at);
  // a hold handler's time, an expression read where the element sits
  const holdMs = () => {
    const h = p.element.handlers.find((x) => x.event === "hold");
    if (!h) return undefined;
    const r = resolve(h.after || String(HOLD), p.scope);
    const n = r.ok ? Number(r.value) : NaN;
    return Number.isFinite(n) ? n : HOLD;
  };
  const down = (e: PointerEvent & { currentTarget: HTMLDivElement }) => {
    if (!live() || e.button !== 0 || pressed()) return;
    const el = e.currentTarget;
    const on = (e.target as HTMLElement).closest<HTMLElement>(".el[data-name]")?.dataset.name ?? null;
    setPressed(true);
    fire("press", pointer(el, e, on));
    fire("drag", pointer(el, e, on));
    let last: PointerEvent = e;
    const ms = holdMs();
    const held = ms === undefined ? undefined : setTimeout(() => fire("hold", pointer(el, last, on)), ms);
    // a drag goes out at most once a frame, with the latest place
    let next: PointerEvent | null = null;
    const move = (m: PointerEvent) => {
      if (m.pointerId !== e.pointerId) return;
      last = m;
      if (!next) {
        requestAnimationFrame(() => {
          if (next) fire("drag", pointer(el, next, on));
          next = null;
        });
      }
      next = m;
    };
    const up = (u: PointerEvent) => {
      if (u.pointerId !== e.pointerId) return;
      next = null;
      clearTimeout(held);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setPressed(false);
      const at = pointer(el, u, on);
      fire("release", at);
      if (u.type === "pointerup" && at.inside) fire("tap", at);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  return (
    <div
      data-id={p.inside ? undefined : p.element.id}
      data-name={p.element.props.name}
      class="el"
      classList={{ text: p.element.tag === "span", unknown: look().unknown, faulty: p.design && look().faults.length > 0, live: live(), pressed: pressed() }}
      style={look().style}
      title={p.design && look().faults.length > 0 ? look().faults.join("\n") : undefined}
      onPointerDown={down}
    >
      <Switch fallback={look().text}>
        <Match when={p.element.tag === "div"}>
          <For each={p.element.children}>{(c) => <Placed element={c} scope={p.scope} overrides={p.overrides} design={p.design} act={p.act} inside={p.inside} />}</For>
        </Match>
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

function pointer(el: HTMLElement, e: PointerEvent, on: string | null): Pointer {
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
    const end = (u: PointerEvent) => {
      if (u.pointerId !== e.pointerId) return;
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      setHeld(null);
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
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
        const k = () => Math.min(p.w / c().width, p.h / c().height);
        const place = () => `translate(${(p.w - c().width * k()) / 2}px, ${(p.h - c().height * k()) / 2}px) scale(${k()})`;
        return (
          // held from the capture, before any part's handler writes, and a part's press heard
          // after its own handlers, so a release handler still reads how long it was held
          <div
            class="instance"
            style={{ width: `${c().width}px`, height: `${c().height}px`, transform: place() }}
            ref={(el) => el.addEventListener("pointerdown", hold, true)}
            onPointerDown={(e) => p.act && kept.press(e)}
            onPointerOver={(e) => p.act && kept.over(e)}
            onPointerLeave={() => kept.leave()}
          >
            <For each={c().children}>{(e) => <Placed element={e} scope={scope} design={p.design} act={act} inside />}</For>
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
      const up = (u: PointerEvent) => {
        if (u.pointerId !== e.pointerId) return;
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        mark(names, { pressed: false });
      };
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
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
