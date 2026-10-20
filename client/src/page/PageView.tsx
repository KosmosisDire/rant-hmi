// A page drawn as HTML: each element an absolutely placed div, its properties resolved
// live. The Design and Run tabs both draw with this, so what is edited is what runs.

import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import type { Element } from "../protocol/Element";
import type { Page } from "../protocol/Page";
import type { JsonValue } from "../protocol/serde_json/JsonValue";
import { componentScope, docScope, resolve, type Scope } from "../state/bind";
import { short } from "../state/format";
import { component } from "../state/store";
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
export const OWN = new Set(["name", "x", "y", "w", "h", "text"]);

/** CSS lengths that read a bare number as pixels. */
const LENGTHS = new Set(["font-size", "border-radius", "border-width", "padding", "margin", "gap", "letter-spacing", "outline-width"]);

/** A page, or a component drawn on its own with its inputs' defaults. */
export function PageView(p: { page: Page; overrides?: Overrides; design?: boolean; act?: Act }) {
  const scope = createMemo(() => docScope(p.page));
  return (
    <div class="page" classList={{ design: p.design }} style={{ width: `${p.page.width}px`, height: `${p.page.height}px` }}>
      <For each={p.page.children}>{(e) => <ElementView element={e} scope={scope()} overrides={p.overrides} design={p.design} act={p.act} />}</For>
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

/** One element. `inside` marks one drawn as part of an instance: it is the component's, not
 *  the page's, so it carries no id to pick it by. */
function ElementView(p: { element: Element; scope: Scope; overrides?: Overrides; design?: boolean; act?: Act; inside?: boolean }) {
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
    return { style, unknown, faults, text, w: at("w"), h: at("h") };
  });
  // Pressed shows at once. Its release is heard on the window, so letting go anywhere ends
  // a press, and a tap needs the release over the element.
  const [pressed, setPressed] = createSignal(false);
  const live = () => !!p.act && p.element.handlers.length > 0;
  const fire = (event: string, payload: Pointer) => p.act?.fire(p.element, event, payload);
  const down = (e: PointerEvent & { currentTarget: HTMLDivElement }) => {
    if (!live() || e.button !== 0 || pressed()) return;
    const el = e.currentTarget;
    const on = (e.target as HTMLElement).closest<HTMLElement>(".el[data-name]")?.dataset.name ?? null;
    setPressed(true);
    fire("press", pointer(el, e, on));
    fire("drag", pointer(el, e, on));
    // a drag goes out at most once a frame, with the latest place
    let next: PointerEvent | null = null;
    const move = (m: PointerEvent) => {
      if (m.pointerId !== e.pointerId) return;
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
          <For each={p.element.children}>{(c) => <ElementView element={c} scope={p.scope} overrides={p.overrides} design={p.design} act={p.act} inside={p.inside} />}</For>
        </Match>
        <Match when={p.element.tag === "use"}>
          <Instance element={p.element} scope={p.scope} w={look().w} h={look().h} design={p.design} act={p.act} />
        </Match>
      </Switch>
    </div>
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

/** A component drawn in an instance's box: its own size scaled to fit, centred, reading the
 *  inputs the instance gives. While a pointer is down on it, what it writes shows at once,
 *  and after release whatever its bindings say. */
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
  return (
    <Show when={component(name())} fallback={<div class="instance-missing">{name()} is missing</div>}>
      {(c) => {
        const scope = componentScope(c(), { props: p.element.props, outer: p.scope, own });
        const act = p.act && componentAct(c(), scope, p.element, p.act);
        const k = () => Math.min(p.w / c().width, p.h / c().height);
        const place = () => `translate(${(p.w - c().width * k()) / 2}px, ${(p.h - c().height * k()) / 2}px) scale(${k()})`;
        return (
          // held from the capture, before any part's handler writes
          <div class="instance" style={{ width: `${c().width}px`, height: `${c().height}px`, transform: place() }} ref={(el) => el.addEventListener("pointerdown", hold, true)}>
            <For each={c().children}>{(e) => <ElementView element={e} scope={scope} design={p.design} act={act} inside />}</For>
          </div>
        );
      }}
    </Show>
  );
}
