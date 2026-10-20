import { createSignal } from "solid-js";
import { Dynamic } from "solid-js/web";

type Field = HTMLInputElement | HTMLTextAreaElement;

/** A text field that shows the live value until focused, then what is typed, so a live
 *  update never erases an edit. Enter or leaving commits (Ctrl Enter when multiline, where
 *  Enter makes a new line), Escape puts the value back. A commit `accept` refuses stays in
 *  the field, outlined red. */
export function DraftInput(p: {
  value: string;
  onCommit: (text: string) => void;
  accept?: (text: string) => boolean;
  multiline?: boolean;
  class?: string;
  placeholder?: string;
  title?: string;
}) {
  const [draft, setDraft] = createSignal<string | null>(null);
  const [bad, setBad] = createSignal(false);
  const commit = () => {
    const text = draft();
    if (text === null) return;
    if (p.accept && !p.accept(text)) return setBad(true);
    setBad(false);
    setDraft(null);
    if (text !== p.value) p.onCommit(text);
  };
  const key = (e: KeyboardEvent & { currentTarget: Field }) => {
    const commits = e.key === "Enter" && (!p.multiline || e.ctrlKey || e.metaKey);
    if (commits) {
      e.preventDefault();
      commit();
      if (!bad()) e.currentTarget.blur();
    } else if (e.key === "Escape") {
      setDraft(null);
      setBad(false);
      e.currentTarget.blur();
    }
  };
  return (
    <Dynamic
      component={p.multiline ? "textarea" : "input"}
      class={p.class ?? "editor"}
      classList={{ bad: bad() }}
      value={draft() ?? p.value}
      placeholder={p.placeholder}
      title={p.title}
      spellcheck={false}
      rows={p.multiline ? 4 : undefined}
      onFocus={() => setDraft(p.value)}
      onInput={(e: InputEvent & { currentTarget: Field }) => setDraft(e.currentTarget.value)}
      onBlur={commit}
      onKeyDown={key}
    />
  );
}
