// What keeps the app sound on a touch screen. The browser's own menu never shows: on a long
// press it would take the touch and leave a button held. And a look on hover follows only a
// mouse, since a finger leaves the last spot it touched hovered.

window.addEventListener("contextmenu", (e) => e.preventDefault(), true);

window.addEventListener("pointerdown", (e) => (document.documentElement.dataset.pointer = e.pointerType), true);

/** Whether the main pointer is a finger, as tokens.css sizes for it. */
export const fingered = matchMedia("(pointer: coarse)").matches;
