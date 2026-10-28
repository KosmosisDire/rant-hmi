// An object's inspector: its name, mesh root and note, which members code outside reads and
// which stay its own, and where it is named.

import { batch, For, Show } from "solid-js";
import type { Object as Thing } from "../../protocol/Object";
import type { ObjectInfo } from "../../protocol/ObjectInfo";
import { ALIAS } from "../../protocol/rules";
import { change } from "../../state/change";
import { HMI, type Named, names } from "../../state/names";
import { setState, split } from "../../state/store";
import { DraftInput } from "../../ui/DraftInput";
import { Monitor, Trash } from "../../ui/icons";
import { ObjectIcon } from "../../ui/marks";
import { ItemPane, NameField } from "./Items";
import { MemberIcon } from "./Member";
import type { Picking } from "./ObjectsScreen";
import { UsedBy } from "./UsedBy";

export function ObjectView(p: { object: Thing; picking: Picking; onRemove: (name: string) => void }) {
  const info = (): ObjectInfo => ({ name: p.object.name, mesh: p.object.mesh, note: p.object.note });
  const put = (to: Partial<ObjectInfo>) => {
    setState("refused", null);
    change({ type: "set_object", name: p.object.name, object: { ...info(), ...to } });
  };
  const all = () => names("import", "variable", "computed", "record", "function").filter((n) => n.object === p.object.name);
  const hmi = () => p.object.name === HMI;
  const Row = (r: { n: Named; prefix: string }) => {
    const name = () => split(r.n.name)[1];
    const f = () => p.object.functions.find((x) => x.name === name());
    return (
      <button class="list-row" onClick={() => p.picking.onPick({ kind: "member", name: name() })}>
        <MemberIcon n={r.n} />
        <span class="list-label mono">
          {r.prefix}
          {name()}
          {f() ? `(${f()!.takes.join(", ")})` : r.n.kind === "function" || r.n.kind === "task" ? "(...)" : ""}
        </span>
      </button>
    );
  };
  return (
    <ItemPane
      mark={
        <Show when={hmi()} fallback={<ObjectIcon />}>
          <span class="kind kind-local">
            <Monitor size={14} />
          </span>
        </Show>
      }
      name={p.object.name}
      tag={hmi() ? "the HMI's own" : "object"}
    >
      <Show
        when={!hmi()}
        fallback={
          <div class="field">
            <label>Name</label>
            <span class="mono field-text" title="The HMI's own object keeps its name">
              {p.object.name}
            </span>
          </div>
        }
      >
        <NameField
          value={p.object.name}
          shape={ALIAS}
          focus={p.picking.focus(`object:${p.object.name}`)}
          onCommit={(name) =>
            batch(() => {
              put({ name });
              p.picking.onOpen(name);
            })
          }
        />
      </Show>
      <div class="field">
        <label>Mesh at</label>
        <DraftInput value={p.object.mesh} placeholder="none" onCommit={(t) => put({ mesh: t.trim().replace(/^\/+|\/+$/g, "") })} />
      </div>
      <div class="field">
        <label>Note</label>
        <DraftInput value={p.object.note ?? ""} onCommit={(t) => put({ note: t.trim() === "" ? undefined : t.trim() })} />
      </div>
      <div class="section" title="Pages and other objects read these">
        Global <span class="faint">{all().filter((n) => !n.local).length}</span>
      </div>
      <For each={all().filter((n) => !n.local)}>{(n) => <Row n={n} prefix={`${p.object.name}.`} />}</For>
      <div class="section" title={`Only ${p.object.name}'s own code reads these`}>
        Local <span class="faint">{all().filter((n) => n.local).length}</span>
      </div>
      <For each={all().filter((n) => n.local)}>{(n) => <Row n={n} prefix="" />}</For>
      <UsedBy name={p.object.name} picking={p.picking} label="Used on" outside={p.object.name} />
      <Show when={!hmi()}>
        <div class="pane-actions">
          <button class="button" onClick={() => p.onRemove(p.object.name)}>
            <Trash size={13} />
            Remove
          </button>
        </div>
      </Show>
    </ItemPane>
  );
}
