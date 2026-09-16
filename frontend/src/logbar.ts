/* THE LOG AND ITS NOTIFICATIONS. One sidebar on the right edge of the window, beside
 * whatever workspace (or the operate view) is showing: every line the mesh's built-in
 * @rant/log/{error,warn,info} topics carried, every notification a flow's `notify`
 * step spoke, and the backend's own runtime faults (coalesced per site before they
 * ever reach the wire). The bar is closable (the L key toggles it) and drag-resizable
 * by its own gutter; open state and width are local preferences, like the sidebar
 * widths.
 *
 * SEARCH AND FILTERS: a search box and a funnel button head the list — filter by
 * level, by source node, by time frame, or by text. Filters are a way of LOOKING, not
 * a state of the log: they are deliberately never persisted, and while any is active
 * the funnel lights up and a strip above the list counts "showing N / M logs", so a
 * filtered view can never be mistaken for a quiet system. Filters touch only the
 * list; what pops as a toast is never filtered.
 *
 * Notifications POP UP regardless of the bar: errors and level "notify" entries raise
 * a toast in the top right corner as they happen — on every connected view, because
 * they ride a broadcast frame. A toast stays for the entry's own `ms` when the author
 * set one; otherwise the time scales with the message's length, capped at ten
 * seconds. Only FRESH entries pop: the snapshot's backlog is history, and replaying
 * it as toasts on every reconnect would cry wolf. */

import { clear, el, iconButton } from "./dom.js";
import { iconMarkup } from "./icons.js";
import { LogEntry } from "./types.js";

const KEEP = 500;                /* rows the list holds; older ones drop off the top */
const WIDTH_MIN = 200;
const WIDTH_MAX = 800;
const TOASTS_MAX = 6;            /* a burst shows the newest, not a wall */
const TOAST_BASE_MS = 2000;      /* the auto duration: base + so much per character */
const TOAST_PER_CHAR_MS = 60;
const TOAST_CAP_MS = 10000;      /* the auto duration never exceeds this */
const TOAST_FADE_MS = 220;       /* matches the .toast transition in logbar.css */

const LEVELS = ["error", "warn", "info", "notify"];
/* the time-frame presets: how far back the list looks (0 = all time) */
const SPANS: { label: string; ms: number }[] = [
  { label: "all", ms: 0 },
  { label: "1m", ms: 60_000 },
  { label: "5m", ms: 300_000 },
  { label: "15m", ms: 900_000 },
  { label: "1h", ms: 3_600_000 },
];

/* the auto life of a popped message: scales with reading length. The shell's warning
 * banner keeps the same clock, so nothing that pops stays a different amount of time. */
export function messageLife(text: string): number {
  return Math.min(TOAST_CAP_MS, TOAST_BASE_MS + text.length * TOAST_PER_CHAR_MS);
}

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
  private search: HTMLInputElement;
  private funnel: HTMLElement;
  private filterbar: HTMLElement;
  private shownOf: HTMLElement;
  private pop: HTMLElement;
  private isOpen: boolean;

  /* the filters: EXCLUDE sets (a node that appears later is shown until someone hides
     it), a lookback span, and the search text — session-local, never persisted */
  private levelsOff = new Set<string>();
  private nodesOff = new Set<string>();
  private spanMs = 0;
  private query = "";
  /* re-applies a standing time-frame filter as rows age out of it */
  private ageTimer = 0;
  private unarmPop: (() => void) | null = null;

  constructor(host: HTMLElement) {
    this.isOpen = localStorage.getItem("log-open") === "1";
    const saved = Number(localStorage.getItem("log-width"));
    if (Number.isFinite(saved) && saved >= WIDTH_MIN && saved <= WIDTH_MAX)
      document.documentElement.style.setProperty("--logbar", saved + "px");

    this.gutter = el("div", { class: "gutter log-gutter" });
    this.armGutter();
    this.list = el("div", { class: "log-list", "data-input": "text scroll" });
    this.search = el("input", {
      class: "field log-search",
      type: "text",
      placeholder: "search",
      oninput: () => {
        this.query = this.search.value.trim().toLowerCase();
        this.applyFilters();
      },
    }) as HTMLInputElement;
    this.funnel = el("button", {
      class: "icon-btn log-funnel",
      title: "filter by level, node or time",
      html: iconMarkup("funnel", 14, 1.7),
      onclick: () => (this.pop.hidden ? this.openPop() : this.closePop()),
    });
    this.shownOf = el("span", { class: "log-shownof" });
    this.filterbar = el("div", { class: "log-filterbar", hidden: true }, [
      this.shownOf,
      el("button", {
        class: "log-clearfilters",
        text: "clear",
        title: "show everything again",
        onclick: () => this.clearFilters(),
      }),
    ]);
    this.pop = el("div", { class: "log-pop", hidden: true });
    this.bar = el("aside", { class: "logbar" }, [
      el("div", { class: "log-head" }, [
        el("span", { class: "log-title", text: "Log" }),
        el("span", { class: "log-head-tail" }, [
          iconButton("trash", "clear the view (the backlog is untouched)", () => {
            clear(this.list);
            this.applyFilters();
          }),
          iconButton("x", "close the log (L reopens it)", () => this.setOpen(false)),
        ]),
      ]),
      el("div", { class: "log-tools" }, [this.search, this.funnel]),
      this.filterbar,
      this.pop,
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
    else this.closePop();
  }

  /* the one entry point for both wire carriers (protocol.ts): the snapshot's backlog
     REPLACES the list and never pops; a live frame appends and pops what pops */
  log(entries: LogEntry[], fresh: boolean): void {
    if (!fresh) clear(this.list);
    if (!entries.length) {
      if (!fresh) this.applyFilters();
      return;
    }
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
    this.applyFilters();
    if (pinned) this.list.scrollTop = this.list.scrollHeight;
  }

  private row(entry: LogEntry): HTMLElement {
    const node = el("div", { class: "log-row " + entry.level }, [
      /* the stamp and the source share one fixed-width column (logbar.css), so the
         message always starts at the same x; hover reads a clipped name in full */
      el("span", { class: "log-meta" }, [
        el("span", { class: "log-time", text: stamp(entry.wall_us) }),
        el("span", { class: "log-node", text: entry.node, title: entry.node }),
      ]),
      el("span", { class: "log-text", text: entry.text }),
    ]);
    /* what the filters read: the level and node verbatim, the wall clock in ms, and
       one lowercase haystack for the search box */
    node.dataset.level = entry.level;
    node.dataset.node = entry.node;
    node.dataset.wall = String(entry.wall_us > 0 ? entry.wall_us / 1000 : Date.now());
    node.dataset.find = (entry.node + " " + entry.text).toLowerCase();
    return node;
  }

  /* ---- filters ---- */

  private filtersActive(): boolean {
    return this.levelsOff.size > 0 || this.nodesOff.size > 0 || this.spanMs > 0 ||
           this.query.length > 0;
  }

  private applyFilters(): void {
    const cutoff = this.spanMs ? Date.now() - this.spanMs : 0;
    let shown = 0;
    let total = 0;
    for (const child of Array.from(this.list.children)) {
      const row = child as HTMLElement;
      total++;
      const hit =
        !this.levelsOff.has(row.dataset.level ?? "") &&
        !this.nodesOff.has(row.dataset.node ?? "") &&
        (!cutoff || Number(row.dataset.wall) >= cutoff) &&
        (!this.query || (row.dataset.find ?? "").includes(this.query));
      row.hidden = !hit;
      if (hit) shown++;
    }
    /* THE FORGET-PROOFING: while anything is filtered, the funnel lights and the
       strip counts what is hidden — a filtered log never reads as a quiet one. The
       count is the whole message; the funnel holds the detail. */
    const active = this.filtersActive();
    this.funnel.classList.toggle("on", active);
    this.filterbar.hidden = !active;
    if (active)
      this.shownOf.textContent = "showing " + shown + " / " + total + " logs";
    /* a standing time frame ages rows out on its own clock, traffic or not */
    if (this.spanMs && !this.ageTimer)
      this.ageTimer = window.setInterval(() => this.applyFilters(), 10000);
    if (!this.spanMs && this.ageTimer) {
      window.clearInterval(this.ageTimer);
      this.ageTimer = 0;
    }
  }

  private clearFilters(): void {
    this.levelsOff.clear();
    this.nodesOff.clear();
    this.spanMs = 0;
    this.query = "";
    this.search.value = "";
    this.closePop();
    this.applyFilters();
    this.list.scrollTop = this.list.scrollHeight;
  }

  /* the filter popover, rebuilt per open: levels, the nodes the log has seen (plus
     any already hidden, so they can be brought back), and the time frame */
  private openPop(): void {
    /* a re-open (the span row re-renders through here) must not stack listeners */
    this.unarmPop?.();
    this.unarmPop = null;
    clear(this.pop);
    const section = (title: string, rows: HTMLElement[]) =>
      this.pop.appendChild(el("div", { class: "log-pop-section" }, [
        el("div", { class: "log-pop-title", text: title }),
        ...rows,
      ]));
    const checkRow = (label: string, offSet: Set<string>, key: string) => {
      const box = el("input", { type: "checkbox", checked: !offSet.has(key) }) as HTMLInputElement;
      box.addEventListener("change", () => {
        if (box.checked) offSet.delete(key);
        else offSet.add(key);
        this.applyFilters();
      });
      return el("label", { class: "log-pop-row" }, [box, el("span", { text: label })]);
    };

    section("levels", LEVELS.map((level) => checkRow(level, this.levelsOff, level)));

    const nodes = new Set<string>(this.nodesOff);
    for (const child of Array.from(this.list.children))
      nodes.add((child as HTMLElement).dataset.node ?? "");
    nodes.delete("");
    section("nodes", [...nodes].sort().map((n) => checkRow(n, this.nodesOff, n)));

    const spans = el("div", { class: "log-pop-spans" }, SPANS.map((span) =>
      el("button", {
        class: span.ms === this.spanMs ? "on" : "",
        text: span.label,
        onclick: () => {
          this.spanMs = span.ms;
          this.applyFilters();
          this.openPop();   /* re-render so the pressed preset shows */
        },
      })));
    section("time frame", [spans]);

    this.pop.appendChild(el("button", {
      class: "log-pop-reset",
      text: "reset filters",
      onclick: () => this.clearFilters(),
    }));
    this.pop.hidden = false;

    /* dismiss on any press outside the popover or its button */
    const away = (ev: PointerEvent) => {
      const at = ev.target as Element | null;
      if (at && (this.pop.contains(at) || this.funnel.contains(at))) return;
      this.closePop();
    };
    window.addEventListener("pointerdown", away, true);
    this.unarmPop = () => window.removeEventListener("pointerdown", away, true);
  }

  private closePop(): void {
    this.pop.hidden = true;
    this.unarmPop?.();
    this.unarmPop = null;
  }

  /* ---- toasts ---- */

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
    const life = entry.ms && entry.ms > 0 ? entry.ms : messageLife(entry.text);
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
