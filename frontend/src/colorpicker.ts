/* A small self-contained color picker: a swatch plus hex field, and a popup with an SV
 * square, a hue bar and an alpha bar. Generic on purpose: value in, commit out, no
 * knowledge of slots or the inspector. Values are "#rrggbb", or "#rrggbbaa" when the
 * alpha is not full. Like the context menu, the popup sits on a full-screen dismiss
 * overlay, so any click outside closes it and nobody tracks "is a picker open".
 *
 * A value may also be a theme token reference, "$<name>". A caller that
 * hands in a TokenAccess gets the tokenized treatment: the swatch paints the RESOLVED
 * color (this view's mode) with a corner notch saying "this is a token", the text field
 * shows and accepts the honest "$name", and a small $ button opens the token menu —
 * grouped swatch+name rows plus "custom…", which falls back to the ordinary picker. */

import { commitInput, el } from "./dom.js";
import { makeShell, Shell } from "./popover.js";
import { bind, bindField } from "./reconcile.js";

/* what the token features need from the caller; resolution stays the caller's (slots.ts) */
export interface TokenOffer {
  name: string;
  group: string;
  hex: string; /* resolved in the current view mode */
}

export interface TokenAccess {
  resolve: (raw: string) => string; /* "$name" -> hex; a literal passes through */
  list: () => TokenOffer[];
}

interface Rgba {
  r: number; /* 0..255 */
  g: number;
  b: number;
  a: number;
}

interface Hsva {
  h: number; /* 0..360 */
  s: number; /* 0..1 */
  v: number; /* 0..1 */
  a: number; /* 0..1 */
}

/* ---- color math ---- */

function parseHex(text: string): Rgba | null {
  if (typeof text !== "string" || !text.startsWith("#")) return null;
  const hex = text.slice(1);
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  const pair = (at: number) => parseInt(hex.slice(at, at + 2), 16);
  if (hex.length === 3)
    return {
      r: parseInt(hex[0] + hex[0], 16),
      g: parseInt(hex[1] + hex[1], 16),
      b: parseInt(hex[2] + hex[2], 16),
      a: 255,
    };
  if (hex.length === 6) return { r: pair(0), g: pair(2), b: pair(4), a: 255 };
  if (hex.length === 8) return { r: pair(0), g: pair(2), b: pair(4), a: pair(6) };
  return null;
}

function formatHex(c: Rgba): string {
  const two = (n: number) => Math.round(n).toString(16).padStart(2, "0");
  const base = "#" + two(c.r) + two(c.g) + two(c.b);
  return c.a >= 255 ? base : base + two(c.a);
}

/* ---- tuple text forms: "78, 142, 247" / "78 142 247 255" / "210, 80%, 97%" ----
   Triples or quadruples, comma or whitespace separated, alpha optional. A channel
   with % is a percentage; a bare 0..1 value reads as a fraction where the channel's
   natural range is bigger (CSS habits paste cleanly either way). */

function tupleParts(text: string): string[] | null {
  const list = text.trim().split(/[\s,;]+/).filter((part) => part.length);
  return list.length === 3 || list.length === 4 ? list : null;
}

function tokenNum(token: string): number {
  return Number(token.replace(/%$/, ""));
}

function clampChan(n: number, hi: number): number {
  return Math.max(0, Math.min(hi, n));
}

function parseRgbaText(text: string): Rgba | null {
  const p = tupleParts(text);
  if (!p) return null;
  const chan = (token: string) => {
    const n = tokenNum(token);
    return Number.isFinite(n) ? clampChan(token.endsWith("%") ? n * 2.55 : n, 255) : null;
  };
  const r = chan(p[0]);
  const g = chan(p[1]);
  const b = chan(p[2]);
  if (r === null || g === null || b === null) return null;
  let a = 255;
  if (p.length === 4) {
    const n = tokenNum(p[3]);
    if (!Number.isFinite(n)) return null;
    a = clampChan(p[3].endsWith("%") ? n * 2.55 : n <= 1 ? n * 255 : n, 255);
  }
  return { r, g, b, a };
}

/* the text row speaks HSL (the CSS vocabulary); the picker's session state stays HSV
   (the SV square is an HSV construct), converted at this boundary */
function parseHslaText(text: string): Hsva | null {
  const p = tupleParts(text);
  if (!p) return null;
  const hRaw = tokenNum(p[0]);
  if (!Number.isFinite(hRaw)) return null;
  const unit = (token: string) => {
    const n = tokenNum(token);
    if (!Number.isFinite(n)) return null;
    return clampChan(token.endsWith("%") ? n / 100 : n <= 1 ? n : n / 100, 1);
  };
  const s = unit(p[1]);
  const l = unit(p[2]);
  const a = p.length === 4 ? unit(p[3]) : 1;
  if (s === null || l === null || a === null) return null;
  const v = l + s * Math.min(l, 1 - l);
  return {
    h: ((hRaw % 360) + 360) % 360,
    s: v === 0 ? 0 : 2 * (1 - l / v),
    v,
    a,
  };
}

function formatRgbaText(c: Rgba): string {
  return [c.r, c.g, c.b, c.a].map((n) => Math.round(n)).join(", ");
}

function formatHslaText(c: Hsva): string {
  const l = c.v * (1 - c.s / 2);
  const s = l === 0 || l === 1 ? 0 : (c.v - l) / Math.min(l, 1 - l);
  return (
    Math.round(c.h) + ", " + Math.round(s * 100) + "%, " + Math.round(l * 100) + "%, " +
    Math.round(c.a * 100) + "%"
  );
}

function rgbToHsv(c: Rgba): Hsva {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max > 0 ? d / max : 0, v: max, a: c.a / 255 };
}

function hsvToRgb(c: Hsva): Rgba {
  const f = (n: number) => {
    const k = (n + c.h / 60) % 6;
    return c.v - c.v * c.s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return { r: f(5) * 255, g: f(3) * 255, b: f(1) * 255, a: c.a * 255 };
}

/* the alpha checkerboard, under any surface that shows a possibly-transparent color */
const CHECKER =
  "conic-gradient(#3a3a3a 25%, #262626 0 50%, #3a3a3a 0 75%, #262626 0) 0 0 / 8px 8px";

function cssRgba(c: Rgba): string {
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${(c.a / 255).toFixed(3)})`;
}

function paintSwatch(node: HTMLElement, c: Rgba): void {
  const fill = cssRgba(c);
  node.style.background = `linear-gradient(${fill}, ${fill}), ${CHECKER}`;
}

/* ---- the popup (one per document, like the context menu) ---- */

let shell: Shell | null = null;

function ensure(): Shell {
  /* wheel "block": the overlay must not trap the wheel — zooming the canvas mid-pick
     is normal, so wheel events are re-dispatched to whatever sits under it */
  return (shell ??= makeShell({
    id: "cpick",
    boxClass: "cpick-pop",
    dismiss: "backdrop",
    wheel: "block",
  }));
}

function closeColorPicker(): void {
  shell?.close();
}

/* a strip or square that maps pointer drags to 0..1 coordinates, committing on release */
function dragArea(
  node: HTMLElement,
  onMove: (x: number, y: number) => void,
  onDone: () => void,
): void {
  node.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    node.setPointerCapture(ev.pointerId);
    const move = (e: PointerEvent) => {
      const box = node.getBoundingClientRect();
      onMove(
        Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)),
        Math.max(0, Math.min(1, (e.clientY - box.top) / box.height)),
      );
    };
    move(ev);
    const up = () => {
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", up);
      onDone();
    };
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", up);
  });
}

function openColorPicker(
  anchor: HTMLElement,
  value: string,
  onPick: (hex: string) => void,
): void {
  const sh = ensure();
  const box = sh.box;
  box.classList.remove("tokens");
  box.innerHTML = "";

  /* session state is HSV so the hue survives s = 0 or v = 0 (a grey or black picked
     from the square keeps the hue the user chose on the bar) */
  const color = rgbToHsv(parseHex(value) ?? { r: 0, g: 0, b: 0, a: 255 });

  const svDot = el("span", { class: "cpick-dot" });
  const sv = el("div", { class: "cpick-sv" }, [svDot]);
  const hueDot = el("span", { class: "cpick-dot" });
  const hue = el("div", { class: "cpick-bar cpick-hue" }, [hueDot]);
  const alphaDot = el("span", { class: "cpick-dot" });
  const alpha = el("div", { class: "cpick-bar" }, [alphaDot]);
  const preview = el("span", { class: "swatch", title: "current color" });
  const hex = commitInput(formatHex(hsvToRgb(color)), (text) => {
    const parsed = parseHex(text);
    if (!parsed) {
      (hex as HTMLInputElement).value = formatHex(hsvToRgb(color));
      return;
    }
    Object.assign(color, rgbToHsv(parsed));
    paint();
    commit();
  }, { class: "field grow cpick-hex" });
  const rgbaField = commitInput("", (text) => {
    const parsed = parseRgbaText(text);
    if (!parsed) {
      (rgbaField as HTMLInputElement).value = formatRgbaText(hsvToRgb(color));
      return;
    }
    Object.assign(color, rgbToHsv(parsed));
    paint();
    commit();
  }, { class: "field grow cpick-hex" });
  const hslaField = commitInput("", (text) => {
    const parsed = parseHslaText(text);
    if (!parsed) {
      (hslaField as HTMLInputElement).value = formatHslaText(color);
      return;
    }
    Object.assign(color, parsed);
    paint();
    commit();
  }, { class: "field grow cpick-hex" });

  box.append(
    sv,
    hue,
    alpha,
    el("div", { class: "cpick-row" }, [preview, hex]),
    el("div", { class: "cpick-row" }, [el("span", { class: "cpick-kw", text: "rgba" }), rgbaField]),
    el("div", { class: "cpick-row" }, [el("span", { class: "cpick-kw", text: "hsla" }), hslaField]),
  );

  const paint = () => {
    const rgba = hsvToRgb(color);
    const opaque = hsvToRgb({ ...color, a: 1 });
    sv.style.background =
      `linear-gradient(to top, #000, transparent), ` +
      `linear-gradient(to right, #fff, hsl(${color.h.toFixed(1)}, 100%, 50%))`;
    svDot.style.left = (color.s * 100).toFixed(1) + "%";
    svDot.style.top = ((1 - color.v) * 100).toFixed(1) + "%";
    hueDot.style.left = ((color.h / 360) * 100).toFixed(1) + "%";
    hueDot.style.top = "50%";
    alpha.style.background =
      `linear-gradient(to right, transparent, ${cssRgba(opaque)}), ${CHECKER}`;
    alphaDot.style.left = (color.a * 100).toFixed(1) + "%";
    alphaDot.style.top = "50%";
    paintSwatch(preview, rgba);
    if (document.activeElement !== hex) (hex as HTMLInputElement).value = formatHex(rgba);
    if (document.activeElement !== rgbaField)
      (rgbaField as HTMLInputElement).value = formatRgbaText(rgba);
    if (document.activeElement !== hslaField)
      (hslaField as HTMLInputElement).value = formatHslaText(color);
  };

  const commit = () => onPick(formatHex(hsvToRgb(color)));

  /* commits ride along DURING a drag, so the canvas tracks the pointer; one per
     animation frame, not per pointermove, and the release still commits exactly */
  let queued = false;
  const commitLive = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      commit();
    });
  };

  /* choosing a color while fully transparent cannot mean "keep it invisible": the drag
     that picks a hue or a spot on the square promotes the alpha to full */
  const visible = () => {
    if (color.a === 0) color.a = 1;
  };
  dragArea(sv, (x, y) => {
    visible();
    color.s = x;
    color.v = 1 - y;
    paint();
    commitLive();
  }, commit);
  dragArea(hue, (x) => {
    visible();
    color.h = Math.min(x, 0.9999) * 360;
    paint();
    commitLive();
  }, commit);
  dragArea(alpha, (x) => {
    color.a = x;
    paint();
    commitLive();
  }, commit);

  paint();
  /* below the anchor, kept on screen */
  sh.openUnder(anchor, { fallbackW: 200, fallbackH: 200 });
}

/* the token menu: the same dismiss overlay as the picker, listing tokens by group */
function openTokenMenu(
  anchor: HTMLElement,
  access: TokenAccess,
  current: string,
  onToken: (ref: string) => void,
  onCustom: () => void,
): void {
  const sh = ensure();
  const box = sh.box;
  box.classList.add("tokens");
  box.innerHTML = "";

  let group = "";
  for (const offer of access.list()) {
    if (offer.group !== group) {
      group = offer.group;
      box.appendChild(el("div", { class: "tok-group", text: group }));
    }
    const swatch = el("span", { class: "swatch" });
    paintSwatch(swatch, parseHex(offer.hex) ?? { r: 0, g: 0, b: 0, a: 0 });
    const row = el("button", {
      class: "tok-row" + (current === "$" + offer.name ? " on" : ""),
      onclick: () => {
        closeColorPicker();
        onToken("$" + offer.name);
      },
    }, [swatch, el("span", { class: "tok-name", text: "$" + offer.name })]);
    box.appendChild(row);
  }
  box.appendChild(
    el("button", {
      class: "tok-row tok-custom",
      text: "custom…",
      onclick: () => onCustom(),
    }),
  );

  sh.openUnder(anchor, { fallbackW: 180, fallbackH: 200, clampFlip: true });
}

/* ---- the field control ---- */

/* The anchor row a caller embeds: a swatch that opens the popup, and the hex text form.
 * Given a key and a reader it drives itself, so the colour arriving from the document (or
 * from another window's drag) repaints the swatch and refills the field without the anchor
 * ever being replaced. That is what lets the popup stay open across an edit: it holds this
 * exact swatch as its anchor. */
export function colorField(
  value: string,
  commit: (hex: string) => void,
  key?: string,
  read?: () => string,
  tokens?: TokenAccess,
): HTMLElement {
  const swatch = el("button", { class: "swatch", title: "pick a color" });
  const current = () => (read ? read() : (hex as HTMLInputElement).value);
  /* the anchor field takes hex, a pasted rgba tuple as a courtesy, and — where the
     caller speaks tokens — an honest "$name" */
  const hex = commitInput(value, (text) => {
    if (tokens && text.startsWith("$")) {
      commit(text.trim());
      return;
    }
    const parsed = parseHex(text) ?? parseRgbaText(text);
    if (!parsed) {
      (hex as HTMLInputElement).value = read ? read() : value;
      return;
    }
    commit(formatHex(parsed));
  }, { class: "field grow cpick-hex" });

  /* the swatch paints the RESOLVED color; the notch class marks a tokenized value */
  const paintAnchor = (text: string) => {
    const resolved = tokens ? tokens.resolve(text) : text;
    paintSwatch(swatch, parseHex(resolved) ?? { r: 0, g: 0, b: 0, a: 0 });
    swatch.classList.toggle("token", Boolean(tokens) && text.startsWith("$"));
  };
  paintAnchor(value);
  if (key && read) {
    bindField(key, hex as HTMLInputElement, read);
    bind(key + ".swatch", swatch, () => paintAnchor(read()));
  }
  const openCustom = () =>
    openColorPicker(swatch, tokens ? tokens.resolve(current()) : current(), (picked) => {
      /* the drag paints the anchor as it goes; the echo confirms it through the binding */
      paintAnchor(picked);
      (hex as HTMLInputElement).value = picked;
      commit(picked);
    });
  swatch.addEventListener("click", openCustom);

  if (!tokens) return el("span", { class: "value-cell grow" }, [swatch, hex]);

  /* the compact token entry: a $ button opening the grouped token menu */
  const pick = el("button", { class: "token-btn", text: "$", title: "pick a theme token" });
  pick.addEventListener("click", () =>
    openTokenMenu(pick, tokens, current(), (ref) => {
      paintAnchor(ref);
      (hex as HTMLInputElement).value = ref;
      commit(ref);
    }, openCustom),
  );
  return el("span", { class: "value-cell grow" }, [swatch, hex, pick]);
}
