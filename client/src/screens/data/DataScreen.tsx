import { createSignal } from "solid-js";
import { MeshImports } from "./MeshImports";
import { Inspector } from "./Inspector";
import { MeshTree } from "./MeshTree";
import { RecordsTable } from "./Records";
import { ThemeTable } from "./Theme";
import { VariablesTable } from "./Variables";
import { Edge } from "../../ui/Edge";

/** What the Data screen has picked: an entity on the mesh, an import, a variable, a record or
 *  a token. */
export type Selection =
  | { kind: "entity"; name: string }
  | { kind: "import"; alias: string }
  | { kind: "variable"; name: string }
  | { kind: "record"; name: string }
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
      <Edge side="left" />
      <section class="detail data-detail">
        <MeshImports {...picking} />
        <VariablesTable {...picking} />
        <RecordsTable {...picking} />
        <ThemeTable {...picking} />
      </section>
      <Edge side="right" />
      <aside class="sidebar right">
        <Inspector {...picking} />
      </aside>
    </>
  );
}
