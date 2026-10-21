import { For, type JSX } from "solid-js";

/** A strip of buttons, one per option, the chosen one lit. An option is its value, its words and
 *  what its title says. `off` gives why an option cannot be chosen now. Choosing the lit one does
 *  nothing. */
export function Choice<T>(p: {
  options: readonly (readonly [T, JSX.Element, string?])[];
  value: T;
  onPick: (value: T) => void;
  off?: (value: T) => string | undefined;
  class?: string;
  hidden?: boolean;
}) {
  return (
    <div class={p.class ? `choice ${p.class}` : "choice"} hidden={p.hidden}>
      <For each={p.options}>
        {([value, words, title]) => (
          <button type="button" classList={{ on: p.value === value }} disabled={!!p.off?.(value)} title={p.off?.(value) ?? title} onClick={() => p.value !== value && p.onPick(value)}>
            {words}
          </button>
        )}
      </For>
    </div>
  );
}
