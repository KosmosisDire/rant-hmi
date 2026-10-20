import { createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { send } from "../../net/connection";
import { state } from "../../state/store";
import { currentPage, openPage } from "../../state/view";
import { Artboard, GRID } from "./Artboard";
import { ElementInspector } from "./ElementInspector";
import { Outline } from "./Outline";
import { boxOf, find, literal, setProps } from "./tree";

export function DesignScreen(p: { shown: boolean }) {
  const [selected, setSelected] = createSignal<string | null>(null);

  // what this screen just made: a new page opens, a new element is selected
  createEffect(
    on(
      () => state.made?.n,
      () => {
        const m = state.made;
        if (!m) return;
        if (m.id === m.page) {
          openPage(m.page);
          setSelected(null);
        } else if (m.page === currentPage()?.id) {
          setSelected(m.id);
        }
      },
      { defer: true },
    ),
  );

  // a selection whose element went away, or that belongs to another page, drops
  createEffect(() => {
    const id = selected();
    const page = currentPage();
    if (id && (!page || !find(page.children, id))) setSelected(null);
  });

  // Ctrl Z undoes this screen's last edit, Ctrl Shift Z or Ctrl Y redoes it. Delete removes,
  // Escape lets go, the arrows nudge by the grid (Shift by four). A field keeps its own keys.
  onMount(() => {
    const key = (e: KeyboardEvent) => {
      if (!p.shown || (e.target as HTMLElement).closest("input, textarea, select")) return;
      const mod = e.ctrlKey || e.metaKey;
      const letter = e.key.toLowerCase();
      if (mod && (letter === "z" || letter === "y")) {
        e.preventDefault();
        send({ type: letter === "z" && !e.shiftKey ? "undo" : "redo" });
        return;
      }
      const page = currentPage();
      const id = selected();
      if (!page || !id) return;
      const e2 = find(page.children, id);
      if (!e2) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        send({ type: "edit", edit: { kind: "remove_element", page: page.id, id } });
      } else if (e.key === "Escape") {
        setSelected(null);
      } else if (e.key.startsWith("Arrow") && literal(e2, ["x", "y"])) {
        e.preventDefault();
        const step = GRID * (e.shiftKey ? 4 : 1);
        const b = boxOf(e2);
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        setProps(page.id, id, { x: String(b.x + dx), y: String(b.y + dy) });
      }
    };
    window.addEventListener("keydown", key);
    onCleanup(() => window.removeEventListener("keydown", key));
  });

  return (
    <div class="screen" hidden={!p.shown}>
      <aside class="sidebar left">
        <Outline page={currentPage()} selected={selected()} onSelect={setSelected} />
      </aside>
      <section class="detail">
        <Show when={currentPage()} fallback={<div class="later">No page yet.</div>}>
          {(page) => <Artboard page={page()} selected={selected()} onSelect={setSelected} />}
        </Show>
      </section>
      <aside class="sidebar right">
        <ElementInspector page={currentPage()} selected={selected()} />
      </aside>
    </div>
  );
}
