// A colour chosen by hue, saturation and brightness, its alpha, a hex code or a theme token.
// A drag shows as it goes and is kept when it lets go.

import { createSignal, For, Show } from "solid-js";
import { DraftInput } from "./DraftInput";

/** Red, green and blue from 0 to 255, alpha from 0 to 1. */
export type Rgba = [number, number, number, number];

interface Hsva {
  h: number;
  s: number;
  v: number;
  a: number;
}

let probe: CanvasRenderingContext2D | null = null;

/** Any CSS colour as its channels, null when the text is no colour. The browser reads it, so
 *  names and rgb() work too. */
export function parseColour(css: string): Rgba | null {
  probe ??= document.createElement("canvas").getContext("2d");
  if (!probe) return null;
  const read = (sentinel: string) => {
    probe!.fillStyle = sentinel;
    probe!.fillStyle = css;
    return String(probe!.fillStyle);
  };
  // a colour the canvas refuses leaves what was there, so two different ones tell
  const got = read("#010203");
  if (got === "#010203" && read("#040506") === "#040506") return null;
  if (got.startsWith("#")) return [1, 3, 5].map((i) => parseInt(got.slice(i, i + 2), 16)).concat(1) as Rgba;
  const parts = /\(([^)]*)\)/.exec(got)?.[1].split(",").map(Number) ?? [0, 0, 0, 1];
  return [parts[0], parts[1], parts[2], parts[3] ?? 1];
}

const two = (n: number) => Math.round(n).toString(16).padStart(2, "0");

/** `#rrggbb`, with alpha only when it is not opaque. */
export function hex([r, g, b, a]: Rgba): string {
  return `#${two(r)}${two(g)}${two(b)}${a < 1 ? two(a * 255) : ""}`;
}

function toHsva([r, g, b, a]: Rgba): Hsva {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const d = max - Math.min(R, G, B);
  let h = 0;
  if (d > 0) h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max, a };
}

function toRgba({ h, s, v, a }: Hsva): Rgba {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255;
  };
  return [f(5), f(3), f(1), a];
}

const clamp = (n: number) => Math.min(1, Math.max(0, n));

export function ColourPicker(p: { value: string; tokens: { name: string; colour: string }[]; onShow: (text: string) => void; onPick: (text: string) => void }) {
  const [c, setC] = createSignal<Hsva>(toHsva(parseColour(p.value) ?? [128, 128, 128, 1]));
  const text = () => hex(toRgba(c()));
  // a drag on one of the areas sets what it maps to, live, and keeps it on letting go
  const drag = (set: (x: number, y: number) => void) => (e: PointerEvent & { currentTarget: HTMLElement }) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const at = (m: PointerEvent) => {
      const r = el.getBoundingClientRect();
      set(clamp((m.clientX - r.left) / r.width), clamp((m.clientY - r.top) / r.height));
      p.onShow(text());
    };
    const up = () => {
      el.removeEventListener("pointermove", at);
      el.removeEventListener("lostpointercapture", up);
      p.onPick(text());
    };
    el.addEventListener("pointermove", at);
    el.addEventListener("lostpointercapture", up);
    at(e);
  };
  // picking a colour while it is clear means wanting to see it
  const seen = (next: Hsva) => setC({ ...next, a: next.a === 0 ? 1 : next.a });
  const solid = () => hex(toRgba({ ...c(), a: 1 }));
  return (
    <div class="colour-picker">
      <div
        class="cp-sv"
        style={{ "background-color": hex(toRgba({ h: c().h, s: 1, v: 1, a: 1 })) }}
        onPointerDown={drag((x, y) => seen({ ...c(), s: x, v: 1 - y }))}
      >
        <span class="cp-knob" style={{ left: `${c().s * 100}%`, top: `${(1 - c().v) * 100}%`, background: solid() }} />
      </div>
      <div class="cp-strip cp-hue" onPointerDown={drag((x) => seen({ ...c(), h: x * 360 }))}>
        <span class="cp-knob" style={{ left: `${(c().h / 360) * 100}%`, background: hex(toRgba({ h: c().h, s: 1, v: 1, a: 1 })) }} />
      </div>
      <div class="cp-strip cp-alpha" onPointerDown={drag((x) => setC({ ...c(), a: Math.round(x * 100) / 100 }))}>
        <span class="cp-fade" style={{ background: `linear-gradient(to right, transparent, ${solid()})` }} />
        <span class="cp-knob" style={{ left: `${c().a * 100}%`, background: text() }} />
      </div>
      <div class="cp-row">
        <DraftInput
          class="editor"
          value={text()}
          title="A hex code, or any CSS colour"
          accept={(t) => parseColour(t.trim()) !== null}
          onCommit={(t) => {
            setC(toHsva(parseColour(t.trim())!));
            p.onPick(text());
          }}
        />
        <span class="cp-alpha-text">{Math.round(c().a * 100)}%</span>
      </div>
      <Show when={p.tokens.length > 0}>
        <div class="cp-tokens-head">Theme</div>
        <div class="cp-tokens">
          <For each={p.tokens}>
            {(t) => (
              <button class="cp-token" title={`$${t.name}, follows the theme`} onClick={() => p.onPick(`$${t.name}`)}>
                <span class="swatch" style={{ background: t.colour }} />
                <span class="mono">${t.name}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
