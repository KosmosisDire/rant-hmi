import { createEffect, createSignal, on, Show } from "solid-js";
import { RunView } from "../../page/RunView";
import { startStack } from "../../state/stack";
import { page, state } from "../../state/store";
import { currentPage } from "../../state/view";

/** The operator's view inside the editor, starting from the page the editor had open last. A
 *  component open in the editor never takes its place, since it runs only inside a page. */
export function RunScreen(p: { shown: boolean }) {
  const [last, setLast] = createSignal("");
  createEffect(() => {
    const open = currentPage();
    if (open && !open.interface) setLast(open.id);
  });
  const shown = () => page(last()) ?? state.pages.find((pg) => !pg.interface);
  createEffect(on(() => shown()?.id, (id) => id && startStack(id)));
  return (
    <div class="run" hidden={!p.shown}>
      <Show when={shown()} fallback={<div class="later">No page yet.</div>}>
        <RunView active={p.shown} />
      </Show>
    </div>
  );
}
