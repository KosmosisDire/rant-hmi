/* Dev-only element picker: point at a piece of the running UI and get a text handle for it
 * on the clipboard, to paste into a conversation about changing that piece. It reports what
 * a class chain alone cannot: the widget a canvas part belongs to, the visible text, and the
 * view state at the time.
 *
 * This is not part of the application. Nothing imports it at build time, it holds no
 * document state, it never sends an op, and it is fetched only when the page is opened with
 * ?pick, so an operate-mode client never downloads it. Deleting this file and the two lines
 * in main.ts removes the feature completely.
 *
 *   http://localhost:PORT/?pick     loads it, switched off; alt+P or the topbar chip turns
 *                                   it on, alt+P or escape turns it back off
 *   click        capture the outlined element, and copy every capture so far
 *   shift+click  capture its parent instead
 *   wheel/arrows widen or narrow the target before clicking
 *   C / X        copy again / clear the list
 *
 * Captures accumulate: the clipboard always holds the whole list, so pointing at three
 * things and pasting once is the normal way to use it. Every capture is also logged to the
 * console, which is the fallback when the origin is not secure enough for the clipboard. */

const MAX_TEXT = 90;   /* visible text carried per capture */
const MAX_PATH = 7;    /* ancestors named in the path line */
const MAX_CLASS = 3;   /* classes named per path step */

let active = false;
let climb = 0;         /* how many levels above the hovered element the target sits */
let base: Element | null = null;
let target: Element | null = null;
const picks: string[] = [];

let host: HTMLElement;
let box: HTMLElement;
let tag: HTMLElement;
let hint: HTMLElement;
let toast: HTMLElement;
let toggle: HTMLElement;
let toastTimer = 0;

export function installPicker(): void {
  const flag = window as unknown as { hmiPickInstalled?: boolean };
  if (flag.hmiPickInstalled) return;
  flag.hmiPickInstalled = true;
  injectStyles();
  buildOverlay();
  buildToggle();
  window.addEventListener("keydown", onGlobalKey, true);
  window.addEventListener("blur", () => paint(null));
  /* loaded but off: ?pick stays in the address bar across reloads, and a page that swallowed
     every click the moment it came back would be a trap rather than a tool */
}

/* ---- mode ---- */

function setActive(on: boolean): void {
  if (on === active) return;
  active = on;
  climb = 0;
  host.style.display = on ? "block" : "none";
  document.body.style.cursor = on ? "crosshair" : "";
  toggle.className = "hmi-pick-ui hmi-pick-toggle" + (on ? " on" : "");
  /* every handler is on the window in the CAPTURE phase and stops the event there, so while
     pick mode is on the application below sees no pointer input at all: no selection moves,
     no drag starts, no control is pressed by pointing at it */
  const swap = on
    ? (type: string, fn: EventListener, opts: AddEventListenerOptions) =>
        window.addEventListener(type, fn, opts)
    : (type: string, fn: EventListener, opts: AddEventListenerOptions) =>
        window.removeEventListener(type, fn, opts);
  swap("pointermove", onMove, { capture: true });
  swap("pointerdown", onDown, { capture: true });
  swap("pointerup", swallow, { capture: true });
  swap("click", swallow, { capture: true });
  swap("contextmenu", swallow, { capture: true });
  swap("wheel", onWheel, { capture: true, passive: false });
  if (on) {
    say("pick mode: click an element");
  } else {
    paint(null);
    hideToast();
  }
}

function onGlobalKey(ev: KeyboardEvent): void {
  if (ev.altKey && (ev.key === "p" || ev.key === "P")) {
    setActive(!active);
    ev.preventDefault();
    ev.stopPropagation();
    return;
  }
  if (!active) return;
  if (ev.key === "Escape") setActive(false);
  else if (ev.key === "ArrowUp") step(1);
  else if (ev.key === "ArrowDown") step(-1);
  else if (ev.key === "c" || ev.key === "C") copyAll(true);
  else if (ev.key === "x" || ev.key === "X") clearPicks();
  else return;
  ev.preventDefault();
  ev.stopPropagation();
}

/* ---- pointer ---- */

function onMove(ev: Event): void {
  const at = ev.target as Element | null;
  if (!at || ours(at)) return;
  swallow(ev);
  base = at;
  paint(up(at, climb));
}

function onDown(ev: Event): void {
  const at = ev.target as Element | null;
  if (at && ours(at)) return;      /* our own button stays clickable */
  swallow(ev);
  const pointer = ev as PointerEvent;
  if (pointer.button !== undefined && pointer.button !== 0) return;
  const from = target ?? (at ? up(at, climb) : null);
  const hit = pointer.shiftKey ? up(from, 1) : from;
  if (hit) capture(hit);
}

function onWheel(ev: Event): void {
  swallow(ev);
  step((ev as WheelEvent).deltaY < 0 ? 1 : -1);
}

function step(delta: number): void {
  climb = Math.max(0, climb + delta);
  if (base) paint(up(base, climb));
}

function swallow(ev: Event): void {
  ev.preventDefault();
  ev.stopPropagation();
}

function ours(node: Element): boolean {
  return Boolean(node.closest && node.closest(".hmi-pick-ui"));
}

function up(node: Element | null, levels: number): Element | null {
  let at = node;
  for (let i = 0; at && i < levels; ++i) {
    const parent = at.parentElement;
    if (!parent || parent === document.body || parent === document.documentElement) break;
    at = parent;
  }
  return at;
}

/* ---- the outline ---- */

function paint(node: Element | null): void {
  target = node;
  if (!node) {
    box.style.display = "none";
    tag.style.display = "none";
    return;
  }
  const rect = node.getBoundingClientRect();
  box.style.display = "block";
  box.style.left = rect.left + "px";
  box.style.top = rect.top + "px";
  box.style.width = Math.max(1, rect.width) + "px";
  box.style.height = Math.max(1, rect.height) + "px";
  tag.style.display = "block";
  tag.textContent = brief(node) + (climb ? "  (up " + climb + ")" : "");
  const above = rect.top > 22;
  tag.style.left = Math.max(2, rect.left) + "px";
  tag.style.top = (above ? rect.top - 20 : rect.bottom + 4) + "px";
}

function flash(): void {
  box.classList.add("hit");
  setTimeout(() => box.classList.remove("hit"), 180);
}

/* ---- capture ---- */

function capture(node: Element): void {
  const text = describeElement(node, picks.length + 1);
  picks.push(text);
  flash();
  /* the console copy is the always-available one: no permission, no secure-origin rule */
  console.log(text);
  copyAll(false);
}

function clearPicks(): void {
  picks.length = 0;
  say("cleared");
}

function copyAll(explicit: boolean): void {
  const text = picks.join("\n\n");
  if (!text) {
    say("nothing captured yet");
    return;
  }
  const label = picks.length === 1 ? "copied 1 pick" : "copied " + picks.length + " picks";
  write(text).then((ok) => {
    if (ok) say(explicit ? label + " again" : label);
    else showText(text);
  });
}

async function write(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* insecure origin, or the document was not focused: fall through */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/* ---- the description ---- */

/* exported so the whole description can be checked in a browser without synthesising
   gestures: everything above this line is plumbing, this is the part with an answer */
export function describeElement(node: Element, index = 1): string {
  const lines: string[] = ["[pick " + index + "] " + brief(node)];
  const add = (key: string, value: string) => {
    if (value) lines.push("  " + key + ": " + value);
  };
  add("path", pathOf(node));
  add("data", dataOf(node));
  add("widget", widgetOf(node));
  add("part", partOf(node));
  add("text", textOf(node));
  add("box", boxOf(node));
  add("view", viewOf());
  add("grep", grepOf(node));
  return lines.join("\n");
}

/* tag plus classes, the one form used for the target label and every path step */
function brief(node: Element): string {
  const raw = (node.getAttribute("class") ?? "").trim();
  const classes = raw ? raw.split(/\s+/).filter(Boolean) : [];
  const shown = classes.slice(0, MAX_CLASS).map((name) => "." + name).join("");
  const more = classes.length > MAX_CLASS ? "+" + (classes.length - MAX_CLASS) : "";
  const id = node.id ? "#" + node.id : "";
  return node.localName + id + shown + more;
}

function pathOf(node: Element): string {
  const steps: string[] = [];
  let at: Element | null = node;
  while (at && at !== document.body && at !== document.documentElement) {
    steps.unshift(brief(at));
    if (at.id === "app") break;
    at = at.parentElement;
  }
  const trimmed = steps.length > MAX_PATH ? steps.slice(steps.length - MAX_PATH) : steps;
  return (trimmed.length < steps.length ? "... > " : "") + trimmed.join(" > ");
}

/* data attributes on the element and its ancestors: what the app itself keys behavior on */
function dataOf(node: Element): string {
  const found: string[] = [];
  let at: Element | null = node;
  let depth = 0;
  while (at && at !== document.body && found.length < 6 && depth < 8) {
    if (at.id === "app") break;   /* the root's data-mode is already on the view line */
    for (const attr of Array.from(at.attributes)) {
      if (attr.name.indexOf("data-") !== 0) continue;
      const where = at === node ? "" : " (" + brief(at) + ")";
      found.push(attr.name + '="' + attr.value + '"' + where);
    }
    at = at.parentElement;
    ++depth;
  }
  return found.join("  ");
}

/* the canvas draws every widget as one <g data-id>, so a pick anywhere inside a widget can
   name the document node it belongs to. The app is read through the handle main.ts exposes,
   defensively: a shape change here must never break the picker or the app. */
function widgetOf(node: Element): string {
  const owner = node.closest ? (node.closest("[data-id]") as Element | null) : null;
  if (!owner) return "";
  const id = Number(owner.getAttribute("data-id"));
  if (!id) return "";
  let out = "#" + id;
  try {
    const app = (window as unknown as { app?: any }).app;
    const widget = app?.store?.widget?.(id);
    if (widget) {
      out += " " + widget.type;
      if (widget.label) out += ' "' + widget.label + '"';
      const geom = widget.geom;
      if (geom) out += "  geom " + geom.x + "," + geom.y + " " + geom.w + "x" + geom.h;
    }
    const page = app?.page?.();
    if (page?.name) out += '  on page "' + page.name + '"';
  } catch {
    /* the picker never fails because the app moved a field */
  }
  return out;
}

/* Template parts carry no identity of their own: they are drawn straight into the widget's
   <g>. Their draw kind and position in that group is what locates them in the type's
   template, so report those. */
function partOf(node: Element): string {
  const group = node.closest ? (node.closest("g.widget") as Element | null) : null;
  if (!group || group === node) return "";
  const parts = Array.from(group.querySelectorAll("*"));
  const at = parts.indexOf(node);
  if (at < 0) return "";
  return node.localName + " (node " + (at + 1) + " of " + parts.length + " in the widget)";
}

function textOf(node: Element): string {
  const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const cut = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + "..." : text;
  return '"' + cut + '"';
}

function boxOf(node: Element): string {
  const rect = node.getBoundingClientRect();
  const round = (value: number) => String(Math.round(value));
  return round(rect.left) + "," + round(rect.top) + " " +
    round(rect.width) + "x" + round(rect.height);
}

function viewOf(): string {
  try {
    const app = (window as unknown as { app?: any }).app;
    if (!app) return "";
    const view = app.view ?? {};
    const selection = Array.isArray(view.selection) ? view.selection : [];
    const version = app.store?.version?.();
    return "mode=" + view.mode + " selection=[" + selection.join(",") + "]" +
      (version === undefined ? "" : " doc v" + version);
  } catch {
    return "";
  }
}

/* Every element is built by el() with its class string written literally, so a class name is
   a search term that lands on the render site. The element's OWN classes are listed in full
   and in order: the first is the structural one here and the rest are usually state
   ("pill connecting", "widget disabled"), which is a judgement for the reader rather than a
   heuristic worth guessing. A template part carries no class and gets no line: the part and
   widget lines already say where it is drawn. */
function grepOf(node: Element): string {
  const raw = (node.getAttribute("class") ?? "").trim();
  return raw ? raw.split(/\s+/).filter(Boolean).join(" ") : "";
}

/* ---- the picker's own surface ---- */

function buildOverlay(): void {
  host = document.createElement("div");
  host.className = "hmi-pick-host";
  host.style.display = "none";
  box = document.createElement("div");
  box.className = "hmi-pick-box";
  tag = document.createElement("div");
  tag.className = "hmi-pick-tag";
  hint = document.createElement("div");
  hint.className = "hmi-pick-hint";
  hint.textContent =
    "click capture | shift+click parent | wheel widen | C copy | X clear | esc exit";
  toast = document.createElement("div");
  toast.className = "hmi-pick-toast";
  host.appendChild(box);
  host.appendChild(tag);
  host.appendChild(hint);
  host.appendChild(toast);
  document.body.appendChild(host);
}

function buildToggle(): void {
  toggle = document.createElement("button");
  toggle.className = "hmi-pick-ui hmi-pick-toggle";
  toggle.textContent = "pick";
  toggle.title = "element picker for dev notes (alt+P)";
  toggle.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    setActive(!active);
  });
  const status = document.querySelector(".topbar .status");
  if (status) status.insertBefore(toggle, status.firstChild);
  else {
    toggle.classList.add("loose");
    document.body.appendChild(toggle);
  }
}

function say(text: string): void {
  toast.textContent = text + (picks.length ? "  (" + picks.length + " held)" : "");
  toast.classList.add("on");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 1800) as unknown as number;
}

function hideToast(): void {
  toast.classList.remove("on");
  toastTimer = 0;
}

/* both clipboard routes refused: show the text so it can be selected by hand */
function showText(text: string): void {
  const panel = document.createElement("pre");
  panel.className = "hmi-pick-ui hmi-pick-fallback";
  panel.textContent = text + "\n\n(copy failed: select this text, then click to dismiss)";
  panel.addEventListener("click", () => panel.remove());
  document.body.appendChild(panel);
}

function injectStyles(): void {
  const style = document.createElement("style");
  style.textContent = `
.hmi-pick-host {
  position: fixed; inset: 0; z-index: 2147483000; pointer-events: none;
  font: 11px var(--mono, ui-monospace, Consolas, monospace);
}
.hmi-pick-box {
  position: fixed; display: none; border: 1px solid var(--acc, #4e8ef7);
  background: rgba(78, 142, 247, 0.12); box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
}
.hmi-pick-box.hit {
  border-color: #7fc4a0; background: rgba(127, 196, 160, 0.22);
}
.hmi-pick-tag {
  position: fixed; display: none; max-width: 70vw; overflow: hidden;
  white-space: nowrap; text-overflow: ellipsis; padding: 2px 6px;
  background: var(--acc, #4e8ef7); color: #0d1117; border-radius: 3px; font-weight: 600;
}
.hmi-pick-hint {
  position: fixed; left: 50%; bottom: 10px; transform: translateX(-50%);
  padding: 4px 10px; border-radius: 4px; background: rgba(20, 20, 20, 0.9);
  border: 1px solid var(--line, #2a2a2a); color: var(--muted, #9c9c9c);
}
.hmi-pick-toast {
  position: fixed; left: 50%; bottom: 38px; transform: translateX(-50%);
  padding: 4px 10px; border-radius: 4px; background: #7fc4a0; color: #10241b;
  font-weight: 600; opacity: 0; transition: opacity 120ms;
}
.hmi-pick-toast.on { opacity: 1; }
.hmi-pick-toggle {
  font: 10px var(--mono, ui-monospace, Consolas, monospace); letter-spacing: 0.04em;
  padding: 2px 8px; border-radius: 999px; cursor: pointer;
  background: var(--chip, #232323); color: var(--muted, #9c9c9c);
  border: 1px solid var(--line, #2a2a2a);
}
.hmi-pick-toggle.on {
  background: var(--acc, #4e8ef7); border-color: var(--acc, #4e8ef7); color: #0d1117;
}
.hmi-pick-toggle.loose { position: fixed; right: 10px; bottom: 10px; z-index: 2147483001; }
.hmi-pick-fallback {
  position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
  max-width: 80vw; max-height: 70vh; overflow: auto; margin: 0; padding: 12px;
  z-index: 2147483002; white-space: pre-wrap; cursor: pointer;
  background: var(--menu, #181818); color: var(--ink, #ececec);
  border: 1px solid var(--line, #2a2a2a); border-radius: 6px;
  font: 11px var(--mono, ui-monospace, Consolas, monospace);
}
`;
  document.head.appendChild(style);
}
