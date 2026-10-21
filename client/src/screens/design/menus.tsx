// The right click menus of the Design screen: on an element, in the canvas or the layers, and
// on the canvas around them. Each row does what a key or a button does too.

import { SHAPES } from "../../page/PageView";
import type { Page } from "../../protocol/Page";
import type { Tag } from "../../protocol/Tag";
import { state } from "../../state/store";
import { find } from "../../state/elements";
import { type MenuEntry, type MenuItem, openMenu } from "../../ui/Menu";
import { ArrowDown, ArrowUp, BringToFront, ClipboardPaste, Component, Copy, CopyPlus, Download, Group, Plus, Rows3, Scissors, SendToBack, Shapes, SquareDashedMousePointer, Trash, Ungroup } from "../../ui/icons";
import { savePicture, showsPicture } from "../../ui/Picture";
import { addElement, KINDS, STARTS } from "./add";
import { duplicate, pasteHere } from "./clipboard";
import { makeComponent } from "./component";
import type { Pick } from "./DesignScreen";
import { addShape, SHAPE_KINDS } from "./ShapeFields";
import { TagIcon } from "./TagIcon";
import { absolute, group, isGroup, parentOf, remove, restack, tops, ungroup, wrap } from "./tree";

/** A spot on the page, as the canvas was clicked. */
type Spot = { x: number; y: number };

/** Where an added element goes, as each menu says. */
type Put = (tag: Tag, props: Record<string, string>, component?: string) => void;

/** A row for each kind a person adds. */
const kindRows = (put: Put): MenuItem[] => KINDS.map(([tag, word]) => ({ label: word, icon: <TagIcon tag={tag} size={13} />, run: () => put(tag, STARTS[tag]) }));

/** A row whose submenu places each component but the one open. */
function placeRow(page: Page, put: Put, label: string): MenuItem {
  const components = state.pages.filter((pg) => pg.interface !== null && pg.id !== page.id);
  return {
    label,
    icon: <Component size={13} />,
    disabled: components.length === 0,
    items: components.length === 0 ? undefined : components.map((c) => ({ label: c.name, icon: <Component size={13} />, run: () => put("use", { name: c.name, w: String(c.width), h: String(c.height) }, c.name) })),
  };
}

/** What the layers pane's + offers: each kind, then a component to place. */
export const addMenu = (page: Page, put: Put): MenuEntry[] => [...kindRows(put), "-", placeRow(page, put, "Place a component")];

/** The same as submenus of a right click's menu. */
const adds = (page: Page, put: Put, inside = ""): MenuEntry[] => [{ label: `Add${inside}`, icon: <Plus size={13} />, items: kindRows(put) }, placeRow(page, put, `Place a component${inside}`)];

/** The browser copies only in a copy event, which a menu row can ask for in its click. */
const copySelection = () => document.execCommand("copy");

/** The menu on an element. It acts on the selection, which it becomes first unless the
 *  element is already in it. A frame adds inside itself, at `spot` when the canvas was
 *  clicked, and a diagram or a shape adds shapes. */
export function elementMenu(e: MouseEvent, page: Page, selected: string[], pick: Pick, id: string, spot?: Spot) {
  const ids = selected.includes(id) ? selected : [id];
  if (!selected.includes(id)) pick(id);
  const picked = tops(page, ids);
  const one = picked.length === 1 ? picked[0].id : null;
  const holder = one && parentOf(page, one);
  const element = find(page.children, id);
  const entries: MenuEntry[] = [];
  if (element?.tag === "div" && one === id) {
    const box = absolute(page, id);
    const at = spot && box ? { x: spot.x - box.x, y: spot.y - box.y } : undefined;
    entries.push(...adds(page, (tag, props, component) => addElement(page, id, tag, props, component ?? null, at), " inside"), "-");
  } else if (element && (element.tag === "svg" || SHAPES.has(element.tag)) && one === id) {
    entries.push({ label: "Add shape", icon: <Shapes size={13} />, items: SHAPE_KINDS.map((tag) => ({ label: tag, icon: <TagIcon tag={tag} size={13} />, run: () => addShape(page, element, tag) })) }, "-");
  }
  entries.push(
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
    { label: "Group", keys: "Ctrl G", icon: <Group size={13} />, disabled: picked.some((x) => parentOf(page, x.id) !== parentOf(page, picked[0].id)), run: () => group(page, ids) },
    {
      label: "Lay out in a new frame",
      keys: "Shift A",
      icon: <Rows3 size={13} />,
      disabled: picked.some((x) => SHAPES.has(x.tag) || parentOf(page, x.id) !== parentOf(page, picked[0].id)),
      run: () => wrap(page, ids),
    },
  );
  if (picked.some(isGroup)) {
    entries.push({
      label: "Ungroup",
      keys: "Ctrl Shift G",
      icon: <Ungroup size={13} />,
      run: () => ungroup(page, ids).forEach((held, i) => pick(held, i > 0)),
    });
  }
  entries.push(
    "-",
    { label: "Convert to component", icon: <Component size={13} />, run: () => makeComponent(page, ids) },
  );
  if (one) {
    entries.push(
      "-",
      { label: "Bring forward", keys: "Ctrl ]", icon: <ArrowUp size={13} />, run: () => restack(page, one, "forward") },
      { label: "Send backward", keys: "Ctrl [", icon: <ArrowDown size={13} />, run: () => restack(page, one, "backward") },
      { label: "Bring to front", keys: "Ctrl Shift ]", icon: <BringToFront size={13} />, run: () => restack(page, one, "front") },
      { label: "Send to back", keys: "Ctrl Shift [", icon: <SendToBack size={13} />, run: () => restack(page, one, "back") },
    );
  }
  if (holder) entries.push("-", { label: "Select parent", icon: <SquareDashedMousePointer size={13} />, run: () => pick(holder) });
  const drawn = (e.target as HTMLElement).closest(".el[data-id]");
  if (one === id && drawn && showsPicture(drawn)) entries.push("-", { label: "Save picture", icon: <Download size={13} />, run: () => savePicture(drawn, element?.props.name ?? "picture") });
  entries.push("-", { label: picked.length > 1 ? `Delete ${picked.length}` : "Delete", keys: "Del", icon: <Trash size={13} />, run: () => remove(page, picked) });
  openMenu(e, entries);
}

/** The menu on the layers' empty space: what adds to the page itself, at its top level. */
export function layersMenu(e: MouseEvent, page: Page, pick: Pick, selectAll: () => void) {
  pick(null);
  openMenu(e, [
    ...adds(page, (tag, props, component) => addElement(page, null, tag, props, component ?? null)),
    "-",
    { label: "Paste", keys: "Ctrl V", icon: <ClipboardPaste size={13} />, run: () => void pasteHere(page, null) },
    { label: "Select all", keys: "Ctrl A", run: selectAll },
  ]);
}

/** The menu on the canvas around the elements, `at` the spot on the page it opened at. */
export function canvasMenu(e: MouseEvent, page: Page, at: Spot, pick: Pick, selectAll: () => void) {
  pick(null);
  openMenu(e, [
    ...adds(page, (tag, props, component) => addElement(page, null, tag, props, component ?? null, at)),
    "-",
    { label: "Paste here", keys: "Ctrl V", icon: <ClipboardPaste size={13} />, run: () => void pasteHere(page, null, at) },
    { label: "Select all", keys: "Ctrl A", run: selectAll },
  ]);
}
