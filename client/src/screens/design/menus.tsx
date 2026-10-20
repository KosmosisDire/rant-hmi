// The right click menus of the Design screen: on an element, in the canvas or the layers, and
// on the canvas around them. Each row does what a key or a button does too.

import type { Page } from "../../protocol/Page";
import { type MenuEntry, openMenu } from "../../ui/Menu";
import { ArrowDown, ArrowUp, BringToFront, ClipboardPaste, Component, Copy, CopyPlus, Scissors, SendToBack, SquareDashedMousePointer, Trash } from "../../ui/icons";
import { duplicate, pasteHere } from "./clipboard";
import { makeComponent } from "./component";
import type { Pick } from "./DesignScreen";
import { parentOf, remove, restack, tops } from "./tree";

/** The browser copies only in a copy event, which a menu row can ask for in its click. */
const copySelection = () => document.execCommand("copy");

/** The menu on an element. It acts on the selection, which it becomes first unless the
 *  element is already in it. */
export function elementMenu(e: MouseEvent, page: Page, selected: string[], pick: Pick, id: string) {
  const ids = selected.includes(id) ? selected : [id];
  if (!selected.includes(id)) pick(id);
  const picked = tops(page, ids);
  const one = picked.length === 1 ? picked[0].id : null;
  const holder = one && parentOf(page, one);
  const entries: MenuEntry[] = [
    {
      label: "Cut",
      keys: "Ctrl X",
      icon: <Scissors size={13} />,
      run: () => {
        copySelection();
        remove(page, picked);
      },
    },
    { label: "Copy", keys: "Ctrl C", icon: <Copy size={13} />, run: copySelection },
    { label: "Paste", keys: "Ctrl V", icon: <ClipboardPaste size={13} />, run: () => void pasteHere(page, ids.at(-1) ?? null) },
    { label: "Duplicate", keys: "Ctrl D", icon: <CopyPlus size={13} />, run: () => duplicate(page, picked) },
    "-",
    { label: "Make a component", icon: <Component size={13} />, run: () => makeComponent(page, ids) },
  ];
  if (one) {
    entries.push(
      "-",
      { label: "Bring forward", keys: "Ctrl ]", icon: <ArrowUp size={13} />, run: () => restack(page, one, "forward") },
      { label: "Send backward", keys: "Ctrl [", icon: <ArrowDown size={13} />, run: () => restack(page, one, "backward") },
      { label: "Bring to front", keys: "Ctrl Shift ]", icon: <BringToFront size={13} />, run: () => restack(page, one, "front") },
      { label: "Send to back", keys: "Ctrl Shift [", icon: <SendToBack size={13} />, run: () => restack(page, one, "back") },
    );
  }
  if (holder) entries.push("-", { label: "Select what holds it", icon: <SquareDashedMousePointer size={13} />, run: () => pick(holder) });
  entries.push("-", { label: picked.length > 1 ? `Delete ${picked.length}` : "Delete", keys: "Del", icon: <Trash size={13} />, run: () => remove(page, picked) });
  openMenu(e, entries);
}

/** The menu on the canvas around the elements. `at` is the spot on the page it opened at. */
export function canvasMenu(e: MouseEvent, page: Page, at: { x: number; y: number }, pick: Pick, selectAll: () => void) {
  pick(null);
  openMenu(e, [
    { label: "Paste here", keys: "Ctrl V", icon: <ClipboardPaste size={13} />, run: () => void pasteHere(page, null, at) },
    { label: "Select all", keys: "Ctrl A", run: selectAll },
  ]);
}
