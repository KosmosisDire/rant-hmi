import { For } from "solid-js";
import { Dynamic } from "solid-js/web";
import { dismiss, state } from "../state/store";
import { CircleX, Info, TriangleAlert, X } from "./icons";

const ICONS = { info: Info, warn: TriangleAlert, fault: CircleX };

/** What the backend or a handler told this screen, stacked in a corner until it fades. */
export function Notices() {
  return (
    <div class="notices">
      <For each={state.notices}>
        {(n) => (
          <div class={`notice ${n.level}`} role={n.level === "info" ? "status" : "alert"}>
            <Dynamic component={ICONS[n.level]} size={15} />
            <span class="notice-text">{n.text}</span>
            <button class="icon-btn" title="Dismiss" onClick={() => dismiss(n.n)}>
              <X size={13} />
            </button>
          </div>
        )}
      </For>
    </div>
  );
}
