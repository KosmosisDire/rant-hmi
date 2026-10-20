import { createSignal } from "solid-js";
import { Datapoints } from "./Datapoints";
import { VariablesTable } from "./Variables";
import { Inspector } from "./Inspector";
import { MeshTree } from "./MeshTree";

/** What the Data screen has picked: an entity on the mesh, an import or a variable. */
export type Selection = { kind: "entity"; name: string } | { kind: "import"; alias: string } | { kind: "variable"; name: string } | null;

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
      </section>
      <aside class="sidebar right">
        <Inspector {...picking} />
      </aside>
    </>
  );
}
