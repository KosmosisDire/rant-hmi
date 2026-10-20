// The mode a screen draws the project's pages in, which picks each theme token's value. The
// editor follows its own theme, the operator's screen the device's light or dark setting.

import { createSignal } from "solid-js";
import { theme } from "./theme";

const media = window.matchMedia("(prefers-color-scheme: light)");
const [device, setDevice] = createSignal<"dark" | "light">(media.matches ? "light" : "dark");
media.addEventListener("change", (e) => setDevice(e.matches ? "light" : "dark"));

const operator = location.pathname.replace(/\/+$/, "") === "/run";

export function mode(): "dark" | "light" {
  return operator ? device() : theme();
}
