/* THE LOG AND ITS NOTIFICATIONS. One sidebar on the right edge of the window, beside
 * whatever workspace (or the operate view) is showing: every line the mesh's built-in
 * @dart/log/{error,warn,info} topics carried, and every notification a flow's `notify`
 * step spoke. The bar is closable (the L key toggles it) and drag-resizable by its own
 * gutter; open state and width are local preferences, like the sidebar widths.
 *
 * Notifications POP UP regardless of the bar: errors and level "notify" entries raise a
 * toast in the top right corner as they happen — on every connected view, because they
 * ride a broadcast frame. A toast stays for the entry's own `ms` when the author set
 * one; otherwise the time scales with the message's length, capped at ten seconds.
 * Only FRESH entries pop: the snapshot's backlog is history, and replaying it as
 * toasts on every reconnect would cry wolf. */

import { clear, el, iconButton } from "./dom.js";
import { LogEntry } from "./types.js";

const KEEP = 500;                /* rows the list holds; older ones drop off the top */
const WIDTH_MIN = 200;
const WIDTH_MAX = 800;
const TOASTS_MAX = 6;            /* a burst shows the newest, not a wall */
const TOAST_BASE_MS = 2000;      /* the auto duration: base + so much per character */
const TOAST_PER_CHAR_MS = 60;
const TOAST_CAP_MS = 10000;      /* the auto duration never exceeds this */
const TOAST_FADE_MS = 220;       /* matches the .toast transition in logbar.css */

function stamp(wall_us: number): string {
  const date = wall_us > 0 ? new Date(wall_us / 1000) : new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  return two(date.getHours()) + ":" + two(date.getMinutes()) + ":" + two(date.getSeconds());
}

export class LogView {
  private bar: HTMLElement;
  private gutter: HTMLElement;
  private list: HTMLElement;
  private toasts: HTMLElement;
  private isOpen: boolean;

  constructor(host: HTMLElement) {
    this.isOpen = localStorage.getItem("log-open") === "1";
    const saved = Number(localStorage.getItem("log-width"));
    if (Number.isFinite(saved) && saved >= WIDTH_MIN && saved <= WIDTH_MAX)
      document.documentElement.style.setProperty("--logbar", saved + "px");

    this.gutter = el("div", { class: "gutter log-gutter" });
    this.armGutter();
    this.list = el("div", { class: "log-list", "data-input": "text scroll" });
    this.bar = el("aside", { class: "logbar" }, [
      el("div", { class: "log-head" }, [
        el("span", { class: "log-title", text: "Log" }),
        el("span", { class: "log-head-tail" }, [
          iconButton("trash", "clear the view (the backlog is untouched)", () => {
            clear(this.list);
          }),
          iconButton("x", "close the log (L reopens it)", () => this.setOpen(false)),
        ]),
      ]),
      this.list,
    ]);
    /* the toasts are window furniture, not part of the bar: they show with it closed */
    this.toasts = el("div", { class: "toasts" });
    host.appendChild(this.gutter);
    host.appendChild(this.bar);
    host.appendChild(this.toasts);
    this.showOpen();
  }

  toggle(): void {
    this.setOpen(!this.isOpen);
  }

  setOpen(open: boolean): void {
    if (this.isOpen === open) return;
    this.isOpen = open;
    localStorage.setItem("log-open", open ? "1" : "0");
    this.showOpen();
    if (open) this.list.scrollTop = this.list.scrollHeight;
  }

  /* the one entry point for both wire carriers (protocol.ts): the snapshot's backlog
     REPLACES the list and never pops; a live frame appends and pops what pops */
  log(entries: LogEntry[], fresh: boolean): void {
    if (!fresh) clear(this.list);
    if (!entries.length) return;
    /* keep the view pinned to the newest line unless the reader scrolled up to study
       something — then arriving lines must not yank the page out from under them */
    const pinned =
      !fresh ||
      this.list.scrollTop + this.list.clientHeight >= this.list.scrollHeight - 8;
    for (const entry of entries) {
      this.list.appendChild(this.row(entry));
      if (fresh && (entry.level === "error" || entry.level === "notify"))
        this.toast(entry);
    }
    while (this.list.childElementCount > KEEP && this.list.firstChild)
      this.list.removeChild(this.list.firstChild);
    if (pinned) this.list.scrollTop = this.list.scrollHeight;
  }

  private row(entry: LogEntry): HTMLElement {
    return el("div", { class: "log-row " + entry.level }, [
      el("span", { class: "log-time", text: stamp(entry.wall_us) }),
      el("span", { class: "log-node", text: entry.node }),
      el("span", { class: "log-text", text: entry.text }),
    ]);
  }

  private toast(entry: LogEntry): void {
    const box = el("div", { class: "toast " + entry.level, title: "click to dismiss" }, [
      /* the source leads an error (the operator's first question is "who said that");
         an hmi notification is the page speaking, so it stands alone */
      entry.level === "error" ? el("span", { class: "toast-src", text: entry.node }) : null,
      el("span", { class: "toast-text", text: entry.text }),
    ]);
    let gone = false;
    const dismiss = () => {
      if (gone) return;
      gone = true;
      box.classList.add("hide");
      window.setTimeout(() => box.remove(), TOAST_FADE_MS);
    };
    box.addEventListener("click", dismiss);
    const life =
      entry.ms && entry.ms > 0
        ? entry.ms
        : Math.min(TOAST_CAP_MS, TOAST_BASE_MS + entry.text.length * TOAST_PER_CHAR_MS);
    window.setTimeout(dismiss, life);
    this.toasts.appendChild(box);
    while (this.toasts.childElementCount > TOASTS_MAX && this.toasts.firstChild)
      this.toasts.removeChild(this.toasts.firstChild);
  }

  private showOpen(): void {
    this.bar.hidden = !this.isOpen;
    this.gutter.hidden = !this.isOpen;
  }

  /* the same drag the workspace sidebars take, on the bar's own width variable */
  private armGutter(): void {
    this.gutter.addEventListener("pointerdown", (ev) => {
      const start = (ev as PointerEvent).clientX;
      const from = this.bar.getBoundingClientRect().width;
      const move = (m: PointerEvent) => {
        const width = Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, from + (start - m.clientX)));
        document.documentElement.style.setProperty("--logbar", width + "px");
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        const width = Math.round(this.bar.getBoundingClientRect().width);
        localStorage.setItem("log-width", String(width));
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      ev.preventDefault();
    });
  }
}
