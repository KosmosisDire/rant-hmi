import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { Completion, Signature, Suggestion } from "../state/complete";
import { painted } from "./highlight";
import { SignatureHint, type Spot, Suggestions } from "./Suggestions";

type Field = HTMLInputElement | HTMLTextAreaElement;

/** What the colours copy from their field, so each line up with its letters. */
const BOX = [
  "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "text-align", "tab-size",
];

/** A field that shows the live value until typed in, so a live update never erases an edit
 *  and a field only focused never writes. Enter or leaving commits, Escape puts it back. */
export function DraftInput(p: {
  value: string;
  onCommit: (text: string) => void;
  /** A commit this refuses stays in the field, outlined red. */
  accept?: (text: string) => boolean;
  /** Enter makes a new line, Ctrl Enter commits. */
  multiline?: boolean;
  /** Code: numbered lines that never wrap, in a box that grows with them. */
  code?: boolean;
  /** What may be typed at the caret. Nothing is picked until the user picks it. */
  complete?: (text: string, caret: number) => Completion | null;
  /** What the call at the caret takes, shown over its line. */
  hint?: (text: string, caret: number) => Signature | null;
  class?: string;
  placeholder?: string;
  title?: string;
  /** Each new number puts the caret here, with the text selected, or at the end of code. */
  focus?: number;
}) {
  let field!: Field;
  createEffect(() => {
    if (!p.focus) return;
    field.focus();
    if (p.code) field.setSelectionRange(field.value.length, field.value.length);
    else field.select();
  });
  const [draft, setDraft] = createSignal<string | null>(null);
  const [bad, setBad] = createSignal(false);
  const [offer, setOffer] = createSignal<Completion | null>(null);
  const [chosen, setChosen] = createSignal(-1);
  const [sign, setSign] = createSignal<Signature | null>(null);
  const signAt = () => setSign(p.hint && document.activeElement === field ? p.hint(field.value, field.selectionStart ?? field.value.length) : null);

  const look = () => {
    setChosen(-1);
    setOffer(p.complete && document.activeElement === field ? p.complete(field.value, field.selectionStart ?? field.value.length) : null);
  };
  // typing opens the list on a name or after a dot, not on a space or a bracket, unless asked
  const typed = () => {
    const at = field.selectionStart ?? field.value.length;
    if (field.value.trim() === "" || /[\w$.]/.test(field.value[at - 1] ?? "")) look();
    else setOffer(null);
  };
  // focus opens the list on an empty field only, so passing through filled ones stays quiet
  const enter = () => {
    signAt();
    if (field.value.trim() === "") look();
    else setOffer(null);
  };
  const take = (s: Suggestion) => {
    const o = offer();
    if (!o) return;
    const caret = field.selectionStart ?? field.value.length;
    const text = field.value.slice(0, o.from) + s.insert + field.value.slice(caret);
    field.value = text;
    setDraft(text);
    field.setSelectionRange(o.from + s.insert.length, o.from + s.insert.length);
    look();
  };
  const commit = () => {
    setOffer(null);
    setSign(null);
    const text = draft();
    if (text === null) return;
    if (p.accept && !p.accept(text)) return setBad(true);
    setBad(false);
    setDraft(null);
    if (text !== p.value) p.onCommit(text);
  };
  const key = (e: KeyboardEvent & { currentTarget: Field }) => {
    const o = offer();
    if (o && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const n = o.items.length;
      setChosen((c) => (e.key === "ArrowDown" ? (c + 1) % n : c <= 0 ? n - 1 : c - 1));
      return;
    }
    if (o && chosen() >= 0 && (e.key === "Enter" || e.key === "Tab")) {
      e.preventDefault();
      take(o.items[chosen()]);
      return;
    }
    if (o && e.key === "Escape") {
      e.preventDefault();
      setOffer(null);
      return;
    }
    if (p.complete && e.key === " " && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      look();
      return;
    }
    if (e.key === "Enter" && (!p.multiline || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      commit();
      if (!bad()) e.currentTarget.blur();
    } else if (e.key === "Escape") {
      setDraft(null);
      setBad(false);
      e.currentTarget.blur();
    }
  };
  // moving the caret while the list is open changes what fits there
  const moved = (e: KeyboardEvent) => {
    if (offer() && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) look();
    signAt();
    follow();
  };

  // A field with completion holds code, shown in colour by a layer over it, which copies its
  // box and scroll. The field's own letters are clear, so its caret and selection still show.
  let colours: HTMLPreElement | undefined;
  let gutter: HTMLPreElement | undefined;
  const follow = () => {
    if (!colours) return;
    colours.scrollTop = field.scrollTop;
    colours.scrollLeft = field.scrollLeft;
  };
  const grow = () => {
    if (!p.code) return;
    field.style.height = "0";
    field.style.height = `${field.scrollHeight + 2}px`;
  };
  const fit = () => {
    if (!colours) return;
    const css = getComputedStyle(field);
    for (const k of BOX) colours.style.setProperty(k, css.getPropertyValue(k));
    Object.assign(colours.style, { left: `${field.offsetLeft}px`, top: `${field.offsetTop}px`, width: `${field.offsetWidth}px`, height: `${field.offsetHeight}px` });
    if (gutter) {
      for (const k of ["padding-top", "border-top-width", "font-family", "font-size", "line-height"]) gutter.style.setProperty(k, css.getPropertyValue(k));
      Object.assign(gutter.style, { left: `${field.offsetLeft}px`, top: `${field.offsetTop}px`, height: `${field.offsetHeight}px` });
    }
    // one line stands in the middle of its field, as a line its full height does
    if (!p.multiline) colours.style.lineHeight = `${field.clientHeight}px`;
    follow();
  };
  createEffect(() => {
    draft();
    p.value;
    queueMicrotask(grow);
  });
  onMount(() => {
    if (!colours) return;
    const watch = new ResizeObserver(fit);
    watch.observe(field);
    onCleanup(() => watch.disconnect());
  });
  // A code box's list opens under the line typed in, from the word's start. The field's letters
  // are its font's, so the line's text before the word says how far in that is.
  let ruler: CanvasRenderingContext2D | null = null;
  const spot = (from: number): Spot => {
    const r = field.getBoundingClientRect();
    if (!p.multiline) return { left: r.left, top: r.top, bottom: r.bottom, width: r.width };
    const css = getComputedStyle(field);
    const lines = field.value.slice(0, from).split("\n");
    ruler ??= document.createElement("canvas").getContext("2d");
    if (ruler) ruler.font = `${css.fontStyle} ${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
    const tab = " ".repeat(Number(css.tabSize) || 8);
    const x = ruler?.measureText(lines.at(-1)!.replaceAll("\t", tab)).width ?? 0;
    const line = parseFloat(css.lineHeight) || parseFloat(css.fontSize) * 1.2;
    const top = r.top + parseFloat(css.borderTopWidth) + parseFloat(css.paddingTop) + (lines.length - 1) * line - field.scrollTop;
    const left = r.left + parseFloat(css.borderLeftWidth) + parseFloat(css.paddingLeft) + x - field.scrollLeft;
    return { left, top, bottom: top + line, width: r.width, word: true };
  };

  // a last empty line still takes its height, as it does in the field
  const shown = () => {
    const text = draft() ?? p.value;
    return painted(p.multiline && text.endsWith("\n") ? `${text} ` : text);
  };

  const input = (
    <Dynamic
      component={p.multiline ? "textarea" : "input"}
      ref={(el: Field) => (field = el)}
      class={p.class ?? "editor"}
      classList={{ bad: bad(), "hl-field": !!p.complete }}
      value={draft() ?? p.value}
      placeholder={p.placeholder}
      title={p.title}
      spellcheck={false}
      rows={p.multiline ? 4 : undefined}
      wrap={p.code ? "off" : undefined}
      onInput={(e: InputEvent & { currentTarget: Field }) => {
        setDraft(e.currentTarget.value);
        typed();
        signAt();
        queueMicrotask(follow);
      }}
      onScroll={follow}
      onFocus={enter}
      onClick={enter}
      onKeyUp={moved}
      onBlur={commit}
      onKeyDown={key}
    />
  );
  return (
    <Show when={p.complete} fallback={input}>
      <span class="draft" classList={{ code: p.code }}>
        {input}
        <Show when={p.code}>
          <pre class="gutter" ref={gutter} aria-hidden="true">
            {Array.from({ length: (draft() ?? p.value).split("\n").length }, (_, i) => i + 1).join("\n")}
          </pre>
        </Show>
        <pre class="hl" classList={{ wrap: p.multiline && !p.code }} ref={colours} aria-hidden="true" innerHTML={shown()} />
        {/* the list comes later, so where both float it covers the hint */}
        <Show when={sign()}>{(s) => <SignatureHint sign={s()} at={() => spot(s().from)} />}</Show>
        <Show when={offer()}>{(o) => <Suggestions items={o().items} chosen={chosen()} onTake={take} at={() => spot(o().from)} />}</Show>
      </span>
    </Show>
  );
}
