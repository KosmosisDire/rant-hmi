// What keeps the app sound on a touch screen. The browser's own menu never shows: on a long
// press it would take the touch and leave a button held. A look on hover follows only a mouse,
// since a finger leaves the last spot it touched hovered. And typing stays in sight.

window.addEventListener("contextmenu", (e) => e.preventDefault(), true);

window.addEventListener("pointerdown", (e) => (document.documentElement.dataset.pointer = e.pointerType), true);

// a phone's keyboard shrinks the window, so the field it types into is scrolled back into sight
window.addEventListener("resize", () => {
  const f = document.activeElement;
  if (f instanceof HTMLElement && f.matches("input, textarea, [contenteditable]")) requestAnimationFrame(() => f.scrollIntoView({ block: "nearest" }));
});

/** Whether the main pointer is a finger, as tokens.css sizes for it. */
export const fingered = matchMedia("(pointer: coarse)").matches;
