// The Objects screen's right sidebar: what is picked of the open sheet, else the open object.

import { Match, Switch } from "solid-js";
import type { EntityInfo } from "../../protocol/EntityInfo";
import { key, named, object } from "../../state/names";
import { entity, state } from "../../state/store";
import { ComputedView } from "./Computed";
import { EntityView } from "./Entity";
import { FunctionView } from "./Functions";
import { ImportView } from "./Imports";
import { RuleView } from "./Logic";
import type { Picking } from "./ObjectsScreen";
import { ObjectView } from "./ObjectView";
import { RecordView } from "./Records";
import { TokenView } from "./Theme";
import { VariableView } from "./Variables";

export function Inspector(p: { picking: Picking; onAdd: (e: EntityInfo) => void; onRemove: (name: string) => void; adding: string }) {
  const o = () => (p.picking.open === null ? undefined : object(p.picking.open));
  const s = () => p.picking.picked;
  /** The member picked, when it is of the kind `of`. */
  const member = (of: "import" | "variable" | "computed" | "record" | "function") => {
    const x = o();
    const pick = s();
    if (!x || pick.kind !== "member" || named(key(x.name, pick.name))?.of !== of) return undefined;
    return pick.name;
  };
  return (
    <Switch fallback={<div class="placeholder">Pick a token of the theme.</div>}>
      {/* keyed, so another entity starts over */}
      <Match when={s().kind === "entity" && entity((s() as { name: string }).name)} keyed>
        {(e) => <EntityView entity={e} to={p.picking.open} adding={p.adding} onAdd={() => p.onAdd(e)} />}
      </Match>
      <Match when={p.picking.open === null && s().kind === "token" && state.tokens.find((t) => t.name === (s() as { name: string }).name)}>{(t) => <TokenView token={t()} picking={p.picking} />}</Match>
      <Match when={o()?.imports.find((i) => i.alias === member("import"))}>{(i) => <ImportView object={o()!} imp={i()} picking={p.picking} />}</Match>
      <Match when={o()?.variables.find((v) => v.name === member("variable"))}>{(v) => <VariableView object={o()!} variable={v()} picking={p.picking} />}</Match>
      <Match when={o()?.computed.find((c) => c.name === member("computed"))}>{(c) => <ComputedView object={o()!} computed={c()} picking={p.picking} />}</Match>
      <Match when={o()?.records.find((r) => r.name === member("record"))}>{(r) => <RecordView object={o()!} record={r()} picking={p.picking} />}</Match>
      <Match when={o()?.functions.find((f) => f.name === member("function"))}>{(f) => <FunctionView object={o()!} function={f()} picking={p.picking} />}</Match>
      <Match when={o() && s().kind === "rule" && o()!.logic.find((r) => r.id === (s() as { id: string }).id)}>{(r) => <RuleView object={o()!} rule={r()} picking={p.picking} />}</Match>
      <Match when={o()}>{(x) => <ObjectView object={x()} picking={p.picking} onRemove={p.onRemove} />}</Match>
    </Switch>
  );
}
