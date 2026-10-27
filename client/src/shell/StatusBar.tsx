import { inApp } from "../net/link";
import { state } from "../state/store";
import { ProblemsCount } from "./Problems";

/** How this screen reaches the system and how fast it answers, the project, and its problems. */
export function StatusBar() {
  const link = () => {
    if (state.link === "open") return state.rttMs === null ? "System" : `System ${Math.round(state.rttMs)} ms`;
    return state.link === "connecting" ? "Connecting" : "Reconnecting";
  };
  return (
    <footer class="statusbar">
      <span class="stat" title={inApp ? "Reached in this app, with no network" : state.path === "channel" ? "Reached over WebRTC: values, big values, pings and actions on its link channel" : state.second === "webtransport" ? "Reached over the socket, big values over WebTransport" : state.second ? "Reached over the socket, big values over a second one" : "Reached over the socket alone"}>
        <span class="dot" classList={{ ok: state.link === "open", warn: state.link === "connecting", bad: state.link === "closed" }} />
        {link()}
      </span>
      <span class="right">{state.project?.name}</span>
      <ProblemsCount />
    </footer>
  );
}
