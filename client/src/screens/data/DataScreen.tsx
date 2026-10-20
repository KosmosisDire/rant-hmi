import { createSignal } from "solid-js";
import { Datapoints } from "./Datapoints";
import { Inspector } from "./Inspector";
import { MeshTree } from "./MeshTree";
import { ThemeTable } from "./Theme";
import { VariablesTable } from "./Variables";

/** What the Data screen has picked: an entity on the mesh, an import, a variable or a token. */
export type Selection =
  | { kind: "entity"; name: string }
  | { kind: "import"; alias: string }
  | { kind: "variable"; name: string }
  | { kind: "token"; name: string }
  | null;

export interface Picking {
  selection: Selection;
  onSelect: (s: Selection) => void;
}

export function DataScreen() {
  const [selection, setSelection] = createSignal<Selection>(null);
  const picking: Picking = {
    get selection() {
      return selection();
    },
    onSelect: setSelection,
  };
  return (
    <>
      <aside class="sidebar left">
        <MeshTree {...picking} />
      </aside>
      <section class="detail data-detail">
        <Datapoints {...picking} />
        <VariablesTable {...picking} />
        <ThemeTable {...picking} />
      </section>
      <aside class="sidebar right">
        <Inspector {...picking} />
      </aside>
    </>
  );
}
