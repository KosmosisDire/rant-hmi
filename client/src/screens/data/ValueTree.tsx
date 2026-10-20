import { For, Match, Show, Switch } from "solid-js";
import type { FieldInfo } from "../../protocol/FieldInfo";
import type { Value } from "../../protocol/Value";
import { fields, INTEGERS, SCALARS, typeLabel } from "../../state/format";
import { DraftInput } from "../../ui/DraftInput";
import { Preview } from "../../ui/Preview";

type Commit = (path: string, value: Value) => void;

interface Props {
  fields: FieldInfo[];
  value: Value | null;
  known: boolean;
  /** Set when the import may be written: scalar fields become editors. */
  onSet?: Commit;
}

/** A value's fields with their live values, as the explorer's value tree shows them. */
export function ValueTree(p: Props) {
  return <Rows fields={p.fields} value={p.value} known={p.known} onSet={p.onSet} prefix="" depth={0} />;
}

function member(v: Value | null, name: string): Value | null {
  if (name === "") return v;
  return fields(v)?.[name] ?? null;
}

function Rows(p: Props & { prefix: string; depth: number }) {
  return (
    <For each={p.fields}>
      {(f) => {
        const path = f.name === "" ? p.prefix : p.prefix ? `${p.prefix}.${f.name}` : f.name;
        const v = () => member(p.value, f.name);
        const branch = f.kind === "struct";
        return (
          <>
            <div class="vrow" classList={{ branch }} style={{ "padding-left": `${p.depth * 14}px` }}>
              <span class="vname mono">{f.name === "" ? "value" : f.name}</span>
              <span class="tag">{typeLabel(f)}</span>
              <span class="vval">
                <Show when={!branch}>
                  <Cell field={f} value={v()} known={p.known} path={path} onSet={p.onSet} />
                </Show>
              </span>
            </div>
            <Show when={branch}>
              <Rows fields={f.members} value={v()} known={p.known} onSet={p.onSet} prefix={path} depth={p.depth + 1} />
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
