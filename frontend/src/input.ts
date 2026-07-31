/* The input floor: default deny, whitelist explicitly.
 *
 * A panel HMI is a fixed instrument, not a document. Every gesture the browser would
 * interpret on its own (pinch zoom, double tap zoom, ctrl+wheel zoom, pull to refresh,
 * overscroll bounce, the long press callout, the right click menu, text selection, drag and
 * drop, middle click autoscroll, the tap flash) is a defect on a wall panel, and every one
 * of them is refused HERE, once, for the whole document. Nothing is left to a per component
 * rule, so a surface added later is locked before it is written.
 *
 * Getting a native behaviour back is explicit, one of two ways:
 *   - mark the element (or an ancestor) data-input="text" | "scroll" | "native", or
 *   - handle the event in app code: this cancels the BROWSER's default only and never stops
 *     propagation, so an app listener on the same event still runs and can do its own thing.
 * Text entry elements carry the "text" allowance implicitly, since a caret with no selection
 * and no paste is not a text field.
 *
 * This is half the policy. The other half (touch-action, user-select, the tap highlight,
 * the callout, overscroll) is CSS and lives in the "input floor" section of styles.css,
 * whitelisted by the same three data-input values. */

/* the implicit text allowance, plus the opt in */
const TEXT =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], [data-input~="text"]';
/* the full escape hatch: a subtree that behaves like a plain web page */
const NATIVE = '[data-input~="native"]';

/* every listener cancels a default, so none of them may be passive; every one is at capture
   so it runs before app code and before anything that stops propagation */
const GUARD: AddEventListenerOptions = { capture: true, passive: false };

/* a second tap this soon after the last is a zoom on the iOS versions that ignore
   touch-action, so it is refused rather than delivered */
const DOUBLE_TAP_MS = 350;

/* browser shortcuts refused with ctrl/cmd held. The ones the browser reserves for itself
   (ctrl+W, ctrl+T, F11, alt+tab, the address bar) never reach a page at all: those are a
   kiosk mode setting on the device, not something this file can promise. Devtools keys are
   deliberately left alone. */
const BROWSER_KEYS = new Set([
  "+", "=", "-", "_", "0", /* zoom in / out / reset, main row and numpad */
  "p", /* print */
  "s", /* save page */
  "f", /* find in page */
  "g", /* find next */
  "d", /* bookmark; the app binds this to duplicate */
  "o", /* open file */
]);

function within(target: EventTarget | null, selector: string): boolean {
  const node = target as Element | null;
  return !!node && typeof node.closest === "function" && !!node.closest(selector);
}

let lastPointerType = "mouse";

export function installInputGuard(): void {
  /* contextmenu carries no pointer type of its own, so remember the one that opened it */
  window.addEventListener(
    "pointerdown",
    (ev) => {
      lastPointerType = (ev as PointerEvent).pointerType || "mouse";
    },
    GUARD,
  );

  /* The native context menu never opens: the app opens its own instead. (A press-and-hold
     used to raise it too, timed by the artboard camera; that went with the camera, so it is
     a right click only for now.) The one exception is a real right click inside a text
     field, where cut/paste has no app side replacement; a long press is not a right click
     and never reaches it. */
  window.addEventListener(
    "contextmenu",
    (ev) => {
      if (within(ev.target, NATIVE)) return;
      if (lastPointerType === "mouse" && within(ev.target, TEXT)) return;
      ev.preventDefault();
    },
    GUARD,
  );

  /* an HMI's text is display, not a document: a drag never becomes a selection */
  window.addEventListener(
    "selectstart",
    (ev) => {
      if (!within(ev.target, TEXT) && !within(ev.target, NATIVE)) ev.preventDefault();
    },
    GUARD,
  );

  /* nothing on the page is draggable, and a file dropped on it must never navigate the
     panel away from the running UI */
  window.addEventListener(
    "dragstart",
    (ev) => {
      if (!within(ev.target, NATIVE)) ev.preventDefault();
    },
    GUARD,
  );
  for (const kind of ["dragover", "dragenter", "dragleave", "drop"])
    window.addEventListener(
      kind,
      (ev) => {
        if (!within(ev.target, NATIVE)) ev.preventDefault();
      },
      GUARD,
    );

  /* Safari's own pinch gesture events, which touch-action does not cover */
  for (const kind of ["gesturestart", "gesturechange", "gestureend"])
    window.addEventListener(kind, (ev) => ev.preventDefault(), GUARD);

  /* ctrl+wheel and the trackpad pinch that synthesises it are browser zoom. A plain wheel is
     left alone here: the stage reads it as canvas zoom, everything else ignores it. */
  window.addEventListener(
    "wheel",
    (ev) => {
      if ((ev as WheelEvent).ctrlKey) ev.preventDefault();
    },
    GUARD,
  );

  /* two fingers down is a zoom the browser would take. The app reads its own pinch off
     pointer events, which cancelling the touch default does not disturb. */
  window.addEventListener(
    "touchmove",
    (ev) => {
      if ((ev as TouchEvent).touches.length > 1 && !within(ev.target, NATIVE)) ev.preventDefault();
    },
    GUARD,
  );

  let lastTouchEnd = 0;
  window.addEventListener(
    "touchend",
    (ev) => {
      const now = performance.now();
      const quick = now - lastTouchEnd < DOUBLE_TAP_MS;
      lastTouchEnd = now;
      if (quick && !within(ev.target, TEXT) && !within(ev.target, NATIVE)) ev.preventDefault();
    },
    GUARD,
  );

  /* double click word selection, outside a text field */
  window.addEventListener(
    "dblclick",
    (ev) => {
      if (!within(ev.target, TEXT) && !within(ev.target, NATIVE)) ev.preventDefault();
    },
    GUARD,
  );

  /* middle click: autoscroll on Windows, primary selection paste on X11. The viewport reads
     button 1 as pan, and cancelling the default leaves the pointer events intact. */
  window.addEventListener(
    "auxclick",
    (ev) => {
      if (!within(ev.target, NATIVE)) ev.preventDefault();
    },
    GUARD,
  );
  window.addEventListener(
    "mousedown",
    (ev) => {
      if ((ev as MouseEvent).button === 1 && !within(ev.target, NATIVE)) ev.preventDefault();
    },
    GUARD,
  );

  window.addEventListener("keydown", (ev) => onKey(ev as KeyboardEvent), GUARD);
}

function onKey(ev: KeyboardEvent): void {
  if (within(ev.target, NATIVE)) return;
  if (!ev.ctrlKey && !ev.metaKey) return;
  const key = ev.key.toLowerCase();
  if (BROWSER_KEYS.has(key)) {
    ev.preventDefault();
    return;
  }
  /* select all outside a text field would highlight the whole instrument */
  if (key === "a" && !within(ev.target, TEXT)) ev.preventDefault();
}
