import { createEffect, createSignal, Show } from "solid-js";
import { RunView } from "../page/RunView";
import { stack, startStack } from "../state/stack";
import { startPage, state, type WebrtcProblem } from "../state/store";
import { Guard } from "../ui/Guard";
import { MenuHost } from "../ui/Menu";
import { Notices } from "../ui/Notices";

/** What the person at the screen can check, for each reason WebRTC did not open. */
const WEBRTC_CHECK: Record<WebrtcProblem, string> = {
  no_webrtc: "This browser does not support WebRTC.",
  browser_blocks: "Please check for a VPN, a privacy extension or a policy preventing WebRTC.",
  network_blocks_udp: "Please check for a firewall or network policy blocking UDP.",
  no_path: "No direct route was found between this network and the HMI.",
};

/** The banner across the top for what is wrong: the HMI out of reach, which stays until it is
 *  back, or no WebRTC, which the person may dismiss until its reason changes. */
function Banner() {
  const [dismissed, setDismissed] = createSignal<WebrtcProblem | null>(null);
  const webrtc = () => (state.link === "open" && state.path === "socket" && state.webrtcProblem !== dismissed() ? state.webrtcProblem : null);
  return (
    <Show when={state.link !== "open" ? "lost" : webrtc()}>
      <div class="banner" role="alert">
        <span>{state.link !== "open" ? "The HMI is out of reach. Reconnecting." : `A WebRTC connection could not be made, so latency is increased. ${WEBRTC_CHECK[webrtc()!]}`}</span>
        <Show when={state.link === "open"}>
          <button class="banner-close" title="Dismiss" aria-label="Dismiss" onClick={() => setDismissed(state.webrtcProblem)}>
            ×
          </button>
        </Show>
      </div>
    </Show>
  );
}

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
      <Guard>
        <RunView active />
      </Guard>
      <Banner />
      <Notices />
      <MenuHost />
    </div>
  );
}
