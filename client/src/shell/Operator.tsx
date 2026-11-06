import { createEffect, createSignal, Show } from "solid-js";
import { RunView } from "../page/RunView";
import { stack, startStack } from "../state/stack";
import type { ScreenCondition } from "../protocol/ScreenCondition";
import type { WebrtcProblem } from "../protocol/WebrtcProblem";
import { conditions, startPage, state } from "../state/store";
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

/** What the banner says of each condition this screen holds. */
function told(c: ScreenCondition): string {
  switch (c.kind) {
    case "webrtc":
      return `A WebRTC connection could not be made, so latency is increased. ${c.problem ? WEBRTC_CHECK[c.problem] : ""}`;
    case "software_decode":
      return `This device decodes video without its graphics card (${c.video}), so video may stutter. Please check that hardware acceleration is on in the browser's settings.`;
    case "software_drawing":
      return `This browser draws without the graphics card (${c.renderer}), so pages may stutter. Please turn on hardware acceleration in the browser's settings.`;
    case "slow_drawing":
      return `This screen draws ${c.fps} frames a second on ${c.renderer}, so pages stutter. Please check the browser uses the device's fastest graphics card.`;
  }
}

/** A dismissed condition stays dismissed until its kind, or why WebRTC did not open, changes. */
const dismissal = (c: ScreenCondition) => (c.kind === "webrtc" ? `webrtc ${c.problem}` : c.kind);

/** The banner across the top for what is wrong: the HMI out of reach, which stays until it is
 *  back, or the first condition this screen holds that the person did not dismiss. */
function Banner() {
  const [dismissed, setDismissed] = createSignal<string[]>([]);
  const shown = () => (state.link === "open" ? conditions().find((c) => !dismissed().includes(dismissal(c))) : undefined);
  return (
    <Show when={state.link !== "open" ? "lost" : shown()}>
      <div class="banner" role="alert">
        <span>{state.link !== "open" ? "The HMI is out of reach. Reconnecting." : told(shown()!)}</span>
        <Show when={shown()}>
          {(c) => (
            <button class="banner-close" title="Dismiss" aria-label="Dismiss" onClick={() => setDismissed([...dismissed(), dismissal(c())])}>
              ×
            </button>
          )}
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
