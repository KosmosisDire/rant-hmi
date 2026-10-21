import { createSignal } from "solid-js";
import { Edge, Sidebar } from "../../ui/Sidebars";
import { ComputedTable } from "./Computed";
import { MeshImports } from "./MeshImports";
import { Inspector } from "./Inspector";
import { MeshTree } from "./MeshTree";
import { RecordsTable } from "./Records";
import { ThemeTable } from "./Theme";
import { VariablesTable } from "./Variables";

/** What the Data screen has picked: an entity on the mesh, an import, a variable, a record or
 *  a token. */
export type Selection =
  | { kind: "entity"; name: string }
  | { kind: "import"; alias: string }
  | { kind: "variable"; name: string }
  | { kind: "record"; name: string }
  | { kind: "computed"; name: string }
  | { kind: "token"; name: string }
  | null;

export interface Picking {
  selection: Selection;
  onSelect: (s: Selection) => void;
  /** Opens a page in the Design tab. */
  onOpen: (page: string) => void;
}

export function DataScreen(p: { onOpen: (page: string) => void }) {
  const [selection, setSelection] = createSignal<Selection>(null);
  const picking: Picking = {
    get selection() {
      return selection();
    },
    onSelect: setSelection,
    onOpen: (page) => p.onOpen(page),
  };
  return (
    <>
      <Sidebar side="left">
        <MeshTree {...picking} />
      </Sidebar>
      <Edge side="left" />
      <section class="detail data-detail">
        <MeshImports {...picking} />
        <VariablesTable {...picking} />
        <ComputedTable {...picking} />
        <RecordsTable {...picking} />
        <ThemeTable {...picking} />
      </section>
      <Edge side="right" />
      <Sidebar side="right">
        <Inspector {...picking} />
      </Sidebar>
    </>
  );
}
