/* THE VALUE BOX: the one input control every rvalue is heading toward.
 *
 * Every value is an expression box — a literal is just a short expression — so there is
 * no mode and no mode switch. Two affordances flank the text: the ICON on the left is
 * the literal-picker entry point (a swatch opens the color picker, an enum icon drops
 * the variant list, a number icon scrubs), the BROWSE button on the right inserts a
 * name from the box's Scope at the caret. The text between them keeps the house idiom
 * exactly: commit on blur/Enter, Escape reverts, the syntax underlay behind it, and
 * autocomplete over the same Scope the browse tree reads, so the two can never
 * disagree.
 *
 * THE HANDLE'S LAW (the no-undo gate): a direct gesture — the bool click-cycle, the
 * number scrub — works only while the current text is already a literal of the box's
 * shape; on an expression the icon dims for gestures, though a click still opens the
 * picker where one exists. Same rule the canvas enforces on its drag handles: a gesture
 * never overwrites authored logic. Empty counts as scrubable — an unset field is
 * exactly what direct manipulation writes literals into.
 *
 * Affordances hide by ABSENCE: no variants() means no enum picker, an empty names()
 * hides the browse button, no tokens() and the color picker opens without its Tokens
 * tab. One box, no variants of the control itself. */

import { openColorPicker, paintSwatch, parseHex } from "../colorpicker.js";
import { alignGrid, commitInput, el } from "../dom.js";
import { highlighted } from "../highlight.js";
import { iconMarkup } from "../icons.js";
import { closeMenu, openMenu } from "../menu.js";
import { makeShell, Shell } from "../popover.js";
import { bind, bindField } from "../reconcile.js";
import { streeTree, StreeTreeRow } from "../streerows.js";
import { announceInput, attachAutocomplete } from "./autocomplete.js";
import { BrowseRow, Scope } from "./scope.js";

export interface BoxType {
  shape: "num" | "bool" | "text" | "color" | "enum" | "align" | "list" | "map";
  step?: number;               /* scrub grain; 1 when unsaid */
  unit?: string;               /* suffix chip (ms, s, Hz) — reserved, no caller yet */
  variants?: () => string[];   /* enum boxes: what the picker lists */
}

export interface BoxSpec {
  key: string;                 /* reconciler bind identity */
  read(): string;              /* authored expression text — the document truth */
  commit(text: string): void;  /* stored as typed even if it won't compile */
  /* what an empty box means: the placeholder shows the effective default either way */
  emptyMeans: "default" | "unset";
  placeholder?: string;
  title?: string;              /* the row's note rides the input's tooltip */
  type: BoxType;
  scope: Scope;
}

/* the type glyph per shape; color paints a swatch instead */
const SHAPE_GLYPH: Record<string, string> = {
  num: "hash",
  text: "type",
  enum: "chevrons-up-down",
  align: "grid-3x3",
  list: "brackets",
  map: "braces",
};

const DIM_HINT = "an expression stands here — the icon acts only on a plain literal";

/* a quoted literal's inner text; anything unquoted comes back as-is */
function stripQuotes(text: string): string {
  const t = text.trim();
  if (t.length >= 2 && (t[0] === "'" || t[0] === '"') && t[t.length - 1] === t[0])
    return t.slice(1, -1);
  return t;
}

/* ONE RULE, every tier: the value box's text is EXPRESSION TEXT, and an enum variant's
 * expression spelling is the quoted string literal — a bare word is an unknown name to
 * both compilers that read these surfaces (template_expr for attrs, the scalar compiler
 * for slots; every built-in authors align: 'center'). The old attr-only special case
 * generalized rather than accreting per tier. */
function spellVariant(variant: string): string {
  return "'" + variant + "'";
}

/* the change event that runs commitInput's own commit; the test shim's elements carry
 * no event machinery, so the direct call stands in there */
function fireChange(input: HTMLInputElement, commit: (text: string) => void): void {
  if (typeof input.dispatchEvent === "function")
    input.dispatchEvent(new Event("change", { bubbles: true }));
  else commit(input.value);
}

/* ---- the browse popover: the Scope's names, searchable, inserting at the caret ----
 *
 * A scope serving roots() gets the source-tree experience — folders over path-spelled
 * entity names, entities opening into field rows, variables under their own root —
 * searching flattens to the leaves. A flat-name scope keeps the flat list. Either way
 * a pick INSERTS the canonical spelling at the caret; it is never a mode switch. */

let browseShell: Shell | null = null;
/* expansion state, shared across boxes and openings; the roots start open */
const browseExpanded = new Set<string>(["hmi", "hmi/local", "hmi/global", "dart", "enums",
                                        "flow"]);

function ensureBrowse(): Shell {
  return (browseShell ??= makeShell({
    id: "vbrowse",
    boxClass: "stree-pop",
    dismiss: "backdrop",
    contextDismiss: "anywhere",
    wheel: "passive",
  }));
}

function openBrowse(anchor: HTMLElement, input: HTMLInputElement, scope: Scope): void {
  /* the caret is recorded BEFORE the popover takes focus: insert replaces the
     selection of a focused box, and appends when the box was left alone */
  const focused = typeof document !== "undefined" && document.activeElement === input;
  const start = focused ? input.selectionStart ?? input.value.length : null;
  const end = focused ? input.selectionEnd ?? input.value.length : null;

  const insert = (label: string) => {
    const value = input.value;
    const at = start === null || value === "" ? value.length : start;
    const to = end === null || value === "" ? value.length : end;
    input.value = value.slice(0, at) + label + value.slice(to);
    const after = at + label.length;
    input.focus();
    input.setSelectionRange?.(after, after);
    /* the reconciler must treat this as typing (pending text, not yet the document);
       the muted dispatch is the autocomplete's own accept idiom */
    announceInput(input);
  };

  const sh = ensureBrowse();
  sh.box.innerHTML = "";

  const trail = (note?: string, shape?: string) => [
    note ? el("span", { class: "stree-local", text: note }) : null,
    shape ? el("span", { class: "stree-shape", text: shape }) : null,
  ];
  const pick = (text: string) => () => {
    sh.close();
    insert(text);
  };

  /* the hierarchy, flattened per the expansion state; searching flattens to matching
     LEAVES under their canonical spelling, the source tree's own idiom */
  const treeRows = (filter: string): StreeTreeRow[] => {
    const out: StreeTreeRow[] = [];
    const walk = (rows: BrowseRow[], depth: number) => {
      for (const row of rows) {
        const kids = row.children ?? [];
        if (filter) {
          if (row.insert !== undefined && row.insert.toLowerCase().includes(filter))
            out.push({
              depth: 0, key: row.key, label: row.insert, kind: row.kind,
              icon: row.icon ?? (row.kind ? undefined : "variable"),
              expandable: false, onPick: pick(row.insert),
              trail: trail(row.note, row.shape),
            });
          walk(kids, 0);
          continue;
        }
        out.push({
          depth, key: row.key, label: row.label, kind: row.kind,
          icon: row.icon ?? (kids.length ? "folder" : "variable"),
          expandable: kids.length > 0,
          onPick: row.insert !== undefined ? pick(row.insert) : undefined,
          trail: trail(row.note, row.shape),
        });
        if (kids.length && browseExpanded.has(row.key)) walk(kids, depth + 1);
      }
    };
    walk(scope.roots?.() ?? [], 0);
    return out;
  };

  const flatRows = (filter: string): StreeTreeRow[] => {
    const rows: StreeTreeRow[] = [];
    /* x leads where the surface has a pipeline register — the same special row the
       autocomplete dropdown serves, so the two can never disagree */
    if (scope.x && (!filter || "x".includes(filter)))
      rows.push({
        depth: 0, key: "x", label: "x", expandable: false,
        onPick: pick("x"), trail: trail(undefined, scope.x()?.shape ?? ""),
      });
    for (const row of scope.names()) {
      if (filter && !row.label.toLowerCase().includes(filter)) continue;
      rows.push({
        depth: 0,
        key: row.label,
        label: row.label,
        expandable: false,
        onPick: pick(row.label),
        trail: trail(row.note, row.shape),
      });
    }
    return rows;
  };

  const tree = streeTree({
    placeholder: "search",
    expanded: browseExpanded,
    defaultIcon: "variable",
    rows: (filter) => (scope.roots ? treeRows(filter) : flatRows(filter)),
  });
  sh.box.appendChild(tree.search);
  sh.box.appendChild(tree.list);
  tree.render();
  sh.openUnder(anchor, { fallbackW: 264, minW: 264, fallbackH: 240, clampFlip: true });
  tree.search.focus?.();
}

/* ---- the number scrub, on the icon only: the field itself stays purely textual ----
 *
 * 1 step per horizontal px, Shift a tenth-step (switchable mid-drag), 4px of click
 * slop. The text updates live so the underlay and the icon track the drag, but the
 * COMMIT fires once, on release — the canvas gesture rule, not an op per pixel.
 * Escape mid-drag cancels and puts the original text back. */
function attachIconScrub(
  icon: HTMLElement,
  input: HTMLInputElement,
  spec: BoxSpec,
  literalNow: () => boolean,
): void {
  const step = spec.type.step || 1;
  let pointer = -1;
  let moved = false;
  let travel = 0;
  let lastX = 0;
  let acc = 0;
  let startAt = 0;
  let original = "";
  const decimalsOf = (s: number) => (String(s).split(".")[1] ?? "").length;

  const seed = () => {
    const held = Number(input.value);
    if (input.value.trim() !== "" && Number.isFinite(held)) return held;
    const dflt = Number(spec.placeholder ?? "");
    return Number.isFinite(dflt) ? dflt : 0;
  };

  const done = (cancel: boolean) => {
    if (pointer === -1) return;
    pointer = -1;
    window.removeEventListener("keydown", onKey, true);
    if (!moved) {
      /* the click whose default was swallowed: focus and select for typing */
      input.focus();
      input.select?.();
      return;
    }
    if (cancel) {
      input.value = original;
      announceInput(input);
      return;
    }
    fireChange(input, spec.commit);
  };

  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopPropagation();
    done(true);
  };

  icon.addEventListener("pointerdown", (ev: PointerEvent) => {
    if (ev.button !== 0 || !literalNow()) return;
    ev.preventDefault();
    pointer = ev.pointerId;
    moved = false;
    travel = 0;
    lastX = ev.clientX;
    acc = 0;
    startAt = seed();
    original = input.value;
    (icon as Element & { setPointerCapture?: (id: number) => void })
      .setPointerCapture?.(ev.pointerId);
    window.addEventListener("keydown", onKey, true);
  });
  icon.addEventListener("pointermove", (ev: PointerEvent) => {
    if (ev.pointerId !== pointer) return;
    const dx = ev.clientX - lastX;
    lastX = ev.clientX;
    if (!moved) {
      travel += Math.abs(dx);
      if (travel < 4) return;   /* click slop: below it this is still a click */
      moved = true;
    }
    const grain = ev.shiftKey ? step / 10 : step;
    acc += dx * grain;
    const decimals = Math.min(6, decimalsOf(grain));
    const next = Number((startAt + Math.round(acc / grain) * grain).toFixed(decimals));
    if (String(next) !== input.value) {
      input.value = String(next);
      announceInput(input);   /* live text, held as pending — the commit waits */
    }
  });
  icon.addEventListener("pointerup", (ev: PointerEvent) => {
    if (ev.pointerId === pointer) done(false);
  });
  icon.addEventListener("pointercancel", (ev: PointerEvent) => {
    if (ev.pointerId === pointer) done(true);
  });
}

/* ---- the box ---- */

export function valueBox(spec: BoxSpec): HTMLElement {
  const shape = spec.type.shape;
  const input = commitInput(spec.read(), spec.commit, {
    class: "field grow",
    spellcheck: "false",
    placeholder: spec.placeholder ?? "",
    title: spec.title,
  });
  bindField(spec.key, input, spec.read);
  attachAutocomplete(input, spec.scope);

  const icon = el("button", { class: "vb-icon", tabindex: "-1" });
  const swatch = shape === "color" ? el("span", { class: "vb-swatch" }) : null;
  if (swatch) icon.appendChild(swatch);

  /* what the picker would write over: the authored text, or — empty meaning the
     default — the effective default the placeholder shows */
  const shownText = () => {
    const text = input.value.trim();
    if (text) return text;
    return spec.emptyMeans === "default" ? (spec.placeholder ?? "").trim() : "";
  };

  const variants = () => spec.type.variants?.() ?? [];

  /* is the current text a literal of this box's shape? Empty passes: an unset field is
     what direct gestures write literals into (the canvas already works this way). */
  const literalNow = (): boolean => {
    const text = input.value.trim();
    if (text === "") return true;
    switch (shape) {
      case "num": return Number.isFinite(Number(text));
      case "bool": return text === "true" || text === "false";
      case "enum": return variants().includes(stripQuotes(text));
      case "align": return ALIGN_POSITIONS.includes(stripQuotes(text));
      case "color": return literalColor(text) !== null;
      default: return true;   /* text and the aggregates: no gesture to gate */
    }
  };

  /* a color literal's paintable form: hex as itself, a token through the scope's
     resolver — never a stale color for anything else */
  const literalColor = (text: string): string | null => {
    if (parseHex(text)) return text;
    const tokens = spec.scope.tokens?.() ?? null;
    if (tokens && text.startsWith("$") &&
        tokens.list().some((t) => "$" + t.name === text))
      return tokens.resolve(text);
    return null;
  };

  const write = (text: string) => {
    input.value = text;
    fireChange(input, spec.commit);
    paint();
  };

  /* ---- the pickers the icon opens ---- */

  const openEnum = () => {
    const rows = variants();
    if (!rows.length) return;
    const rect = icon.getBoundingClientRect();
    const current = stripQuotes(shownText());
    openMenu(rect.left, rect.bottom + 4, "", rows.map((v) => ({
      label: v,
      icon: v === current ? "check" : undefined,
      run: () => write(spellVariant(v)),
    })));
  };

  const openAlign = () => {
    const rect = icon.getBoundingClientRect();
    const grid = alignGrid(stripQuotes(shownText()) || "center", (pos) => {
      write(spellVariant(pos));
      closeMenu();
    });
    openMenu(rect.left, rect.bottom + 4, "", [
      { node: el("div", { class: "menu-align" }, [grid]) },
    ]);
  };

  const openColor = () => {
    const tokens = spec.scope.tokens?.() ?? null;
    const seedFrom = shownText();
    const seed = literalColor(seedFrom) ?? "#000000";
    openColorPicker(icon, seed, (picked) => write(picked), tokens,
                    () => input.value.trim());
  };

  const openPicker =
    shape === "enum" ? openEnum
    : shape === "align" ? openAlign
    : shape === "color" ? openColor
    : null;

  /* ---- the icon's face: repainted per keystroke and per document echo ----
   *
   * COMPARE BEFORE WRITE, always: this rides a bind lane that runs on EVERY sync pass,
   * so live data streaming would otherwise rebuild every icon's SVG every frame — and
   * an innerHTML swap mid-press destroys the element under the pointer, which is a
   * dead click. The identity-stable law extends to the inspector: zero element
   * creation at steady state; only a glyph that actually changed touches the DOM. */

  let shownGlyph: string | null = null;
  let shownTitle: string | null = null;
  let shownSwatch = "";
  const face = (glyph: string | null, size: number, title: string) => {
    if (glyph !== null && glyph !== shownGlyph) {
      shownGlyph = glyph;
      icon.innerHTML = iconMarkup(glyph, size, 1.7);
    }
    if (title !== shownTitle) {
      shownTitle = title;
      icon.title = title;
    }
  };

  const paint = () => {
    const text = input.value.trim();
    const literal = literalNow();
    icon.classList.toggle("vb-dim", !literal);
    switch (shape) {
      case "num":
        icon.classList.toggle("vb-scrub", literal);
        face("hash", 11, literal
          ? "drag to scrub — Shift is fine-grained; click to edit the text"
          : DIM_HINT);
        break;
      case "bool": {
        const shown = text || (spec.emptyMeans === "default" ? spec.placeholder ?? "" : "");
        face(shown === "true" ? "toggle-right" : "toggle-left", 12,
             literal ? "click to flip" : DIM_HINT);
        break;
      }
      case "color": {
        const hex = literalColor(shownText());
        const token = shownText().startsWith("$");
        const key = (hex ?? "?") + (token ? "$" : "");
        if (swatch && key !== shownSwatch) {
          shownSwatch = key;
          const parsed = hex ? parseHex(hex) : null;
          if (parsed) {
            paintSwatch(swatch, parsed);
            swatch.classList.remove("vb-unknown");
          } else {
            /* an expression never paints a stale color: the unknown treatment */
            swatch.style.background = "";
            swatch.classList.add("vb-unknown");
          }
          swatch.classList.toggle("token", token);
        }
        face(null, 0, "pick a color");
        break;
      }
      case "enum":
        face(SHAPE_GLYPH.enum, 11, "pick a variant");
        break;
      case "align":
        face(SHAPE_GLYPH.align, 11, "pick a position");
        break;
      default:
        face(SHAPE_GLYPH[shape] ?? "type", 11, spec.title ?? "");
        break;
    }
  };
  paint();
  input.addEventListener("input", paint);
  /* echoes repaint through the same bind lane the field itself rides */
  bind(spec.key + ".icon", icon, paint);

  if (shape === "num") attachIconScrub(icon, input, spec, literalNow);

  icon.addEventListener("click", () => {
    if (openPicker) {
      openPicker();
      return;
    }
    if (shape === "bool") {
      const text = input.value.trim();
      if (text === "true") write("false");
      else if (text === "false" || text === "") write("true");
      /* an expression: nothing — the dim state already says why */
      return;
    }
    if (shape !== "num") {
      /* text and the aggregates: the icon is a handle to the text itself */
      input.focus();
      input.select?.();
    }
    /* num's click is replayed by the scrub's own no-move path */
  });

  /* keyboard access to the icon: Alt+Down from the text opens the literal picker */
  if (openPicker)
    input.addEventListener("keydown", (ev: KeyboardEvent) => {
      if (ev.altKey && ev.key === "ArrowDown") {
        ev.preventDefault();
        openPicker();
      }
    });

  /* the browse button hides by absence: a scope with no names has nothing to insert */
  const browse = (spec.scope.roots ? spec.scope.roots().length : spec.scope.names().length)
    ? el("button", {
        class: "vb-browse",
        title: "insert a reference",
        tabindex: "-1",
        html: iconMarkup("braces", 10, 1.7),
      })
    : null;
  /* pointerdown would blur the input and lose the caret the insert needs */
  browse?.addEventListener("pointerdown", (ev) => ev.preventDefault());
  browse?.addEventListener("click", () => openBrowse(browse, input, spec.scope));

  return el("span", { class: "value-box vb-" + shape }, [
    icon,
    highlighted(input),
    spec.type.unit ? el("span", { class: "vb-unit", text: spec.type.unit }) : null,
    browse,
  ]);
}

/* dom.ts owns the grid control; the box only needs to know the legal spellings to
 * gate the align gesture — the same nine the grid writes */
const ALIGN_POSITIONS = [
  "top-left", "top", "top-right",
  "left", "center", "right",
  "bottom-left", "bottom", "bottom-right",
];
