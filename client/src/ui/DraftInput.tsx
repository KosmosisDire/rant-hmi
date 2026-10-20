import { createEffect, createSignal, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { Completion, Suggestion } from "../state/complete";
import { Suggestions } from "./Suggestions";

type Field = HTMLInputElement | HTMLTextAreaElement;

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
  };

  const input = (
    <Dynamic
      component={p.multiline ? "textarea" : "input"}
      ref={(el: Field) => (field = el)}
      class={p.class ?? "editor"}
      classList={{ bad: bad() }}
      value={draft() ?? p.value}
      placeholder={p.placeholder}
      title={p.title}
      spellcheck={false}
      rows={p.multiline ? 4 : undefined}
      onInput={(e: InputEvent & { currentTarget: Field }) => {
        setDraft(e.currentTarget.value);
        look();
      }}
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
        <Show when={offer()}>{(o) => <Suggestions items={o().items} chosen={chosen()} onTake={take} />}</Show>
      </span>
    </Show>
  );
}
