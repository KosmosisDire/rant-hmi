// Gamepads on a running screen. While some element listens, a loop reads every pad once a frame
// and hands each element that shows its buttons and its sticks. A button held ends with its
// buttonup, and sticks that move come to rest, however they end: let go, the window losing
// focus, the pad gone, the element gone or covered, or the while that heard them turning false.

import { createEffect, createMemo, onCleanup } from "solid-js";
import type { Element } from "../protocol/Element";
import type { Handler } from "../protocol/Handler";
import type { At, Scope } from "../state/bind";
import { eventInfo, handlerKey, rest, rests, settingsOf, takes } from "../state/events";
import { notify } from "../state/store";
import { type Act, numberOf } from "./act";
import { holds, type Listener, Listening } from "./listening";

/** The standard pad's buttons in the order the browser numbers them, as the filter lists them. */
const BUTTONS = settingsOf("buttondown")
  .find((s) => s.name === "button")!
  .options.map(([name]) => name);

/** What a button's event brings. */
export interface Button {
  button: string;
  pad: number;
}

/** What a pad's axes bring. */
export interface Axes {
  lx: number;
  ly: number;
  rx: number;
  ry: number;
  lt: number;
  rt: number;
  axes: number[];
  pad: number;
}

/** `v` counted from 0 at `dead` to 1 at its end, 0 within it. */
const band = (v: number, dead: number) => (Math.abs(v) <= dead ? 0 : (Math.sign(v) * (Math.abs(v) - dead)) / (1 - dead));

/** A stick's x and y, its length counted as `band` counts one axis, so it turns freely. */
function stick(x = 0, y = 0, dead: number): [number, number] {
  const length = Math.hypot(x, y);
  if (length <= dead) return [0, 0];
  const k = band(Math.min(length, 1), dead) / length;
  return [x * k, y * k];
}

/** What pad `g` brings past `dead`, each stick's y up as a Joystick's. */
export function axesOf(g: Gamepad, dead: number): Axes {
  const [lx, ly] = stick(g.axes[0], g.axes[1], dead);
  const [rx, ry] = stick(g.axes[2], g.axes[3], dead);
  const trigger = (i: number) => band(g.buttons[i]?.value ?? 0, dead);
  return { lx, ly: 0 - ly, rx, ry: 0 - ry, lt: trigger(6), rt: trigger(7), axes: g.axes.map((a) => band(a, dead)), pad: g.index };
}

/** An element listening, told each button that goes down or up and each frame's pads. */
interface PadListener extends Listener {
  down(b: Button): void;
  up(b: Button): void;
  frame(pads: readonly (Gamepad | null)[]): void;
}

// each button down at the last frame, by pad and name, so a press counts once as a key does
const down = new Set<string>();
const idOf = (b: Button) => `${b.pad} ${b.button}`;

function tick() {
  const pads = navigator.getGamepads();
  const changed: [Button, boolean][] = [];
  for (const g of pads) {
    if (!g) continue;
    BUTTONS.forEach((button, i) => {
      const b = { button, pad: g.index };
      const pressed = !!g.buttons[i]?.pressed;
      if (pressed !== down.has(idOf(b))) changed.push([b, pressed]);
      if (pressed) down.add(idOf(b));
      else down.delete(idOf(b));
    });
  }
  for (const id of down) if (!pads[Number(id.split(" ")[0])]) down.delete(id);
  // a window without focus hears no pad, as it hears no key
  if (!document.hasFocus()) return listening.loseAll();
  for (const l of listening.shown()) {
    for (const [b, pressed] of changed) {
      if (pressed) l.down(b);
      else l.up(b);
    }
    l.frame(pads);
  }
}

/** Whether this page may read pads, which takes a secure context. */
function readable() {
  try {
    return typeof navigator.getGamepads === "function" && !!navigator.getGamepads();
  } catch {
    return false;
  }
}

let told = false;

/** The loop while any element listens. A page that cannot read pads says so once, with the
 *  address that can. */
const listening = new Listening<PadListener>(() => {
  if (!readable()) {
    if (!told) notify(`Gamepads need a secure page: open https://${location.host}${location.pathname}`, "warn");
    told = true;
    return () => {};
  }
  let frame = requestAnimationFrame(function loop() {
    tick();
    frame = requestAnimationFrame(loop);
  });
  return () => cancelAnimationFrame(frame);
});

const gamepad = (h: Handler) => eventInfo(h.event)?.from === "gamepad";

/** One axes handler's stream from one pad: what it sent last. */
interface Stream {
  h: Handler;
  p: Axes;
}

/** Hands an element's pads to its handlers while it shows: buttondown and buttonup however the
 *  button ends, and to each axes handler, past its own deadband, once a frame while what it
 *  brings changes, then once at rest. An end that never came brings `lost`. */
export function useGamepads(p: { element: Element; act?: Act; at?: At; scope: Scope }, self: () => globalThis.Element | undefined) {
  const listens = createMemo(() => !!p.act && p.element.handlers.some(gamepad));
  createEffect(() => {
    const [el, act] = [self(), p.act];
    if (!listens() || !el || !act) return;
    const hears = (h: Handler) => act.hears(p.element, h, p.at);
    const fire = (event: string, sent: object, only?: Handler) => act.fire(p.element, event, sent, p.at, only);
    const buttons = holds<Button>((b, up) => fire("buttonup", up ?? { ...b, lost: true }));
    const streams = holds<Stream>((s, still) => fire("axes", still?.p ?? { ...rest("axes", s.p), lost: true }, s.h));
    const stop = listening.add({
      el,
      down: (b) => {
        const hs = p.element.handlers.filter((h) => takes(h, "buttondown", b) || takes(h, "buttonup", b));
        if (hs.length === 0 || buttons.get(idOf(b))) return;
        // ends once any buttondown that heard it is no longer heard
        const by = hs.filter((h) => h.event === "buttondown" && hears(h));
        buttons.begin(idOf(b), b, by.length > 0 ? () => by.every(hears) : undefined);
        fire("buttondown", b);
      },
      up: (b) => buttons.end(idOf(b), b),
      frame: (pads) => {
        for (const h of p.element.handlers.filter((x) => x.event === "axes")) {
          const dead = Math.min(Math.max(numberOf(h, "deadband", p.scope), 0), 0.99);
          for (const g of pads) {
            const now = g && axesOf(g, dead);
            if (!now || !takes(h, "axes", now)) continue;
            const id = `${handlerKey(h.event, h.filter)} ${g.index}`;
            const was = streams.get(id);
            if (rests("axes", now)) {
              streams.end(id, { h, p: now });
            } else if (!was) {
              // a stream begins only where it is heard, and ends lost once it is not
              if (!hears(h)) continue;
              streams.begin(id, { h, p: now }, () => hears(h));
              fire("axes", now, h);
            } else if (JSON.stringify(was.p.p) !== JSON.stringify(now)) {
              was.p.p = now;
              fire("axes", now, h);
            }
          }
        }
        // what a pad gone held ends lost
        for (const id of buttons.ids()) if (!pads[Number(id.split(" ")[0])]) buttons.end(id);
        for (const id of streams.ids()) if (!pads[streams.get(id)!.p.p.pad]) streams.end(id);
      },
      lose: () => {
        buttons.endAll();
        streams.endAll();
      },
    });
    onCleanup(() => {
      stop();
      buttons.endAll();
      streams.endAll();
    });
  });
}
