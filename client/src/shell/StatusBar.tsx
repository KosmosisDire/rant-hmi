import { For, Show } from "solid-js";
import { inApp } from "../net/link";
import { number } from "../state/format";
import { state } from "../state/store";

/** How this screen reaches the system, and how fast each node on the mesh answers, or on a
 *  phone how many answer. */
export function StatusBar() {
  const link = () => {
    if (state.link === "open") return state.rttMs === null ? "System" : `System ${Math.round(state.rttMs)} ms`;
    return state.link === "connecting" ? "Connecting" : "Reconnecting";
  };
  const active = () => state.peers.filter((p) => p.active);
  return (
    <footer class="statusbar">
      <span class="stat" title={state.channels ? "Reached over WebRTC data channels" : inApp ? "Reached in this app, with no network" : "Reached over the socket alone"}>
        <span class="dot" classList={{ ok: state.link === "open", warn: state.link === "connecting", bad: state.link === "closed" }} />
        {link()}
      </span>
      <Show when={active().length > 0}>
        <span class="stat nodes">
          <span class="dot ok" />
          {active().length === 1 ? "1 node" : `${active().length} nodes`}
        </span>
      </Show>
      <For each={active()}>
        {(peer) => (
          <span class="stat node" title={peer.address}>
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
