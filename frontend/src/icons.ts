/* Lucide geometry, inlined. Every icon is the INNER markup of a 24x24 stroked SVG, so one
 * wrapper serves them all and nothing is fetched at run time. The entity-kind marks and
 * their colours are the Build Sheet's: a kind is legible without reading text. */

export const ICONS: Record<string, string> = {
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  "chevron-right": '<path d="m9 18 6-6-6-6"/>',
  "arrow-left": '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  "arrow-right": '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  timer: '<line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/>',
  grip: '<circle cx="9" cy="12" r="1"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="19" r="1"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  unlock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
  reset: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  layers: '<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  unlink: '<path d="M9 17H7A5 5 0 0 1 7 7"/><path d="M15 7h2a5 5 0 0 1 3.7 8.4"/><path d="M8 12h4"/><path d="M2 2l20 20"/>',

  /* entity kinds: variable, topic, function, signal (the Build Sheet's marks) */
  "kind-V": '<path d="M8 21s-4-3-4-9 4-9 4-9"/><path d="M16 3s4 3 4 9-4 9-4 9"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  "kind-T": '<path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1.4"/>',
  "kind-F": '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 17c2 0 2.8-1 2.8-2.8V10c0-2 1-3.3 3.2-3"/><path d="M9 11.2h5.7"/>',
  "kind-S": '<path d="M13 2 4.6 12.6a1 1 0 0 0 .8 1.6H11l-1 7.8 8.4-10.6a1 1 0 0 0-.8-1.6H12z"/>',

  /* widget types, for the palette and the add menu */
  Button: '<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M8 12h8"/>',
  Toggle: '<rect x="2" y="7" width="20" height="10" rx="5"/><circle cx="16" cy="12" r="3"/>',
  Slider: '<path d="M3 12h18"/><circle cx="14" cy="12" r="3"/>',
  Readout: '<path d="M4 7h4"/><path d="M6 7v10"/><path d="M13 17h7"/><path d="M13 12h7"/>',
  Indicator: '<circle cx="12" cy="12" r="6"/>',
  Dropdown: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="m9 11 3 3 3-3"/>',
  Label: '<path d="M4 7V5h16v2"/><path d="M12 5v14"/><path d="M9 19h6"/>',
  Panel: '<rect x="3" y="4" width="18" height="16" rx="2"/>',
};

export const KIND_COLOR: Record<string, string> = {
  V: "#cf9a3a",
  L: "#cf9a3a",
  T: "#9a9a9f",
  F: "#4db6ac",
  S: "#46ae64",
};

export function kindColor(kind: string): string {
  return KIND_COLOR[kind] ?? "#8a8a8a";
}

export function iconMarkup(name: string, size = 11, width = 1.7): string {
  const inner = ICONS[name];
  if (!inner) return "";
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`
  );
}

export function iconEl(name: string, size = 11, width = 1.7): SVGElement {
  const holder = document.createElement("div");
  holder.innerHTML = iconMarkup(name, size, width);
  return holder.firstElementChild as SVGElement;
}

/* the kind mark in its tinted square: 15px, the colour carried by both glyph and tint */
export function kindMark(kind: string, title?: string): HTMLElement {
  const span = document.createElement("span");
  span.className = "kind-mark";
  span.style.color = kindColor(kind);
  span.style.background = kindColor(kind) + "2b";
  if (title) span.title = title;
  span.innerHTML = iconMarkup("kind-" + (kind === "L" ? "V" : kind), 11);
  return span;
}
