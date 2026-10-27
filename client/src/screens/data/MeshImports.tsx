import { Show } from "solid-js";
import type { Import } from "../../protocol/Import";
import type { Intent } from "../../protocol/Intent";
import { capital, choosesIntent, intentWords } from "../../state/format";
import { preview, unread } from "../../state/preview";
import { KindIcon } from "../../ui/marks";
import { Preview } from "../../ui/Preview";
import type { Picking } from "./DataScreen";
import { canWrite, IMPORTS } from "./Inspector";
import { ItemTable } from "./Items";

/** Every mesh import with its live value. Pages and handlers see only these. */
export function MeshImports(p: Picking) {
  // what an import may do, where it chooses
  const intents = (i: Import) =>
    (choosesIntent(i.kind) ? (["read", "write"] as Intent[]) : []).map((intent) => ({
      label: capital(intentWords(i.kind, intent)),
      disabled: i.intent === intent || (intent === "write" && !canWrite(i)),
      run: () => IMPORTS.put(i.alias, { ...i, intent }),
    }));
  return (
    <ItemTable
      kind={IMPORTS}
      picking={p}
      title="Mesh imports"
      hint="Pages and handlers see only these. Pick an entity in the mesh to import it."
      empty="Nothing imported yet."
      cols={["Alias", "Entity", "Intent", "Value"]}
      mark={(i) => <KindIcon kind={i.kind} />}
      cells={(i) => (
        <>
          <td class="mono">{i.entity}</td>
          <td>
            <span class="tag" classList={{ write: i.intent === "write" }}>
              {intentWords(i.kind, i.intent)}
            </span>
          </td>
          <td class="cell-value">
            <Show when={!unread(i.alias)} fallback={<span class="faint">not read</span>}>
              <Preview value={preview(i.alias).value} known={preview(i.alias).known} />
            </Show>
          </td>
        </>
      )}
      menu={intents}
      words={["alias", "Remove"]}
    />
  );
}
