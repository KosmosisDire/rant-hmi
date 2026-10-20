import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { Completion, Suggestion } from "../state/complete";
import { painted } from "./highlight";
import { Suggestions } from "./Suggestions";

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
  /** What may be typed at the caret. Nothing is picked until the user picks it. */
  complete?: (text: string, caret: number) => Completion | null;
  class?: string;
  placeholder?: string;
  title?: string;
  /** Each new number puts the caret here with the text selected. */
  focus?: number;
}) {
  let field!: Field;
  createEffect(() => {
    if (p.focus) {
      field.focus();
      field.select();
    }
  });
  const [draft, setDraft] = createSignal<string | null>(null);
  const [bad, setBad] = createSignal(false);
  const [offer, setOffer] = createSignal<Completion | null>(null);
  const [chosen, setChosen] = createSignal(-1);

  const look = () => {
    setChosen(-1);
    setOffer(p.complete && document.activeElement === field ? p.complete(field.value, field.selectionStart ?? field.value.length) : null);
  };
  // focus opens the list on an empty field only, so passing through filled ones stays quiet
  const enter = () => (field.value.trim() === "" ? look() : setOffer(null));
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
      queueMicrotask(() => field.parentElement?.querySelector(".suggest-row.chosen")?.scrollIntoView({ block: "nearest" }));
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
    follow();
  };

  // A field with completion holds code, shown in colour by a layer over it, which copies its
  // box and scroll. The field's own letters are clear, so its caret and selection still show.
  let colours: HTMLPreElement | undefined;
  const follow = () => {
    if (!colours) return;
    colours.scrollTop = field.scrollTop;
    colours.scrollLeft = field.scrollLeft;
  };
  const fit = () => {
    if (!colours) return;
    const css = getComputedStyle(field);
    for (const k of BOX) colours.style.setProperty(k, css.getPropertyValue(k));
    Object.assign(colours.style, { left: `${field.offsetLeft}px`, top: `${field.offsetTop}px`, width: `${field.offsetWidth}px`, height: `${field.offsetHeight}px` });
    // one line stands in the middle of its field, as a line its full height does
    if (!p.multiline) colours.style.lineHeight = `${field.clientHeight}px`;
    follow();
  };
  onMount(() => {
    if (!colours) return;
    const watch = new ResizeObserver(fit);
    watch.observe(field);
    onCleanup(() => watch.disconnect());
  });
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
      onInput={(e: InputEvent & { currentTarget: Field }) => {
        setDraft(e.currentTarget.value);
        look();
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
      <span class="draft">
        {input}
        <pre class="hl" classList={{ wrap: p.multiline }} ref={colours} aria-hidden="true" innerHTML={shown()} />
        <Show when={offer()}>{(o) => <Suggestions items={o().items} chosen={chosen()} onTake={take} />}</Show>
      </span>
    </Show>
  );
}
