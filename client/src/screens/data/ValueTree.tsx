import { For, Match, Show, Switch } from "solid-js";
import { ITEM, type Path } from "../../lang/reads.js";
import type { FieldInfo } from "../../protocol/FieldInfo";
import type { Value } from "../../protocol/Value";
import { fields, INTEGERS, SCALARS, typeLabel } from "../../state/format";
import { touches } from "../../state/paths";
import { DraftInput } from "../../ui/DraftInput";
import { Preview } from "../../ui/Preview";

type Commit = (path: string, value: Value) => void;

interface Props {
  fields: FieldInfo[];
  value: Value | null;
  known: boolean;
  /** Set when the import may be written: scalar fields become editors. */
  onSet?: Commit;
  /** What of the value comes, each a path that reads it, or undefined for all. */
  comes?: Path[];
  /** The field picked, which shows what reads it. */
  picked: Path | null;
  onPick: (field: Path | null) => void;
  /** What reads the field at a path. */
  readers: (field: Path) => string[];
}

/** A value's fields with their live values, as the explorer's value tree shows them. A list of
 *  records shows its items' fields under it. A field that does not come says so. */
export function ValueTree(p: Props) {
  return <Rows {...p} steps={[]} depth={0} item={false} />;
}

function member(v: Value | null, name: string): Value | null {
  if (name === "") return v;
  return fields(v)?.[name] ?? null;
}

const same = (a: Path | null, b: Path) => !!a && a.length === b.length && touches(a, b);

/** Rows of `fields` under `steps`, the fields of a list's items when `item`. */
function Rows(p: Props & { steps: Path; depth: number; item: boolean }) {
  return (
    <For each={p.fields}>
      {(f) => {
        const steps = f.name === "" ? p.steps : [...p.steps, f.name];
        const v = () => member(p.value, f.name);
        const branch = f.kind === "struct";
        const items = f.kind === "array" && f.members.length > 0;
        const comes = () => !p.comes || p.comes.some((k) => touches(k, steps));
        const picked = () => same(p.picked, steps);
        const readers = () => p.readers(steps);
        return (
          <>
            <div
              class="vrow"
              classList={{ branch: branch || items, picked: picked() }}
              style={{ "padding-left": `${p.depth * 14}px` }}
              onClick={(e) => (e.target as HTMLElement).closest("input, select, button") || p.onPick(picked() ? null : steps)}
            >
              <span class="vname mono">{f.name === "" ? "value" : f.name}</span>
              <span class="tag">{typeLabel(f)}</span>
              <span class="vval">
                <Switch>
                  <Match when={!comes()}>
                    <span class="faint" title="Nothing shown or running reads it now, so it does not come. Pick it to see it.">
                      not read
                    </span>
                  </Match>
                  <Match when={!branch && !p.item}>
                    <Cell field={f} value={v()} known={p.known} path={steps.join(".")} onSet={p.onSet} />
                  </Match>
                </Switch>
              </span>
            </div>
            <Show when={picked()}>
              <div class="vhint" style={{ "padding-left": `${p.depth * 14}px` }}>
                {readers().length > 0 ? `Read by ${readers().join(", ")}.` : "Nothing reads it."}
              </div>
            </Show>
            <Show when={branch}>
              <Rows {...p} fields={f.members} value={v()} steps={steps} depth={p.depth + 1} />
            </Show>
            <Show when={items}>
              <Rows {...p} fields={f.members} value={null} steps={[...steps, ITEM]} depth={p.depth + 1} item />
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
