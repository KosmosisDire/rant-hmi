import { For, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { dismiss, state } from "../state/store";
import { CircleX, Info, TriangleAlert } from "./icons";

const ICONS = { info: Info, warn: TriangleAlert, fault: CircleX };

/** What the backend or a handler told this screen, dropping in at the top with the newest
 *  lowest until each fades. A click puts one away, and the same words again count on it. */
export function Notices() {
  return (
    <div class="notices">
      <For each={state.notices}>
        {(n) => (
          <div class={`notice ${n.level}`} role={n.level === "info" ? "status" : "alert"} onClick={() => dismiss(n.n)}>
            <Dynamic component={ICONS[n.level]} size={15} />
            <span class="notice-text">{n.text}</span>
            <Show when={n.count > 1}>
              <span class="notice-count">{n.count}</span>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}
