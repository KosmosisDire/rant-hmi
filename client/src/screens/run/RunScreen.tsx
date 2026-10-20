import { createEffect, on, Show } from "solid-js";
import { RunView } from "../../page/RunView";
import { startStack } from "../../state/stack";
import { currentPage } from "../../state/view";

/** The operator's view inside the editor, starting from the page the editor has open. */
export function RunScreen(p: { shown: boolean }) {
  createEffect(on(() => currentPage()?.id, (id) => id && startStack(id)));
  return (
    <div class="run" hidden={!p.shown}>
      <Show when={currentPage()} fallback={<div class="later">No page yet.</div>}>
        <RunView active={p.shown} />
      </Show>
    </div>
  );
}
