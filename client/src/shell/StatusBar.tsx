import { For, Show } from "solid-js";
import { number } from "../state/format";
import { state } from "../state/store";

/** How this screen reaches the system, and how fast each node on the mesh answers. */
export function StatusBar() {
  const link = () => {
    if (state.link === "open") return state.rttMs === null ? "System" : `System ${Math.round(state.rttMs)} ms`;
    return state.link === "connecting" ? "Connecting" : "Reconnecting";
  };
  return (
    <footer class="statusbar">
      <span class="stat">
        <span class="dot" classList={{ ok: state.link === "open", warn: state.link === "connecting", bad: state.link === "closed" }} />
        {link()}
      </span>
      <For each={state.peers.filter((p) => p.active)}>
        {(peer) => (
          <span class="stat" title={peer.address}>
            <span class="dot ok" />
            {peer.name}
            <Show when={peer.rtt_ms !== null}>
              <span class="faint mono">{number(peer.rtt_ms ?? 0)} ms</span>
            </Show>
          </span>
        )}
      </For>
      <span class="right">{state.project?.name}</span>
    </footer>
  );
}
