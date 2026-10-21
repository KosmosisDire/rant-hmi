import { createSignal, onCleanup } from "solid-js";

/** Calls `f` whenever `el` changes size, until the scope it is called in ends. */
export function onResize(el: Element, f: () => void) {
  const watch = new ResizeObserver(() => f());
  watch.observe(el);
  onCleanup(() => watch.disconnect());
}

/** An element's inner size, kept current once it is given the element to `track`. */
export function createSize() {
  const [size, setSize] = createSignal({ w: 0, h: 0 });
  let el: HTMLElement | undefined;
  let watch: ResizeObserver | undefined;
  onCleanup(() => watch?.disconnect());
  const measure = () => el && setSize({ w: el.clientWidth, h: el.clientHeight });
  return Object.assign(size, {
    /** Follows `target` from now on, in place of any before. */
    track(target: HTMLElement) {
      el = target;
      watch?.disconnect();
      watch = new ResizeObserver(measure);
      watch.observe(target);
    },
    /** Reads the size at once, as when it shows after being hidden. */
    measure,
  });
}
