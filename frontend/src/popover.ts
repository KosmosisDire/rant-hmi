/* THE overlay shell: a full-screen dismiss overlay owning one popover box, so any
 * click (or right-click) outside closes it and nothing else has to track "is one
 * open". The context menu, the source/type trees and the color picker each keep
 * their own shell instance — ids, stacking and per-shell CSS stay theirs — but the
 * dismiss/wheel/placement machinery lives here once. */

import { el } from "./dom.js";

export interface PlaceOpts {
  fallbackW?: number;  /* measured-zero fallbacks: the box may not be laid out yet */
  fallbackH?: number;
  minW?: number;       /* the tree popovers never place narrower than their design width */
  gap?: number;        /* distance from the anchor edge (the findings popover keeps 6) */
  clampFlip?: boolean; /* keep a flipped-up box on screen */
  exact?: boolean;     /* measure the rendered rect instead of offset sizes */
}

/* keep a box on screen: pinned to a point (a context menu at the click), or under an
 * anchor rect, flipped above it when the bottom would overflow */
export function placeBox(
  box: HTMLElement,
  at: { x: number; y: number } | { left: number; top: number; bottom: number },
  opts: PlaceOpts = {},
): void {
  const gap = opts.gap ?? 4;
  let width: number;
  let height: number;
  if (opts.exact) {
    const size = box.getBoundingClientRect();
    width = size.width;
    height = size.height;
  } else {
    width = box.offsetWidth || opts.fallbackW || 180;
    height = box.offsetHeight || opts.fallbackH || 120;
    if (opts.minW) width = Math.max(width, opts.minW);
  }
  if (!("bottom" in at)) {
    box.style.left = Math.min(at.x, window.innerWidth - width - 8) + "px";
    box.style.top = Math.min(at.y, window.innerHeight - height - 8) + "px";
    return;
  }
  box.style.left = Math.max(8, Math.min(at.left, window.innerWidth - width - 8)) + "px";
  const flipped = at.bottom + height + 8 > window.innerHeight;
  box.style.top =
    (!flipped ? at.bottom + gap
     : opts.clampFlip ? Math.max(8, at.top - height - gap)
     : at.top - height - gap) + "px";
}

export interface ShellOpts {
  id: string;       /* the overlay's element id — its stylesheet keys off it */
  boxClass: string;
  /* how the backdrop dismisses: the menu closes on any bubbled click (its rows stop
     propagation or close themselves first), the pickers only on a pointerdown that
     lands on the backdrop itself */
  dismiss: "click" | "backdrop";
  /* whether a right-click inside the box also dismisses; the trees keep it */
  contextDismiss?: "anywhere" | "backdrop";
  /* re-dispatch wheel events to whatever sits beneath, so zooming the canvas
     mid-pick works; "block" also cancels the original */
  wheel?: "passive" | "block";
  onDismiss?: () => void;
}

export interface Shell {
  box: HTMLElement;
  isOpen(): boolean;
  /* show without placing, for callers that scroll content into view first */
  show(anchor?: HTMLElement): void;
  openAt(x: number, y: number, place?: PlaceOpts): void;
  openUnder(anchor: HTMLElement, place?: PlaceOpts): void;
  close(): void;
  /* the pointerup that ends a long-press must not immediately close the menu it opened */
  armSwallow(): void;
}

export function makeShell(opts: ShellOpts): Shell {
  const box = el("div", { class: opts.boxClass });
  const overlay = el("div", { id: opts.id }, [box]);
  let swallow = false;
  let anchor: HTMLElement | null = null;
  let watch: MutationObserver | null = null;

  const unwatch = () => {
    watch?.disconnect();
    watch = null;
    anchor = null;
  };

  const close = () => {
    overlay.classList.remove("on");
    unwatch();
    opts.onDismiss?.();
  };

  const show = (at?: HTMLElement) => {
    overlay.classList.add("on");
    unwatch();
    anchor = at ?? null;
    /* a rebuild that reconciles the anchor away closes the popover instead of
       stranding it over a panel that no longer holds it (guarded: the test shim
       has no MutationObserver) */
    if (anchor && typeof MutationObserver !== "undefined") {
      watch = new MutationObserver(() => {
        if (anchor && !anchor.isConnected) close();
      });
      watch.observe(document.body, { childList: true, subtree: true });
    }
  };

  if (opts.dismiss === "click") {
    overlay.addEventListener("click", () => {
      if (swallow) {
        swallow = false;
        return;
      }
      close();
    });
  } else {
    overlay.addEventListener("pointerdown", (ev) => {
      if (ev.target === overlay) close();
    });
  }
  overlay.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    if (opts.contextDismiss !== "backdrop" || ev.target === overlay) close();
  });
  if (opts.wheel) {
    overlay.addEventListener(
      "wheel",
      (ev) => {
        if (ev.target !== overlay) return;
        if (opts.wheel === "block") ev.preventDefault();
        overlay.style.pointerEvents = "none";
        const under = document.elementFromPoint(ev.clientX, ev.clientY);
        overlay.style.pointerEvents = "";
        under?.dispatchEvent(new WheelEvent("wheel", ev));
      },
      { passive: opts.wheel === "passive" },
    );
  }
  document.body.appendChild(overlay);

  return {
    box,
    isOpen: () => overlay.classList.contains("on"),
    show,
    openAt(x, y, place) {
      show();
      placeBox(box, { x, y }, place);
    },
    openUnder(at, place) {
      show(at);
      placeBox(box, at.getBoundingClientRect(), place);
    },
    close,
    armSwallow: () => {
      swallow = true;
    },
  };
}
