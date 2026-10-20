// A page drawn as HTML: each element an absolutely placed div, its properties resolved
// live. The Design and Run tabs both draw with this, so what is edited is what runs.

import { createMemo, createSignal, For, Show } from "solid-js";
import type { Element } from "../protocol/Element";
import type { Event } from "../protocol/Event";
import type { Page } from "../protocol/Page";
import type { JsonValue } from "../protocol/serde_json/JsonValue";
import { resolve } from "../state/bind";
import { short } from "../state/format";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A box the editor shows in place of an element's own while a drag lands. */
export type Overrides = (id: string) => Box | undefined;

/** Sends a pointer event on an element to the backend, which runs its handler. */
export type Fire = (id: string, event: Event) => void;

/** Ours, never CSS: the rest of an element's properties are CSS. */
export const OWN = new Set(["name", "x", "y", "w", "h", "text"]);

/** CSS lengths that read a bare number as pixels. */
const LENGTHS = new Set(["font-size", "border-radius", "border-width", "padding", "margin", "gap", "letter-spacing", "outline-width"]);

export function PageView(p: { page: Page; overrides?: Overrides; design?: boolean; fire?: Fire }) {
  return (
    <div class="page" classList={{ design: p.design }} style={{ width: `${p.page.width}px`, height: `${p.page.height}px` }}>
      <For each={p.page.children}>{(e) => <ElementView element={e} overrides={p.overrides} design={p.design} fire={p.fire} />}</For>
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

function ElementView(p: { element: Element; overrides?: Overrides; design?: boolean; fire?: Fire }) {
  const look = createMemo(() => {
    const style: Record<string, string> = {};
    const faults: string[] = [];
    let unknown = false;
    const take = (key: string): unknown => {
      const r = resolve(p.element.props[key]);
      if (r.ok) return r.value;
      if (r.unknown) unknown = true;
      else faults.push(`${key}: ${r.error}`);
      return undefined;
    };
    for (const key of Object.keys(p.element.props)) {
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
    return { style, unknown, faults, text };
  });
  // Pressed shows at once. Its release is heard on the window, so letting go anywhere ends
  // a press, and a tap needs the release over the element.
  const [pressed, setPressed] = createSignal(false);
  const live = () => !!p.fire && p.element.handlers.length > 0;
  const fire = (event: Event) => p.element.handlers.some((h) => h.event === event) && p.fire?.(p.element.id, event);
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
      data-id={p.element.id}
      class="el"
      classList={{ text: p.element.tag === "span", unknown: look().unknown, faulty: p.design && look().faults.length > 0, live: live(), pressed: pressed() }}
      style={look().style}
      title={p.design && look().faults.length > 0 ? look().faults.join("\n") : undefined}
      onPointerDown={down}
    >
      <Show when={p.element.tag === "div"} fallback={look().text}>
        <For each={p.element.children}>{(c) => <ElementView element={c} overrides={p.overrides} design={p.design} fire={p.fire} />}</For>
      </Show>
    </div>
  );
}
