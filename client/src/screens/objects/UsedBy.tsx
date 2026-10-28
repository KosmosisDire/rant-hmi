// Where an object or a member is named, for its inspector: each place, opening its page in
// Design or its object's sheet.

import { For, Show } from "solid-js";
import { usedBy } from "../../state/usage";
import type { Picking } from "./ObjectsScreen";

export function UsedBy(p: { name: string; picking: Picking; label?: string; outside?: string }) {
  const places = () => usedBy(p.name).filter((at) => p.outside === undefined || at.object !== p.outside);
  return (
    <>
      <div class="section">{p.label ?? "Used by"}</div>
      <Show when={places().length > 0} fallback={<div class="field-hint">Nothing names it yet.</div>}>
        <For each={places()}>
          {(at) => (
            <button class="list-row" onClick={() => (at.page ? p.picking.onPage(at.page.id) : at.object && p.picking.onOpen(at.object))}>
              <span class="list-label">{at.element?.props.name ?? at.element?.id ?? at.page?.name ?? at.object}</span>
              <span class="list-trail">{at.page ? `${at.page.name}, ${at.what}` : at.what}</span>
            </button>
          )}
        </For>
      </Show>
    </>
  );
}
