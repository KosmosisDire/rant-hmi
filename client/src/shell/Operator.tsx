import { createEffect, Show } from "solid-js";
import { RunView } from "../page/RunView";
import { stack, startStack } from "../state/stack";
import { startPage, state } from "../state/store";
import { Notices } from "../ui/Notices";

/** The operator's screen at /run: the pages full screen, nothing of the editor. It opens on
 *  the project's start page, else the first one. */
export function Operator() {
  createEffect(() => {
    const start = startPage();
    if (stack().length === 0 && start) startStack(start, true);
  });
  createEffect(() => {
    if (state.project) document.title = state.project.name;
  });
  return (
    <div class="operator">
      <RunView active />
      <Show when={state.link !== "open"}>
        <div class="link-lost">The HMI is out of reach. Reconnecting.</div>
      </Show>
      <Notices />
    </div>
  );
}
