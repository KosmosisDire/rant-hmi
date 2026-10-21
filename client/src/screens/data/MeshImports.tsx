import { For, Show } from "solid-js";
import type { Import } from "../../protocol/Import";
import type { Intent } from "../../protocol/Intent";
import { capital, choosesIntent, intentWords } from "../../state/format";
import { live, state } from "../../state/store";
import { Copy, Trash } from "../../ui/icons";
import { KindIcon } from "../../ui/marks";
import { copyText, openMenu } from "../../ui/Menu";
import { Preview } from "../../ui/Preview";
import type { Picking } from "./DataScreen";
import { canWrite, changeImport, unimport } from "./Inspector";

/** An import's right click menu: what it may do, its alias to copy, and removing it. */
function importMenu(e: MouseEvent, i: Import) {
  const intents: Intent[] = choosesIntent(i.kind) ? ["read", "write"] : [];
  openMenu(e, [
    ...intents.map((intent) => ({ label: capital(intentWords(i.kind, intent)), disabled: i.intent === intent || (intent === "write" && !canWrite(i)), run: () => changeImport(i, { intent }) })),
    ...(intents.length > 0 ? ["-" as const] : []),
    { label: "Copy the alias", icon: <Copy size={13} />, run: () => copyText(i.alias) },
    "-",
    { label: "Remove", icon: <Trash size={13} />, run: () => unimport(i.alias) },
  ]);
}

/** Every mesh import with its live value. Pages and handlers see only these. */
export function MeshImports(p: Picking) {
  return (
    <>
      <div class="detail-head">
        <span class="hero">Mesh imports</span>
        <span class="tag">{state.imports.length}</span>
      </div>
      <div class="hint">Pages and handlers see only these. Pick an entity in the mesh to import it.</div>
      <div class="detail-body">
        <Show when={state.imports.length > 0} fallback={<div class="placeholder">Nothing imported yet.</div>}>
          <table class="grid">
            <thead>
              <tr>
                <th>Alias</th>
                <th>Entity</th>
                <th>Intent</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              <For each={state.imports}>
                {(i) => {
                  const v = () => live(i.alias);
                  const picked = () => p.selection?.kind === "import" && p.selection.alias === i.alias;
                  return (
                    <tr
                      class="row"
                      classList={{ selected: picked() }}
                      onClick={() => p.onSelect({ kind: "import", alias: i.alias })}
                      onContextMenu={(e) => {
                        p.onSelect({ kind: "import", alias: i.alias });
                        importMenu(e, i);
                      }}
                    >
                      <td class="name">
                        <span>
                          <KindIcon kind={i.kind} />
                          <span class="mono">{i.alias}</span>
                        </span>
                      </td>
                      <td class="mono">{i.entity}</td>
                      <td>
                        <span class="tag" classList={{ write: i.intent === "write" }}>
                          {intentWords(i.kind, i.intent)}
                        </span>
                      </td>
                      <td class="cell-value">
                        <Preview value={v().value} known={v().known} />
                      </td>
                    </tr>
                  );
                }}
              </For>
            </tbody>
          </table>
        </Show>
      </div>
    </>
  );
}
