// A property field: an expression box with a lead on its left that acts on the value. A number's
// lead scrubs it, a colour's shows it and opens a picker, a choice's lists the options. A
// gesture acts only on a plain literal, so it never overwrites code, while a pick from a list
// is asked for and replaces it.

import { createContext, createMemo, createSignal, For, type JSX, Match, Show, Switch, useContext } from "solid-js";
import { isConstant, isNumber, isPercent, pageScope, percentOf, resolve, type Scope, sizeWord, tokenValue } from "../../state/bind";
import { complete, type Place, signature, type Suggestion } from "../../state/complete";
import { capital } from "../../state/format";
import { state } from "../../state/store";
import { ColourPicker, parseColour } from "../../ui/ColourPicker";
import { DraftInput } from "../../ui/DraftInput";
import { Activity, Braces, ChevronsUpDown, Copy, Grid3x3, Hash, Link, Minus, Plus, RotateCcw, SquareDashed, SquareRoundCorner, ToggleLeft, ToggleRight, Type, X } from "../../ui/icons";
import { copyText, openMenu } from "../../ui/Menu";
import { Popover } from "../../ui/Popover";
import { follow } from "../../ui/press";
import { fingered } from "../../ui/touch";
import { Choice } from "../../ui/Choice";
import { EASES, type Motion, motionOf, transitions, withMotion } from "./motion";

/** Where the fields stand: the names their code reads, and what completion offers instead
 *  of the mesh imports, as a component offers its own names. */
export interface Where {
  scope: Scope;
  names?: Suggestion[];
  /** Where a handler here runs. */
  place: Place;
  /** Names it reads besides, as a repeat's `index` and `item`. */
  also?: Suggestion[];
}

export const WhereContext = createContext<() => Where>((): Where => ({ scope: pageScope, place: "handler" }));

/** What a field holds, which says what its lead does. */
export type Kind = "number" | "colour" | "choice" | "point" | "flag" | "text" | "any";

/** The kind a value's text is now, for fields whose kind comes from what they hold. */
export function kindOf(text: string): Kind {
  const t = text.trim();
  if (isNumber(t)) return "number";
  if (/^#[0-9a-f]{3,8}$/i.test(t)) return "colour";
  // a token is what it works out to
  const token = state.tokens.find((k) => `$${k.name}` === t);
  if (token) {
    try {
      const v = tokenValue(token);
      return typeof v === "number" ? "number" : typeof v === "string" && CSS.supports("color", v) ? "colour" : "any";
    } catch {
      return "any";
    }
  }
  if (t === "true" || t === "false") return "flag";
  if (/^"(?:[^"\\]|\\.)*"$/.test(t)) return "text";
  return "any";
}

/** A field whose changes may animate: the CSS property it is, and the element's transition. */
export interface Moving {
  property: string;
  transition: string;
  write: (text: string | null) => void;
}

export interface FieldProps {
  label: string;
  value: string;
  /** Keeps a value, null to clear it. */
  onWrite: (text: string | null) => void;
  /** Shows a value at once while a gesture runs, before it lets go. */
  onShow?: (text: string) => void;
  kind?: Kind;
  /** A choice's options, as expressions: `"left"`, `600`. */
  options?: string[];
  min?: number;
  max?: number;
  /** How much one pixel of scrub or one press of a stepper moves a number. */
  step?: number;
  placeholder?: string;
  /** Plain text, never an expression. */
  plain?: boolean;
  /** The label sits in the box as its lead, as placement's x and y do. */
  inside?: boolean;
  /** Placement: a trailing % is a share of what holds the element. */
  percent?: boolean;
  focus?: number;
  /** Why a value the code gives would not show, as CSS the browser drops, or nothing. */
  check?: (value: unknown) => string | undefined;
  /** A lead of its own: its icon, its title and what a click on it does, given the lead, else
   *  what any does, while a drag on it still scrubs a number. */
  lead?: { icon: JSX.Element; title: string; onClick?: (lead: HTMLElement) => void };
  /** How its changes animate, set from its menu and shown by a mark beside it. */
  motion?: Moving;
}

/** One property, an expression unless `plain`. Under it, what stops it showing, and for
 *  words that fail for want of quotes, a way to make them text. */
export function Field(p: FieldProps) {
  const where = useContext(WhereContext);
  const write = (t: string) => p.onWrite(t.trim() === "" ? null : t);
  // placement's own words, as a trailing % is, never an expression
  const word = () => !!p.percent && (isPercent(p.value) || !!sizeWord(p.value));
  const status = createMemo(() => {
    if (p.plain || (p.percent && sizeWord(p.value))) return undefined;
    const r = resolve(p.percent ? percentOf(p.value).expr : p.value, where().scope);
    if (r.ok) {
      const bad = r.value !== undefined && r.value !== null && r.value !== "" ? p.check?.(r.value) : undefined;
      return bad ? { text: bad } : undefined;
    }
    if (r.unknown) return { text: `${r.unknown} is unknown right now` };
    return { text: r.error, words: !/["'`]/.test(p.value) };
  });
  // how its changes animate, none where code works the transition out
  const [moving, setMoving] = createSignal(false);
  const list = () => (p.motion ? transitions(p.motion.transition) : null);
  const motion = () => {
    const l = list();
    return p.motion && l ? motionOf(l, p.motion.property) : undefined;
  };
  const animate = (m: Motion | null) => p.motion?.write(withMotion(list() ?? [], p.motion.property, m));
  const mark = () => (
    <Show when={motion()}>
      {(m) => (
        <button type="button" class="motion-mark" title={`Changes take ${m().ms} ms. Click to change how`} onClick={() => setMoving(!moving())}>
          <Activity size={11} />
        </button>
      )}
    </Show>
  );
  let host!: HTMLDivElement;
  return (
    <div
      ref={host}
      class="field"
      classList={{ bound: !p.plain && !isConstant(p.value) && !word(), inside: p.inside }}
      onContextMenu={(e) => {
        // in the text, the text's own menu opens instead, and a held stepper is no press for a menu
        if ((e.target as HTMLElement).closest("input, textarea, .steps")) return;
        openMenu(e, [
          { label: "Reset to default", icon: <RotateCcw size={13} />, disabled: p.value.trim() === "", run: () => write("") },
          { label: "Copy the value", icon: <Copy size={13} />, disabled: p.value.trim() === "", run: () => copyText(p.value) },
          ...(p.motion
            ? [
                {
                  label: motion() ? "Change how it animates" : "Animate changes",
                  icon: <Activity size={13} />,
                  // a transition code works out is changed in code
                  disabled: list() === null,
                  run: () => {
                    if (!motion()) animate({ ms: 300, ease: "ease" });
                    setMoving(true);
                  },
                },
              ]
            : []),
        ]);
      }}
    >
      <Show when={!p.inside}>
        <label>
          {p.label}
          {mark()}
        </label>
      </Show>
      <ValueBox {...p} onWrite={write} />
      <Show when={p.inside}>{mark()}</Show>
      <Show when={moving() && motion()}>
        {(m) => (
          <Popover anchor={host} onClose={() => setMoving(false)} class="parts motion">
            <div class="field">
              <label>Time, ms</label>
              <span class="vbox">
                <DraftInput value={String(m().ms)} accept={(t) => /^\d+$/.test(t.trim())} onCommit={(t) => animate({ ms: Number(t), ease: m().ease })} />
              </span>
            </div>
            <div class="field">
              <label>Ease</label>
              <Choice options={EASES} value={m().ease} onPick={(ease) => animate({ ms: m().ms, ease })} />
            </div>
            <button
              class="ghost"
              onClick={() => {
                setMoving(false);
                animate(null);
              }}
            >
              <X size={13} />
              Stop animating
            </button>
          </Popover>
        )}
      </Show>
      <Show when={status()}>
        {(s) => (
          <span class="field-note">
            {s().text}
            <Show when={s().words}>
              <br />
              Text goes in quotes.{" "}
              <button class="field-fix" onClick={() => write(JSON.stringify(p.value.trim()))}>
                Make it text
              </button>
            </Show>
          </span>
        )}
      </Show>
    </div>
  );
}

/** The editor with its lead, as one box. */
function ValueBox(p: Omit<FieldProps, "onWrite"> & { onWrite: (text: string) => void }) {
  const where = useContext(WhereContext);
  let box!: HTMLSpanElement;
  const field = () => box.querySelector<HTMLInputElement>("input")!;
  const steps = () => fingered && !p.plain && plainNumber(p);
  return (
    <span class="vbox" classList={{ "has-lead": !p.plain, "has-steps": steps() }} ref={box}>
      <DraftInput
        value={p.value}
        placeholder={p.placeholder}
        focus={p.focus}
        onCommit={p.onWrite}
        complete={p.plain ? undefined : (t, c) => complete(t, c, "expression", where().names, where().also)}
        hint={p.plain ? undefined : (t, c) => signature(t, c, "expression")}
      />
      <Show when={!p.plain}>
        <Lead {...p} field={field} />
      </Show>
      <Show when={steps()}>
        <Steps {...p} />
      </Show>
    </span>
  );
}

const clamp = (n: number, min = -Infinity, max = Infinity) => Math.min(max, Math.max(min, n));

/** Decimals enough to show a step. */
const decimals = (step: number) => (String(step).split(".")[1] ?? "").length;

/** Whether a number field holds a plain number, which a gesture may change, never code. */
const plainNumber = (p: { kind?: Kind; value: string; percent?: boolean }) => p.kind === "number" && (p.value.trim() === "" || isNumber(p.value) || (!!p.percent && isPercent(p.value)));

/** The number a plain number field shows, its placeholder while it is empty. */
const numberIn = (p: { value: string; placeholder?: string }) => Number(percentOf(p.value).expr?.trim() || p.placeholder || 0) || 0;

/** A finger's - and + on a plain number: a tap steps it once, a hold steps on until let go, and a
 *  drag that scrolls the list away leaves it be. */
function Steps(p: Omit<FieldProps, "onWrite"> & { onWrite: (text: string) => void }) {
  const step = () => p.step ?? 1;
  const text = (n: number) => String(Number(n.toFixed(decimals(step()) + 1))) + (p.percent && isPercent(p.value) ? "%" : "");
  const next = (from: number, by: number) => clamp(from + by * step(), p.min, p.max);
  let held = false;
  const hold = (by: number) => (e: PointerEvent) => {
    held = false;
    const original = p.value;
    let at = numberIn(p);
    let timer = setTimeout(function again() {
      held = true;
      at = next(at, by);
      p.onShow?.(text(at));
      timer = setTimeout(again, 80);
    }, 400);
    follow(e, {
      end: (u) => {
        clearTimeout(timer);
        if (held && u?.type === "pointerup") p.onWrite(text(at));
        else if (held) p.onShow?.(original);
      },
    });
  };
  // a hold's release still clicks, and that click steps no further
  const tap = (by: number) => () => {
    if (!held) p.onWrite(text(next(numberIn(p), by)));
    held = false;
  };
  return (
    <span class="steps">
      <button type="button" tabIndex={-1} title="Less" onPointerDown={hold(-1)} onClick={tap(-1)}>
        <Minus size={14} />
      </button>
      <button type="button" tabIndex={-1} title="More" onPointerDown={hold(1)} onClick={tap(1)}>
        <Plus size={14} />
      </button>
    </span>
  );
}

/** The words a choice shows for an option: its text without quotes. */
const word = (option: string) => option.replace(/^"(.*)"$/, "$1");

function Lead(p: Omit<FieldProps, "onWrite"> & { onWrite: (text: string) => void; field: () => HTMLInputElement }) {
  const where = useContext(WhereContext);
  const kind = () => p.kind ?? "any";
  const percent = () => !!p.percent && isPercent(p.value);
  const literal = () => p.value.trim() === "" || isConstant(p.value) || percent() || (!!p.percent && !!sizeWord(p.value));
  const scrubs = () => plainNumber(p);
  const [opened, setOpened] = createSignal(false);
  let lead!: HTMLButtonElement;
  // what the value draws now, for a swatch
  const shown = createMemo(() => {
    const r = resolve(p.value || p.placeholder, where().scope);
    return r.ok && r.value !== undefined && r.value !== null ? String(r.value) : "";
  });
  const focusText = () => {
    p.field().focus();
    p.field().select();
  };
  // a number that scrubs takes its click when the drag ends without moving
  const click = () => {
    if (scrubs()) return;
    if (p.lead?.onClick) p.lead.onClick(lead);
    else if (kind() === "colour" || kind() === "choice" || kind() === "point") setOpened(!opened());
    else if (kind() === "flag" && literal()) p.onWrite(p.value.trim() === "true" ? "false" : "true");
    else focusText();
  };
  // a drag along the lead scrubs a plain number, a step a pixel, a tenth of one with Shift
  const down = (e: PointerEvent) => {
    if (e.button !== 0 || !scrubs()) return;
    e.preventDefault();
    lead.setPointerCapture(e.pointerId);
    const unit = percent() ? "%" : "";
    const from = numberIn(p);
    const original = p.value;
    const step = p.step ?? 1;
    let [travel, moved, last, at] = [0, false, e.clientX, from];
    const move = (m: PointerEvent) => {
      const dx = m.clientX - last;
      last = m.clientX;
      travel += Math.abs(dx);
      if (!moved && travel < 3) return;
      moved = true;
      const grain = m.shiftKey ? step / 10 : step;
      at = clamp(at + dx * grain, p.min, p.max);
      p.onShow?.(String(Number(at.toFixed(decimals(grain)))) + unit);
    };
    const up = () => {
      window.removeEventListener("keydown", cancel, true);
      if (moved) p.onWrite(String(Number(at.toFixed(decimals(step) + 1))) + unit);
      else if (travel < 3) p.lead?.onClick ? p.lead.onClick(lead) : focusText();
    };
    const stop = follow(e, { move, end: up });
    const cancel = (k: KeyboardEvent) => {
      if (k.key !== "Escape") return;
      k.preventDefault();
      k.stopPropagation();
      stop();
      window.removeEventListener("keydown", cancel, true);
      p.onShow?.(original);
      lead.releasePointerCapture(e.pointerId);
    };
    window.addEventListener("keydown", cancel, true);
  };
  const title = () => {
    if (p.lead) return p.lead.title;
    if (kind() === "number") return scrubs() ? "Drag to change it, Shift for finer steps" : "An expression gives it, so a drag leaves it be";
    if (kind() === "colour") return "Pick a colour";
    if (kind() === "choice") return "Pick one";
    if (kind() === "point") return "Pick a point of its box";
    if (kind() === "flag") return literal() ? "Click to flip it" : "An expression gives it";
    return undefined;
  };
  // the tokens that work out to a colour, in the screen's mode
  const tokens = () =>
    state.tokens.flatMap((t) => {
      try {
        const v = tokenValue(t);
        return typeof v === "string" && CSS.supports("color", v) ? [{ name: t.name, colour: v }] : [];
      } catch {
        return [];
      }
    });
  return (
    <>
      <button
        ref={lead}
        type="button"
        tabIndex={-1}
        class="lead"
        classList={{ scrub: scrubs(), linked: !literal() && kind() !== "colour", inside: p.inside }}
        title={title()}
        aria-label={p.inside ? p.label : undefined}
        onPointerDown={down}
        onClick={click}
      >
        <Switch fallback={<Braces size={12} />}>
          <Match when={p.inside}>{p.lead?.icon ?? p.label}</Match>
          <Match when={kind() === "colour"}>
            <span class="swatch lead-swatch" classList={{ none: !parseColour(shown()) && shown() !== "none", empty: shown() === "none" }}>
              <Show when={parseColour(shown())}>
                <i style={{ background: shown() }} />
              </Show>
            </span>
          </Match>
          <Match when={!literal()}>
            <Link size={12} />
          </Match>
          <Match when={kind() === "number"}>{p.lead?.icon ?? <Hash size={12} />}</Match>
          <Match when={kind() === "choice"}>
            <ChevronsUpDown size={12} />
          </Match>
          <Match when={kind() === "point"}>
            <Grid3x3 size={12} />
          </Match>
          <Match when={kind() === "flag"}>{p.value.trim() === "true" ? <ToggleRight size={13} /> : <ToggleLeft size={13} />}</Match>
          <Match when={kind() === "text"}>
            <Type size={12} />
          </Match>
        </Switch>
      </button>
      <Show when={opened()}>
        <Popover anchor={lead} onClose={() => setOpened(false)} class={kind() === "choice" ? "choice-list" : undefined}>
          <Switch>
            <Match when={kind() === "colour"}>
              <ColourPicker
                value={shown()}
                tokens={tokens()}
                onShow={(t) => p.onShow?.(t)}
                onPick={(t) => {
                  p.onWrite(t);
                  if (t.startsWith("$")) setOpened(false);
                }}
              />
            </Match>
            <Match when={kind() === "point"}>
              <Points
                values={p.options ?? []}
                on={p.value.trim() || p.placeholder}
                pick={(v) => {
                  setOpened(false);
                  p.onWrite(v);
                }}
              />
            </Match>
            <Match when={kind() === "choice"}>
              <For each={p.options}>
                {(o) => (
                  <button
                    class="menu-item"
                    classList={{ on: o === p.value.trim() }}
                    onClick={() => {
                      setOpened(false);
                      p.onWrite(o);
                    }}
                  >
                    <span class="mono">{word(o)}</span>
                  </button>
                )}
              </For>
            </Match>
          </Switch>
        </Popover>
      </Show>
    </>
  );
}

/** The nine points of a box, row by row, as words. */
export const POINTS = ["top left", "top center", "top right", "center left", "center", "center right", "bottom left", "bottom center", "bottom right"];

/** Nine points of a box, three by three, each one of `values` in the order of POINTS. */
export function Points(p: { values: string[]; on: string | undefined; pick: (value: string) => void }) {
  return (
    <div class="points">
      <For each={p.values}>
        {(v, i) => (
          <button class="point" classList={{ on: v === p.on?.trim() }} title={capital(POINTS[i()])} onClick={() => p.pick(v)}>
            <i />
          </button>
        )}
      </For>
    </div>
  );
}

/** The parts of a border, each its own property and expression, so one may be bound alone. */
const BORDER: [string, string, Kind, Partial<FieldProps>][] = [
  ["Width", "border-width", "number", { min: 0, step: 0.1, placeholder: "0.1" }],
  ["Style", "border-style", "choice", { options: ['"solid"', '"dashed"', '"dotted"', '"double"', '"none"'], placeholder: '"solid"' }],
  ["Colour", "border-color", "colour", { placeholder: "#3a4046" }],
];

/** A border as one row: its parts in words, and a picture of it whose click opens a panel with
 *  a field per part. A first part written fills the width and style it needs to show. */
export function BorderField(p: { props: Record<string, string | undefined>; write: (props: Record<string, string | null>) => void; show: (props: Record<string, string>) => void }) {
  const where = useContext(WhereContext);
  const [opened, setOpened] = createSignal(false);
  let row!: HTMLSpanElement;
  const part = (key: string) => p.props[key] ?? "";
  const any = () => BORDER.some(([, key]) => part(key) !== "");
  const now = (key: string, fallback: string) => {
    const r = resolve(part(key) || fallback, where().scope);
    return r.ok && r.value !== undefined && r.value !== null ? String(r.value) : fallback;
  };
  const write = (key: string, text: string | null) => {
    const props: Record<string, string | null> = { [key]: text };
    if (text !== null && !part("border-width") && key !== "border-width") props["border-width"] = "0.1";
    if (text !== null && !part("border-style") && key !== "border-style") props["border-style"] = '"solid"';
    p.write(props);
  };
  return (
    <div class="field" classList={{ bound: BORDER.some(([, key]) => !isConstant(part(key))) }}>
      <label>Border</label>
      <span ref={row} class="vbox has-lead">
        <span class="editor border-sum">
          <Show when={any()} fallback={<span class="faint">None</span>}>
            <For each={BORDER}>{([, key]) => <span classList={{ linked: !isConstant(part(key)) }}>{word(part(key)) || "-"}</span>}</For>
          </Show>
        </span>
        <button type="button" class="lead" title="Edit the border" onClick={() => setOpened(!opened())}>
          <span
            class="border-look"
            classList={{ none: !any() }}
            style={{
              "border-width": `${Math.min(3, Number(now("border-width", "0")) || 0)}px`,
              "border-style": now("border-style", "none"),
              "border-color": now("border-color", "currentColor"),
            }}
          />
        </button>
        <Show when={any()}>
          <button class="icon-btn tail" title="No border" onClick={() => p.write(Object.fromEntries(BORDER.map(([, key]) => [key, null])))}>
            <X size={12} />
          </button>
        </Show>
      </span>
      <Show when={opened()}>
        <Popover anchor={row} onClose={() => setOpened(false)} class="parts">
          <For each={BORDER}>
            {([label, key, kind, more]) => (
              <Field label={label} kind={kind} {...more} value={part(key)} onWrite={(t) => write(key, t)} onShow={(t) => p.show({ [key]: t })} />
            )}
          </For>
        </Popover>
      </Show>
    </div>
  );
}

/** A property CSS also writes in parts, as the radius per corner or the padding per side: its
 *  label, the property for all, each part's label and property in CSS's order, and its icon. */
interface Parts {
  label: string;
  all: string;
  parts: [string, string][];
  icon: () => JSX.Element;
  /** What the parts are, as the field's titles say: "corner", "side". */
  each: string;
  /** The parts are corners, shown two by two where each sits. */
  corners?: boolean;
}

/** Each corner in CSS's order: its cell two by two, and how far the corner icon turns to it. */
const CORNERS = [
  { cell: 1, turn: -90 },
  { cell: 2, turn: 0 },
  { cell: 4, turn: 90 },
  { cell: 3, turn: 180 },
];

export const RADIUS: Parts = {
  label: "Radius",
  all: "border-radius",
  parts: [
    ["Top left", "border-top-left-radius"],
    ["Top right", "border-top-right-radius"],
    ["Bottom right", "border-bottom-right-radius"],
    ["Bottom left", "border-bottom-left-radius"],
  ],
  icon: () => <SquareRoundCorner size={12} />,
  each: "corner",
  corners: true,
};

export const PADDING: Parts = {
  label: "Padding",
  all: "padding",
  parts: [
    ["Top", "padding-top"],
    ["Right", "padding-right"],
    ["Bottom", "padding-bottom"],
    ["Left", "padding-left"],
  ],
  icon: () => <SquareDashed size={12} />,
  each: "side",
};

/** What a parts field writes, which More CSS leaves to it. */
export const keysOf = (f: Parts) => [f.all, ...f.parts.map(([, key]) => key)];

/** One value for all parts that scrubs from its lead, a click on which opens a field per part.
 *  Parts of their own take the place of the one for all, never sit beside it, since CSS would
 *  let whichever comes later win. */
export function PartsField(p: { of: Parts; props: Record<string, string | undefined>; write: (props: Record<string, string | null>) => void; show: (props: Record<string, string>) => void; motion?: Moving }) {
  const [opened, setOpened] = createSignal(false);
  let host!: HTMLDivElement;
  const part = (key: string) => p.props[key] ?? "";
  const own = () => p.of.parts.some(([, key]) => part(key) !== "");
  const toggle = () => setOpened(!opened());
  // a first part of its own starts the others at the one for all
  const one = (key: string, text: string | null) => {
    const props: Record<string, string | null> = { [key]: text };
    if (!own()) {
      for (const [, k] of p.of.parts) if (k !== key) props[k] = part(p.of.all) || null;
      props[p.of.all] = null;
    }
    p.write(props);
  };
  // one for all again, at the first part's
  const same = () => p.write({ [p.of.all]: part(p.of.parts[0][1]) || null, ...Object.fromEntries(p.of.parts.map(([, k]) => [k, null])) });
  return (
    <div ref={host}>
      <Show
        when={own()}
        fallback={
          <Field
            label={p.of.label}
            kind="number"
            min={0}
            step={0.1}
            placeholder="0"
            value={part(p.of.all)}
            onWrite={(t) => p.write({ [p.of.all]: t })}
            onShow={(t) => p.show({ [p.of.all]: t })}
            lead={{ icon: p.of.icon(), title: `Drag to change every ${p.of.each}, click for each one`, onClick: toggle }}
            motion={p.motion}
          />
        }
      >
        <div class="field" classList={{ bound: p.of.parts.some(([, key]) => !isConstant(part(key))) }}>
          <label>{p.of.label}</label>
          <span class="vbox has-lead">
            <span class="editor border-sum">
              <For each={p.of.parts}>{([, key]) => <span classList={{ linked: !isConstant(part(key)) }}>{part(key) || "0"}</span>}</For>
            </span>
            <button type="button" class="lead" title={`Each ${p.of.each}`} onClick={toggle}>
              {p.of.icon()}
            </button>
            <button class="icon-btn tail" title={`One ${p.of.label.toLowerCase()} for every ${p.of.each}`} onClick={same}>
              <X size={12} />
            </button>
          </span>
        </div>
      </Show>
      <Show when={opened()}>
        <Popover anchor={host} onClose={() => setOpened(false)} class={p.of.corners ? "parts corners" : "parts"}>
          <For each={p.of.parts}>
            {([label, key], i) => {
              const field = {
                label,
                kind: "number" as const,
                min: 0,
                step: 0.1,
                get placeholder() {
                  return part(p.of.all) || "0";
                },
                get value() {
                  return part(key);
                },
                onWrite: (t: string | null) => one(key, t),
                onShow: (t: string) => p.show({ [key]: t }),
              };
              if (!p.of.corners) return <Field {...field} />;
              const icon = <span class="turned" style={{ rotate: `${CORNERS[i()].turn}deg` }}>{p.of.icon()}</span>;
              return (
                <div style={{ order: CORNERS[i()].cell }}>
                  <Field {...field} inside lead={{ icon, title: `${label}: drag to change it, Shift for finer steps` }} />
                </div>
              );
            }}
          </For>
        </Popover>
      </Show>
    </div>
  );
}
