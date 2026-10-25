import { createEffect, For, Match, Show, Switch } from "solid-js";
import type { FieldInfo } from "../../protocol/FieldInfo";
import type { Value } from "../../protocol/Value";
import { fields, INTEGERS, SCALARS, typeLabel } from "../../state/format";
import { comes, keeping } from "../../state/kept";
import { DraftInput } from "../../ui/DraftInput";
import { Preview } from "../../ui/Preview";

type Commit = (path: string, value: Value) => void;

interface Props {
  fields: FieldInfo[];
  value: Value | null;
  known: boolean;
  /** Set when the import may be written: scalar fields become editors. */
  onSet?: Commit;
  /** Set when the import reads: each field has a box for whether it comes. */
  keep?: Keeping;
}

/** The fields an import keeps, and what a box's change has it keep. */
interface Keeping {
  fields: string[] | null | undefined;
  onKeep: (fields: string[] | undefined) => void;
}

/** A value's fields with their live values, as the explorer's value tree shows them. */
export function ValueTree(p: Props) {
  return <Rows {...p} all={p.fields} prefix="" depth={0} />;
}

function member(v: Value | null, name: string): Value | null {
  if (name === "") return v;
  return fields(v)?.[name] ?? null;
}

/** Rows of `fields` under `prefix`, of the type `all`. `each` for the members of a list's
 *  records, which have no one value to show. */
function Rows(p: Props & { all: FieldInfo[]; prefix: string; depth: number; each?: boolean }) {
  return (
    <For each={p.fields}>
      {(f) => {
        const path = f.name === "" ? p.prefix : p.prefix ? `${p.prefix}.${f.name}` : f.name;
        const v = () => member(p.value, f.name);
        const branch = f.kind === "struct";
        // a list of records opens only to choose its fields
        const opens = branch || (!!p.keep && f.kind === "array" && f.members.length > 0);
        const name = f.name === "" ? "value" : f.name;
        const keep = () => (f.name === "" ? undefined : p.keep);
        const brought = () => {
          const k = keep();
          return k ? comes(p.all, k.fields, path) : "all";
        };
        return (
          <>
            <div class="vrow" classList={{ branch }} style={{ "padding-left": `${p.depth * 14}px` }}>
              <Show when={keep()} fallback={<span class="vname mono">{name}</span>}>
                {(k) => (
                  <label class="vname mono kept" classList={{ left: brought() === "none" }} title="Whether it comes">
                    <input
                      type="checkbox"
                      checked={brought() !== "none"}
                      ref={(box) => createEffect(() => (box.indeterminate = brought() === "some"))}
                      onChange={(e) => k().onKeep(keeping(p.all, k().fields, path, e.currentTarget.checked))}
                    />
                    {name}
                  </label>
                )}
              </Show>
              <span class="tag">{typeLabel(f)}</span>
              <span class="vval">
                <Show when={!branch && !p.each && brought() !== "none"}>
                  <Cell field={f} value={v()} known={p.known} path={path} onSet={p.onSet} />
                </Show>
              </span>
            </div>
            <Show when={opens}>
              <Rows {...p} fields={f.members} value={v()} prefix={path} depth={p.depth + 1} each={p.each || !branch} />
            </Show>
          </>
        );
      }}
    </For>
  );
}

function Cell(p: { field: FieldInfo; value: Value | null; known: boolean; path: string; onSet?: Commit }) {
  const editable = () => !!p.onSet && p.known && SCALARS.has(p.field.kind);
  const set = (v: Value) => p.onSet?.(p.path, v);
  const parse = (text: string): Value | undefined => (p.field.kind === "string" ? text : parseNumber(text, INTEGERS.has(p.field.kind)));
  return (
    <Show
      when={editable()}
      fallback={<Preview value={p.value} known={p.known} />}
    >
      <Switch fallback={<DraftInput value={p.value === null ? "" : String(p.value)} accept={(t) => parse(t) !== undefined} onCommit={(t) => set(parse(t)!)} />}>
        <Match when={p.field.kind === "bool"}>
          <button class="switch" classList={{ on: p.value === true }} title="Flip it" onClick={() => set(p.value !== true)} />
        </Match>
        <Match when={p.field.kind === "enum"}>
          <select class="editor" value={String(p.value ?? "")} onChange={(e) => set(e.currentTarget.value)}>
            <For each={p.field.options}>{(o) => <option value={o}>{o}</option>}</For>
          </select>
        </Match>
      </Switch>
    </Show>
  );
}

function parseNumber(text: string, integer: boolean): number | undefined {
  const n = Number(text.trim());
  if (text.trim() === "" || !Number.isFinite(n) || (integer && !Number.isInteger(n))) return undefined;
  return n;
}
