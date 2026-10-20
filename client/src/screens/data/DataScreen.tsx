import { createSignal } from "solid-js";
import { Datapoints } from "./Datapoints";
import { Inspector } from "./Inspector";
import { MeshTree } from "./MeshTree";

/** What the Data screen has picked: an entity on the mesh, or one of the imports. */
export type Selection = { kind: "entity"; name: string } | { kind: "import"; alias: string } | null;

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
      <section class="detail">
        <Datapoints {...picking} />
      </section>
      <aside class="sidebar right">
        <Inspector {...picking} />
      </aside>
    </>
  );
}
