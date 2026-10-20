// A property field: an expression box with a lead on its left that acts on the value. A number's
// lead scrubs it, a colour's shows it and opens a picker, a choice's lists the options. A
// gesture acts only on a plain literal, so it never overwrites code, while a pick from a list
// is asked for and replaces it.

import { createContext, createMemo, createSignal, For, Match, Show, Switch, useContext } from "solid-js";
import { isConstant, isNumber, isPercent, pageScope, percentOf, resolve, type Scope } from "../../state/bind";
import { complete, type Place, type Suggestion } from "../../state/complete";
import { mode } from "../../state/mode";
import { state } from "../../state/store";
import { ColourPicker, parseColour } from "../../ui/ColourPicker";
import { DraftInput } from "../../ui/DraftInput";
import { Braces, ChevronsUpDown, Copy, Hash, Link, RotateCcw, ToggleLeft, ToggleRight, Type, X } from "../../ui/icons";
import { copyText, openMenu } from "../../ui/Menu";
import { Popover } from "../../ui/Popover";

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
export type Kind = "number" | "colour" | "choice" | "flag" | "text" | "any";

/** The kind a value's text is now, for fields whose kind comes from what they hold. */
export function kindOf(text: string): Kind {
  const t = text.trim();
  if (isNumber(t)) return "number";
  if (/^#[0-9a-f]{3,8}$/i.test(t) || /^\$[\w]+$/.test(t)) return "colour";
  if (t === "true" || t === "false") return "flag";
  if (/^"(?:[^"\\]|\\.)*"$/.test(t)) return "text";
  return "any";
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
  /** How much one pixel of scrub moves a number. */
  step?: number;
  placeholder?: string;
  /** Plain text, never an expression. */
  plain?: boolean;
  /** The label sits in the box as its lead, as placement's x and y do. */
  inside?: boolean;
  /** Placement: a trailing % is a share of what holds the element. */
  percent?: boolean;
  focus?: number;
}

/** One property, an expression unless `plain`. Under it, what stops it showing, and for
 *  words that fail for want of quotes, a way to make them text. */
export function Field(p: FieldProps) {
  const where = useContext(WhereContext);
  const write = (t: string) => p.onWrite(t.trim() === "" ? null : t);
  const status = createMemo(() => {
    if (p.plain) return undefined;
    const r = resolve(p.percent ? percentOf(p.value).expr : p.value, where().scope);
    if (r.ok) return undefined;
    if (r.unknown) return { text: `${r.unknown} is unknown right now` };
    return { text: r.error, words: !/["'`]/.test(p.value) };
  });
  return (
    <div
      class="field"
      classList={{ bound: !p.plain && !isConstant(p.value) && !(p.percent && isPercent(p.value)), inside: p.inside }}
      onContextMenu={(e) => {
        // in the text, the text's own menu opens instead
        if ((e.target as HTMLElement).closest("input, textarea")) return;
        openMenu(e, [
          { label: "Reset to default", icon: <RotateCcw size={13} />, disabled: p.value.trim() === "", run: () => write("") },
          { label: "Copy the value", icon: <Copy size={13} />, disabled: p.value.trim() === "", run: () => copyText(p.value) },
        ]);
      }}
    >
      <Show when={!p.inside}>
        <label>{p.label}</label>
      </Show>
      <ValueBox {...p} onWrite={write} />
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
  return (
    <span class="vbox" classList={{ "has-lead": !p.plain }} ref={box}>
      <DraftInput
        value={p.value}
        placeholder={p.placeholder}
        focus={p.focus}
        onCommit={p.onWrite}
        complete={p.plain ? undefined : (t, c) => complete(t, c, "expression", where().names, where().also)}
      />
      <Show when={!p.plain}>
        <Lead {...p} field={field} />
      </Show>
    </span>
  );
}

const clamp = (n: number, min = -Infinity, max = Infinity) => Math.min(max, Math.max(min, n));

/** Decimals enough to show a step. */
const decimals = (step: number) => (String(step).split(".")[1] ?? "").length;

/** The words a choice shows for an option: its text without quotes. */
const word = (option: string) => option.replace(/^"(.*)"$/, "$1");

function Lead(p: Omit<FieldProps, "onWrite"> & { onWrite: (text: string) => void; field: () => HTMLInputElement }) {
  const where = useContext(WhereContext);
  const kind = () => p.kind ?? "any";
  const percent = () => !!p.percent && isPercent(p.value);
  const literal = () => p.value.trim() === "" || isConstant(p.value) || percent();
  const scrubs = () => kind() === "number" && (p.value.trim() === "" || isNumber(p.value) || percent());
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
    if (kind() === "colour" || kind() === "choice") setOpened(!opened());
    else if (kind() === "flag" && literal()) p.onWrite(p.value.trim() === "true" ? "false" : "true");
    else focusText();
  };
  // a drag along the lead scrubs a plain number, a step a pixel, a tenth of one with Shift
  const down = (e: PointerEvent) => {
    if (e.button !== 0 || !scrubs()) return;
    e.preventDefault();
    lead.setPointerCapture(e.pointerId);
    const unit = percent() ? "%" : "";
    const from = Number(percentOf(p.value).expr?.trim() || p.placeholder || 0) || 0;
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
    const cancel = (k: KeyboardEvent) => {
      if (k.key !== "Escape") return;
      k.preventDefault();
      k.stopPropagation();
      moved = false;
      p.onShow?.(original);
      lead.releasePointerCapture(e.pointerId);
    };
    const up = () => {
      lead.removeEventListener("pointermove", move);
      lead.removeEventListener("lostpointercapture", up);
      window.removeEventListener("keydown", cancel, true);
      if (moved) p.onWrite(String(Number(at.toFixed(decimals(step) + 1))) + unit);
      else if (travel < 3) focusText();
    };
    lead.addEventListener("pointermove", move);
    lead.addEventListener("lostpointercapture", up);
    window.addEventListener("keydown", cancel, true);
  };
  const title = () => {
    if (kind() === "number") return scrubs() ? "Drag to change it, Shift for finer steps" : "An expression gives it, so a drag leaves it be";
    if (kind() === "colour") return "Pick a colour";
    if (kind() === "choice") return "Pick one";
    if (kind() === "flag") return literal() ? "Click to flip it" : "An expression gives it";
    return undefined;
  };
  const tokens = () => state.tokens.map((t) => ({ name: t.name, colour: mode() === "light" ? t.light : t.dark }));
  return (
    <>
      <button
        ref={lead}
        type="button"
        tabIndex={-1}
        class="lead"
        classList={{ scrub: scrubs(), linked: !literal() && kind() !== "colour", inside: p.inside }}
        title={title()}
        onPointerDown={down}
        onClick={click}
      >
        <Switch fallback={<Braces size={12} />}>
          <Match when={p.inside}>{p.label}</Match>
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
          <Match when={kind() === "number"}>
            <Hash size={12} />
          </Match>
          <Match when={kind() === "choice"}>
            <ChevronsUpDown size={12} />
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

/** The parts of a border, each its own property and expression, so one may be bound alone. */
const BORDER: [string, string, Kind, Partial<FieldProps>][] = [
  ["Width", "border-width", "number", { min: 0, placeholder: "1" }],
  ["Style", "border-style", "choice", { options: ['"solid"', '"dashed"', '"dotted"', '"double"', '"none"'], placeholder: '"solid"' }],
  ["Colour", "border-color", "colour", { placeholder: "#3a4046" }],
];

/** A border as one row: a picture of it and its parts in words, opening a panel with a field
 *  per part. A first part written fills the width and style it needs to show. */
export function BorderField(p: { props: Record<string, string | undefined>; write: (props: Record<string, string | null>) => void; show: (props: Record<string, string>) => void }) {
  const where = useContext(WhereContext);
  const [opened, setOpened] = createSignal(false);
  let row!: HTMLButtonElement;
  const part = (key: string) => p.props[key] ?? "";
  const any = () => BORDER.some(([, key]) => part(key) !== "");
  const now = (key: string, fallback: string) => {
    const r = resolve(part(key) || fallback, where().scope);
    return r.ok && r.value !== undefined && r.value !== null ? String(r.value) : fallback;
  };
  const write = (key: string, text: string | null) => {
    const props: Record<string, string | null> = { [key]: text };
    if (text !== null && !part("border-width") && key !== "border-width") props["border-width"] = "1";
    if (text !== null && !part("border-style") && key !== "border-style") props["border-style"] = '"solid"';
    p.write(props);
  };
  return (
    <div class="field" classList={{ bound: BORDER.some(([, key]) => !isConstant(part(key))) }}>
      <label>Border</label>
      <span class="vbox has-lead">
        <button ref={row} type="button" class="editor border-sum" onClick={() => setOpened(!opened())}>
          <Show when={any()} fallback={<span class="faint">None</span>}>
            <For each={BORDER}>{([, key]) => <span classList={{ linked: !isConstant(part(key)) }}>{word(part(key)) || "-"}</span>}</For>
          </Show>
        </button>
        <span class="lead" aria-hidden="true">
          <span
            class="border-look"
            classList={{ none: !any() }}
            style={{
              "border-width": `${Math.min(3, Number(now("border-width", "0")) || 0)}px`,
              "border-style": now("border-style", "none"),
              "border-color": now("border-color", "currentColor"),
            }}
          />
        </span>
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
