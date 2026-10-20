import { For, Show } from "solid-js";
import { intentWords } from "../../state/format";
import { live, state } from "../../state/store";
import { KindIcon } from "../../ui/marks";
import { Preview } from "../../ui/Preview";
import type { Picking } from "./DataScreen";

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
                    <tr class="row" classList={{ selected: picked() }} onClick={() => p.onSelect({ kind: "import", alias: i.alias })}>
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
