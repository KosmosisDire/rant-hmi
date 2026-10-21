import { createEffect, createSignal, For, type JSX, on, onCleanup, onMount } from "solid-js";
import { Dynamic } from "solid-js/web";
import { phone } from "../../ui/phone";
import { follow } from "../../ui/press";
import { Edge, reveal, Sidebar } from "../../ui/Sidebars";
import { ComputedTable } from "./Computed";
import { MeshImports } from "./MeshImports";
import { Inspector } from "./Inspector";
import { MeshTree } from "./MeshTree";
import { RecordsTable } from "./Records";
import { ThemeTable } from "./Theme";
import { VariablesTable } from "./Variables";

/** The kinds of item the Data screen's tables hold. */
export type Held = "import" | "variable" | "computed" | "record" | "token";

/** What the Data screen has picked: an entity on the mesh by its path, or an item of a table
 *  by its name, an import's alias. */
export type Selection = { kind: "entity" | Held; name: string } | null;

export interface Picking {
  selection: Selection;
  onSelect: (s: Selection) => void;
  /** Opens a page in the Design tab. */
  onOpen: (page: string) => void;
}

/** The detail's tables, each with the kind of row it holds. A phone shows one at a time. */
const CARDS: { name: string; Table: (p: Picking) => JSX.Element; holds: Held }[] = [
  { name: "Imports", Table: MeshImports, holds: "import" },
  { name: "Variables", Table: VariablesTable, holds: "variable" },
  { name: "Computed", Table: ComputedTable, holds: "computed" },
  { name: "Records", Table: RecordsTable, holds: "record" },
  { name: "Theme", Table: ThemeTable, holds: "token" },
];

/** How far a finger moves sideways to page to the next table. */
const SWIPE = 56;

export function DataScreen(p: { onOpen: (page: string) => void }) {
  const [selection, setSelection] = createSignal<Selection>(null);
  // on a phone a pick shows in the sheet, from the drawer or a table alike
  const picking: Picking = {
    get selection() {
      return selection();
    },
    onSelect: (s) => {
      setSelection(s);
      if (s) reveal();
    },
    onOpen: (page) => p.onOpen(page),
  };

  let detail!: HTMLElement;
  // a picked row is kept in sight, on a phone above the sheet as that rises and measures
  const keep = () => detail.querySelector("tr.row.selected")?.scrollIntoView({ block: "nearest" });
  createEffect(on(selection, () => requestAnimationFrame(keep), { defer: true }));
  onMount(() => {
    const watch = new ResizeObserver(keep);
    watch.observe(detail);
    onCleanup(() => watch.disconnect());
  });

  const [card, setCard] = createSignal(0);
  const [shift, setShift] = createSignal(0);
  const [enter, setEnter] = createSignal("");
  const show = (to: number) => {
    if (to < 0 || to >= CARDS.length || to === card()) return;
    setEnter(to > card() ? "next" : "back");
    setCard(to);
  };
  // a row picked from the drawer, as an imported entity, shows in its table
  createEffect(on(selection, (s) => s && show(CARDS.findIndex((c) => c.holds === s.kind))));
  // a finger's sideways move pages, and it follows the finger, slowed past either end
  let sideways = false;
  const swipe = (e: PointerEvent) => {
    if (e.pointerType !== "touch" || !phone()) return;
    const [x0, y0] = [e.clientX, e.clientY];
    follow(e, {
      move: (m) => {
        const dx = m.clientX - x0;
        sideways ||= Math.abs(dx) > Math.abs(m.clientY - y0);
        setShift((dx > 0 && card() === 0) || (dx < 0 && card() === CARDS.length - 1) ? dx / 3 : dx);
      },
      end: (u) => {
        const dx = u ? u.clientX - x0 : 0;
        sideways = false;
        setShift(0);
        if (dx < -SWIPE) show(card() + 1);
        else if (dx > SWIPE) show(card() - 1);
      },
    });
  };
  // the browser starts no scroll for a sideways move, else its fling eats the next tap
  onMount(() => detail.addEventListener("touchmove", (t) => sideways && t.cancelable && t.preventDefault(), { passive: false }));

  return (
    <>
      <Sidebar side="left">
        <MeshTree {...picking} />
      </Sidebar>
      <Edge side="left" />
      <section ref={detail} class="detail data-detail" data-enter={enter()} onPointerDown={swipe}>
        <div class="choice data-cards">
          <For each={CARDS}>
            {(c, i) => (
              <button classList={{ on: card() === i() }} onClick={() => show(i())}>
                {c.name}
              </button>
            )}
          </For>
        </div>
        <For each={CARDS}>
          {(c, i) => (
            <div
              class="data-card"
              classList={{ on: card() === i(), shifted: shift() !== 0 }}
              style={{ transform: card() === i() && shift() ? `translateX(${shift()}px)` : undefined }}
              onAnimationEnd={() => setEnter("")}
            >
              <Dynamic component={c.Table} {...picking} />
            </div>
          )}
        </For>
      </section>
      <Edge side="right" />
      <Sidebar side="right">
        <Inspector {...picking} />
      </Sidebar>
    </>
  );
}
