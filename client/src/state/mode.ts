// The mode a screen draws the project's pages in, which picks each theme token's value. The
// editor follows its own theme, the operator's screen the device's light or dark setting
// unless the app's code chose one for it.

import { createSignal } from "solid-js";
import type { Mode } from "../protocol/Mode";
import { remembered } from "./remember";
import { theme, toggleTheme } from "./theme";

const media = window.matchMedia("(prefers-color-scheme: light)");
const [device, setDevice] = createSignal<"dark" | "light">(media.matches ? "light" : "dark");
media.addEventListener("change", (e) => setDevice(e.matches ? "light" : "dark"));

/** Whether this is the operator's screen, at /run. Every other path is the editor. */
export const operator = location.pathname.replace(/\/+$/, "") === "/run";

/** What code chose for the operator's screen, kept on the device. */
const [chosen, setChosen] = remembered<Mode>("run-mode", "device", ["device", "dark", "light"]);

export function mode(): "dark" | "light" {
  if (!operator) return theme();
  const m = chosen();
  return m === "device" ? device() : m;
}

/** Draws the pages in `m`, as code asks. The editor turns its own theme, which its pages follow. */
export function setMode(m: Mode) {
  if (operator) setChosen(m);
  else if ((m === "device" ? device() : m) !== theme()) toggleTheme();
}
