// A wheel's turn as the editor's artboard and a running page both read it.

/** A line of text, as a wheel that counts lines turns by. */
const LINE = 33;

/** How far a wheel turned in px: a line 33 of them, and a page the `page` given. */
export function wheelPx(e: WheelEvent, page: { width: number; height: number }): { x: number; y: number } {
  const [kx, ky] = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? [LINE, LINE] : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? [page.width, page.height] : [1, 1];
  return { x: e.deltaX * kx, y: e.deltaY * ky };
}

/** The zoom a turn of `px` down makes, smaller as it turns down and never by a leap: a notch
 *  of 100 px about 0.82. A trackpad's pinch comes as such a turn. */
export function zoomBy(px: number): number {
  return Math.exp(-Math.max(-120, Math.min(120, px)) * 0.002);
}
