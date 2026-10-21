import { batch, createEffect, createSignal, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { UNIT } from "../../state/bind";
import { onMoved, state } from "../../state/store";
import { currentPage, openPage, tookWanted, wanted } from "../../state/view";
import { Edge, reveal, Sidebar } from "../../ui/Sidebars";
import { Artboard, GRID, STEP } from "./Artboard";
import { copy, duplicate, paste } from "./clipboard";
import { ElementInspector } from "./ElementInspector";
import { Outline } from "./Outline";
import { find, group, remove, restack, sendEdits, shiftBy, tops, ungroup, wrap } from "./tree";

/** Picks an element, or with `add` puts it in or takes it out of the selection. None lets go. */
export type Pick = (id: string | null, add?: boolean) => void;

/** A request to type into an element's field: `key`'s, else its main one. `n` counts. */
export interface Typing {
  id: string;
  key?: string;
  n: number;
}

export function DesignScreen(p: { shown: boolean }) {
  const [selection, setSelection] = createSignal<string[]>([]);
  const pick: Pick = (id, add = false) => {
    if (!id) setSelection([]);
    else if (!add) setSelection([id]);
    else setSelection((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  };
  const [keys, setKeys] = createSignal(false);
  const [typing, setTyping] = createSignal<Typing | null>(null);
  let typed = 0;
  /** Picks an element alone and puts the caret in its field, as a double click does. */
  const edit = (id: string, key?: string) =>
    batch(() => {
      setSelection([id]);
      setTyping({ id, key, n: ++typed });
    });
  // a request lasts while its element is the one selected
  createEffect(() => {
    const t = typing();
    const s = selection();
    if (t && !(s.length === 1 && s[0] === t.id)) setTyping(null);
  });

  // what this screen just made: a new page opens, a new element is selected
  createEffect(
    on(
      () => state.made?.n,
      () => {
        const m = state.made;
        if (!m) return;
        if (m.id === m.page) {
          openPage(m.page);
          setSelection([]);
        } else if (m.page === currentPage()?.id) {
          setSelection([m.id]);
        }
      },
      { defer: true },
    ),
  );

  // another page opened starts with nothing selected, since ids repeat across pages, unless
  // an element on it was asked for, as the Logic tab asks for a handler's, once this shows
  let at = currentPage()?.id;
  onCleanup(onMoved((from, to) => at === from && (at = to)));
  createEffect(() => {
    const id = currentPage()?.id;
    const w = p.shown ? wanted() : null;
    untrack(() => {
      if (w && w.page === id) {
        edit(w.element, w.event === undefined ? undefined : `on:${w.event}`);
        tookWanted();
      } else if (id !== at) {
        setSelection([]);
      }
      at = id;
    });
  });

  // on a phone an element picked from the drawer or tapped on the page shows in the sheet
  const pickShown: Pick = (id, add) => {
    pick(id, add);
    if (id) reveal();
  };
  const tapped = (e: MouseEvent) => document.elementFromPoint(e.clientX, e.clientY)?.closest(".page-layer .el[data-id]") && reveal();

  // an element that went away leaves the selection
  createEffect(() => {
    const page = currentPage();
    const kept = selection().filter((id) => page && find(page.children, id));
    if (kept.length !== selection().length) setSelection(kept);
  });

  // the keys the artboard's list shows, and ? for the list. A field keeps its own keys.
  // Escape closes the list first, then lets go.
  onMount(() => {
    const key = (e: KeyboardEvent) => {
      if (!p.shown || (e.target as HTMLElement).closest("input, textarea, select")) return;
      const mod = e.ctrlKey || e.metaKey;
      const letter = e.key.toLowerCase();
      if (e.key === "?") {
        setKeys(!keys());
        return;
      }
      if (e.key === "Escape" && keys()) {
        setKeys(false);
        return;
      }
      const page = currentPage();
      if (!page) return;
      if (mod && letter === "a") {
        e.preventDefault();
        setSelection(page.children.map((c) => c.id));
        return;
      }
      const picked = tops(page, selection());
      if (picked.length === 0) return;
      if (mod && letter === "d") {
        e.preventDefault();
        duplicate(page, picked);
      } else if (mod && letter === "g") {
        e.preventDefault();
        if (!e.shiftKey) group(page, selection());
        else {
          const held = ungroup(page, selection());
          if (held.length > 0) setSelection(held);
        }
      } else if (!mod && e.shiftKey && letter === "a") {
        e.preventDefault();
        wrap(page, selection());
      } else if (mod && ["[", "]", "{", "}"].includes(e.key) && picked.length === 1) {
        e.preventDefault();
        const forward = e.key === "]" || e.key === "}";
        restack(page, picked[0].id, e.shiftKey ? (forward ? "front" : "back") : forward ? "forward" : "backward");
      } else if (e.key === "Delete" || e.key === "Backspace") {
        remove(page, picked);
      } else if (e.key === "Escape") {
        setSelection([]);
      } else if (e.key.startsWith("Arrow")) {
        const step = e.altKey ? 1 / UNIT : e.shiftKey ? STEP : GRID;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        const edits = picked.flatMap((el) => shiftBy(page, el, dx, dy));
        if (edits.length === 0) return;
        e.preventDefault();
        sendEdits(edits);
      }
    };
    // copy and cut take the selection, paste puts ours down, unless a field or some selected
    // text has the clipboard
    const clip = (e: ClipboardEvent) => {
      const page = currentPage();
      if (!p.shown || !page || (e.target as HTMLElement).closest?.("input, textarea, select")) return;
      if (e.type === "paste") return paste(e, page, selection().at(-1) ?? null);
      const picked = tops(page, selection());
      if (picked.length === 0 || !window.getSelection()?.isCollapsed) return;
      copy(e, page, picked);
      if (e.type === "cut") remove(page, picked);
    };
    window.addEventListener("keydown", key);
    for (const kind of ["copy", "cut", "paste"] as const) document.addEventListener(kind, clip);
    onCleanup(() => {
      window.removeEventListener("keydown", key);
      for (const kind of ["copy", "cut", "paste"] as const) document.removeEventListener(kind, clip);
    });
  });

  return (
    <div class="screen" hidden={!p.shown}>
      <Sidebar side="left">
        <Outline page={currentPage()} selected={selection()} onPick={pickShown} onEdit={edit} />
      </Sidebar>
      <Edge side="left" />
      <section class="detail" onClick={tapped}>
        <Show when={currentPage()} fallback={<div class="later">No page yet.</div>}>
          {(page) => <Artboard page={page()} selected={selection()} onPick={pick} onEdit={edit} keys={keys()} onKeys={setKeys} />}
        </Show>
      </section>
      <Edge side="right" />
      <Sidebar side="right">
        <ElementInspector page={currentPage()} selected={selection()} typing={typing()} />
      </Sidebar>
    </div>
  );
}
