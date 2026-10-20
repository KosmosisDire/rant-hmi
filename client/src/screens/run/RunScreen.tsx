import { Show } from "solid-js";
import { send } from "../../net/connection";
import { Fit, PageView } from "../../page/PageView";
import { currentPage } from "../../state/view";

/** The operator's view of the open page, live, scaled to the window. */
export function RunScreen(p: { shown: boolean }) {
  return (
    <div class="run" hidden={!p.shown}>
      <Show when={currentPage()} fallback={<div class="later">No page yet.</div>}>
        {(page) => (
          <Fit width={page().width} height={page().height}>
            <PageView page={page()} fire={(id, event) => send({ type: "fire", page: page().id, id, event })} />
          </Fit>
        )}
      </Show>
    </div>
  );
}
