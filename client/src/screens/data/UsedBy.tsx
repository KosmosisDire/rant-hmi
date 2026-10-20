// Where a datapoint is named, for its inspector: each place, opening its page in Design.

import { For, Show } from "solid-js";
import { usedBy } from "../../state/usage";

export function UsedBy(p: { name: string; onOpen: (page: string) => void }) {
  const places = () => usedBy(p.name);
  return (
    <>
      <div class="section">Used by</div>
      <Show when={places().length > 0} fallback={<div class="field-hint">Nothing names it yet.</div>}>
        <For each={places()}>
          {(at) => (
            <button class="list-row" disabled={!at.page} onClick={() => at.page && p.onOpen(at.page.id)}>
              <span class="list-label">{at.element?.props.name ?? at.element?.id ?? at.page?.name ?? "Logic"}</span>
              <span class="list-trail">{at.page ? `${at.page.name}, ${at.what}` : at.what}</span>
            </button>
          )}
        </For>
      </Show>
    </>
  );
}
