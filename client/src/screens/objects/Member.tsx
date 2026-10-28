// What every member's inspector shares: its mark and words, its name, who may read it, what
// names it, and its removal.

import { batch, type JSX, Show } from "solid-js";
import { send } from "../../net/connection";
import type { Object as Thing } from "../../protocol/Object";
import type { Shape } from "../../protocol/rules";
import { change } from "../../state/change";
import { key, type Named, named } from "../../state/names";
import { notify, setState, state } from "../../state/store";
import { usedBy } from "../../state/usage";
import { ChartSpline, CircleDot, Parentheses, Sigma, Trash } from "../../ui/icons";
import { KindIcon } from "../../ui/marks";
import { Choice } from "../../ui/Choice";
import { ItemPane, NameField } from "./Items";
import type { Picking } from "./ObjectsScreen";
import { UsedBy } from "./UsedBy";

/** A member's mark: a mesh member's kind, else the HMI's own blue. */
export function MemberIcon(p: { n: Named }) {
  const own = (icon: JSX.Element, title: string) => (
    <span class="kind kind-local" title={title}>
      {icon}
    </span>
  );
  switch (p.n.of) {
    case "import":
      return <KindIcon kind={p.n.kind!} />;
    case "computed":
      return own(<Sigma size={14} />, "computed");
    case "record":
      return own(<ChartSpline size={14} />, "record");
    case "function":
      return own(<Parentheses size={14} />, "function");
    default:
      return own(<CircleDot size={14} />, "state");
  }
}

/** What a member is, in a word or two. */
export const kindWord = (n: Named) => (n.of === "import" ? `mesh ${n.kind}` : n.of === "variable" ? "state" : n.of);

/** Removes a member, unless something names it. */
export function removeMember(object: string, name: string) {
  const k = key(object, name);
  const places = usedBy(k);
  if (places.length > 0) return notify(`${places.length === 1 ? "1 place names" : `${places.length} places name`} ${k}. Change those first.`, "fault");
  setState("refused", null);
  switch (named(k)?.of) {
    case "import":
      return send({ type: "unimport", object, alias: name });
    case "variable":
      return change({ type: "set_variable", object, name, variable: null });
    case "computed":
      return change({ type: "set_computed", object, name, computed: null });
    case "record":
      return change({ type: "set_record", object, name, record: null });
    case "function":
      return change({ type: "set_function", object, name, function: null });
  }
}

/** A member's inspector: its name, then `access`, then who may read it, then its own fields,
 *  then what names it and Remove. A rename moves the pick with it. */
export function MemberPane(p: {
  object: Thing;
  name: string;
  picking: Picking;
  shape: Shape;
  /** Renames it, or with no name changes nothing. */
  rename: (name: string) => void;
  /** Fields between its name and who may read it: what it is on the mesh. */
  access?: JSX.Element;
  write?: boolean;
  children?: JSX.Element;
}) {
  const k = () => key(p.object.name, p.name);
  // read again as it goes, so a removal never reads it stale
  const n = () => named(k());
  const local = () => p.object.local.includes(p.name);
  return (
    <ItemPane mark={<Show when={n()}>{(x) => <MemberIcon n={x()} />}</Show>} name={local() ? p.name : k()} tag={n() ? kindWord(n()!) : ""} write={p.write}>
      <NameField
        value={p.name}
        shape={p.shape}
        focus={p.picking.focus(`member:${k()}`)}
        onCommit={(name) => {
          // read before the rename, which takes this pane's member away
          const from = p.name;
          batch(() => {
            setState("refused", null);
            p.rename(name);
            p.picking.onRename(from, name);
          });
        }}
      />
      {p.access}
      <div class="field">
        <label title="Who can read it">Visibility</label>
        <Choice
          options={[
            [false, "Global", `Pages and other objects read it as ${k()}`],
            [true, "Local", `Only ${p.object.name}'s own code reads it`],
          ]}
          value={local()}
          onPick={(on) => {
            setState("refused", null);
            change({ type: "set_local", object: p.object.name, name: p.name, local: on });
          }}
        />
      </div>
      <Show when={state.refused?.alias === k()}>
        <div class="error-line">{state.refused?.text}</div>
      </Show>
      {p.children}
      <UsedBy name={k()} picking={p.picking} />
      <div class="pane-actions">
        <button class="button" onClick={() => removeMember(p.object.name, p.name)}>
          <Trash size={13} />
          Remove
        </button>
      </div>
    </ItemPane>
  );
}
