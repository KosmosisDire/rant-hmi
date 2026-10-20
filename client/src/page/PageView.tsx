// A page drawn as HTML: each element an absolutely placed div, its properties resolved
// live. The Design and Run tabs both draw with this, so what is edited is what runs.

import { createEffect, createMemo, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import type { Element } from "../protocol/Element";
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

/** Ours, never CSS: the rest of an element's properties are CSS. */
export const OWN = new Set(["name", "x", "y", "w", "h", "text"]);

/** CSS lengths that read a bare number as pixels. */
const LENGTHS = new Set(["font-size", "border-radius", "border-width", "padding", "margin", "gap", "letter-spacing", "outline-width"]);

export function PageView(p: { page: Page; overrides?: Overrides; design?: boolean }) {
  return (
    <div class="page" classList={{ design: p.design }} style={{ width: `${p.page.width}px`, height: `${p.page.height}px` }}>
      <For each={p.page.children}>{(e) => <ElementView element={e} overrides={p.overrides} design={p.design} />}</For>
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

function ElementView(p: { element: Element; overrides?: Overrides; design?: boolean }) {
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
  return (
    <div
      data-id={p.element.id}
      class="el"
      classList={{ text: p.element.tag === "span", unknown: look().unknown, faulty: p.design && look().faults.length > 0 }}
      style={look().style}
      title={p.design && look().faults.length > 0 ? look().faults.join("\n") : undefined}
    >
      <Show when={p.element.tag === "div"} fallback={look().text}>
        <For each={p.element.children}>{(c) => <ElementView element={c} overrides={p.overrides} design={p.design} />}</For>
      </Show>
    </div>
  );
}

/** Scales its page to fit the space it is given, centred. */
export function Fit(p: { width: number; height: number; children: JSX.Element }) {
  let host: HTMLDivElement | undefined;
  let inner: HTMLDivElement | undefined;
  const place = () => {
    const r = host?.getBoundingClientRect();
    if (!r || !inner || r.width === 0 || r.height === 0) return;
    const k = Math.min(r.width / p.width, r.height / p.height);
    inner.style.transform = `translate(${(r.width - p.width * k) / 2}px, ${(r.height - p.height * k) / 2}px) scale(${k})`;
  };
  onMount(() => {
    const watch = new ResizeObserver(place);
    watch.observe(host!);
    onCleanup(() => watch.disconnect());
  });
  createEffect(place);
  return (
    <div class="fit" ref={host}>
      <div class="fit-inner" ref={inner}>
        {p.children}
      </div>
    </div>
  );
}
