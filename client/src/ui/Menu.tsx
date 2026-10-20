// The app's own right click menu: the actions that fit where the pointer is, in place of the
// browser's. One is open at a time. Arrows walk it, Enter runs a row, Escape closes it.

import { createSignal, For, type JSX, onMount, Show } from "solid-js";
import { ChevronRight } from "./icons";
import { Popover } from "./Popover";

export interface MenuItem {
  label: string;
  /** The keys that do it too, shown on the right. */
  keys?: string;
  icon?: JSX.Element;
  disabled?: boolean;
  run?: () => void;
  /** A submenu, which opens beside the row. */
  items?: MenuEntry[];
}

/** A row, or "-" for a line between groups. */
export type MenuEntry = MenuItem | "-";

const [shown, setShown] = createSignal<{ x: number; y: number; entries: MenuEntry[] } | null>(null);

/** Opens a menu at the pointer for a right click, unless it has nothing to offer there. */
export function openMenu(e: MouseEvent, entries: MenuEntry[]) {
  if (!entries.some((m) => m !== "-")) return;
  e.preventDefault();
  e.stopPropagation();
  setShown({ x: e.clientX, y: e.clientY, entries });
}

export const closeMenu = () => setShown(null);

/** Copies text from a row's click. Plain http has no clipboard API, but a copy event the
 *  click asks for may carry text, and nothing else hears this one. */
export function copyText(text: string) {
  const put = (e: ClipboardEvent) => {
    e.clipboardData?.setData("text/plain", text);
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  document.addEventListener("copy", put, true);
  document.execCommand("copy");
  document.removeEventListener("copy", put, true);
}

/** Where the open menu draws, once in the app's frame. */
export function MenuHost() {
  return <Show when={shown()}>{(m) => <List anchor={{ x: m().x, y: m().y }} entries={m().entries} onClose={closeMenu} />}</Show>;
}

function List(p: { anchor: HTMLElement | { x: number; y: number }; entries: MenuEntry[]; onClose: () => void; side?: boolean }) {
  const [sub, setSub] = createSignal<{ row: HTMLElement; items: MenuEntry[] } | null>(null);
  let list!: HTMLDivElement;
  const rows = () => [...list.querySelectorAll<HTMLButtonElement>(":scope > .menu-item:not(:disabled)")];
  const run = (m: MenuItem) => {
    closeMenu();
    m.run?.();
  };
  onMount(() => rows()[0]?.focus());
  const key = (e: KeyboardEvent) => {
    const all = rows();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      all[(at + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length]?.focus();
    } else if (e.key === "ArrowLeft" && p.side) {
      e.preventDefault();
      p.onClose();
    }
  };
  return (
    <Popover anchor={p.anchor} onClose={p.onClose} class="menu" side={p.side}>
      <div ref={list} class="menu-list" onKeyDown={key}>
        <For each={p.entries}>
          {(m) =>
            m === "-" ? (
              <div class="menu-line" />
            ) : (
              <button
                class="menu-item"
                classList={{ open: sub()?.items === m.items && !!m.items }}
                disabled={m.disabled}
                onPointerEnter={(e) => (m.items ? setSub({ row: e.currentTarget, items: m.items }) : setSub(null))}
                onKeyDown={(e) => {
                  if (m.items && (e.key === "ArrowRight" || e.key === "Enter")) {
                    e.preventDefault();
                    setSub({ row: e.currentTarget, items: m.items });
                  }
                }}
                onClick={() => (m.items ? undefined : run(m))}
              >
                <span class="menu-icon">{m.icon}</span>
                <span class="menu-label">{m.label}</span>
                <Show when={m.keys}>
                  <span class="menu-keys">{m.keys}</span>
                </Show>
                <Show when={m.items}>
                  <ChevronRight size={13} />
                </Show>
              </button>
            )
          }
        </For>
      </div>
      <Show when={sub()}>{(s) => <List anchor={s().row} entries={s().items} onClose={() => setSub(null)} side />}</Show>
    </Popover>
  );
}
