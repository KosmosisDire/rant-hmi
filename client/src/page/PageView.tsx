// A page drawn as HTML: each element an absolutely placed div, its properties resolved
// live. The Design and Run tabs both draw with this, so what is edited is what runs.

import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import type { Element } from "../protocol/Element";
import type { Page } from "../protocol/Page";
import type { JsonValue } from "../protocol/serde_json/JsonValue";
import { componentScope, docScope, resolve, type Scope } from "../state/bind";
import { component } from "../state/store";
import { componentAct, type Act } from "./act";
import { short } from "../state/format";

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
  const fire = (event: string) => p.act?.fire(p.element, event);
  const down = (e: PointerEvent & { currentTarget: HTMLDivElement }) => {
    if (!live() || e.button !== 0 || pressed()) return;
    const el = e.currentTarget;
    setPressed(true);
    fire("press");
    const up = (u: PointerEvent) => {
      if (u.pointerId !== e.pointerId) return;
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setPressed(false);
      fire("release");
      const r = el.getBoundingClientRect();
      if (u.type === "pointerup" && u.clientX >= r.left && u.clientX <= r.right && u.clientY >= r.top && u.clientY <= r.bottom) fire("tap");
    };
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  return (
    <div
      data-id={p.inside ? undefined : p.element.id}
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

/** A component drawn in an instance's box: its own size scaled to fit, centred, reading the
 *  inputs the instance gives. */
function Instance(p: { element: Element; scope: Scope; w: number; h: number; design?: boolean; act?: Act }) {
  const name = () => p.element.component ?? "";
  return (
    <Show when={component(name())} fallback={<div class="instance-missing">{name()} is missing</div>}>
      {(c) => {
        const scope = componentScope(c(), { props: p.element.props, outer: p.scope });
        const act = p.act && componentAct(c(), scope, p.element, p.act);
        const k = () => Math.min(p.w / c().width, p.h / c().height);
        const place = () => `translate(${(p.w - c().width * k()) / 2}px, ${(p.h - c().height * k()) / 2}px) scale(${k()})`;
        return (
          <div class="instance" style={{ width: `${c().width}px`, height: `${c().height}px`, transform: place() }}>
            <For each={c().children}>{(e) => <ElementView element={e} scope={scope} design={p.design} act={act} inside />}</For>
          </div>
        );
      }}
    </Show>
  );
}
