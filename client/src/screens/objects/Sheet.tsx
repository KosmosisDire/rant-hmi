// An object's sheet: its name and mesh root, then a section per kind of member, each row its
// definition, its value now, and marks for Local, whose value it is, a write and its readers.

import { createEffect, createSignal, For, type JSX, Show } from "solid-js";
import type { Object as Thing } from "../../protocol/Object";
import type { Rule } from "../../protocol/Rule";
import type { Value } from "../../protocol/Value";
import { send } from "../../net/connection";
import { change } from "../../state/change";
import { choosesIntent, intents } from "../../state/format";
import { freeMember, HMI, key, named } from "../../state/names";
import { preview, unread } from "../../state/preview";
import { usedBy } from "../../state/usage";
import { Copy, Globe, Lock, Monitor, Plus, RotateCcw, Trash } from "../../ui/icons";
import { ObjectIcon } from "../../ui/marks";
import { copyText, type MenuEntry, openMenu } from "../../ui/Menu";
import { Preview } from "../../ui/Preview";
import { canWrite } from "./Imports";
import { RuleIcon, triggerWords } from "./Logic";
import { MemberIcon, removeMember } from "./Member";
import type { Picking } from "./ObjectsScreen";
import { recent } from "./Records";

export function Sheet(p: { object: Thing; picking: Picking }) {
  const o = () => p.object;
  const k = (name: string) => key(o().name, name);
  const picked = (name: string) => p.picking.picked.kind === "member" && p.picking.picked.name === name;
  const local = (name: string) => o().local.includes(name);
  /** Adds a member with `put`, picked with its name ready to type. */
  const add = (name: string, put: () => void) => {
    put();
    p.picking.onPick({ kind: "member", name });
    p.picking.added(`member:${k(name)}`);
  };
  // a rule just added is picked once it comes back with its id
  const [wanted, setWanted] = createSignal("");
  createEffect(() => {
    const r = o().logic.find((x) => x.name === wanted());
    if (!r) return;
    setWanted("");
    p.picking.onPick({ kind: "rule", id: r.id });
    p.picking.added(`rule:${r.id}`);
  });
  const addRule = (from?: Rule) => {
    const base = from ? `${from.name} copy` : "New logic";
    let n = 1;
    const at = (i: number) => (i === 1 ? base : `${base} ${i}`);
    while (o().logic.some((r) => r.name === at(n))) n++;
    setWanted(at(n));
    change({ type: "set_rule", object: o().name, id: "", rule: { id: "", name: at(n), when: from?.when ?? { kind: "every", ms: 1000 }, code: from?.code ?? "" } });
  };
  // a new record starts from the first of its object's own values
  const source = () => o().imports.find((i) => choosesIntent(i.kind))?.alias ?? o().variables[0]?.name ?? "0";

  const memberMenu = (e: MouseEvent, name: string) => {
    p.picking.onPick({ kind: "member", name });
    const i = o().imports.find((x) => x.alias === name);
    const v = o().variables.find((x) => x.name === name);
    // what a mesh member may do, and state back to where it starts
    const first: MenuEntry[] = [
      ...(i && choosesIntent(i.kind)
        ? intents(i.kind).map(([intent, words]) => ({
            label: words,
            disabled: i.intent === intent || (intent === "write" && !canWrite(o(), i)),
            run: () => change({ type: "change_import", object: o().name, alias: name, import: { ...i, intent, rate: intent === "write" ? undefined : i.rate } }),
          }))
        : []),
      ...(v && !local(name) ? [{ label: "Reset to its start", icon: <RotateCcw size={13} />, run: () => send({ type: "set", alias: k(name), path: "", value: v.start }) }] : []),
    ];
    openMenu(e, [
      ...first,
      ...(first.length > 0 ? ["-" as const] : []),
      { label: "Copy the name", icon: <Copy size={13} />, run: () => copyText(local(name) ? name : k(name)) },
      "-",
      { label: "Remove", icon: <Trash size={13} />, run: () => removeMember(o().name, name) },
    ]);
  };

  /** A member's row: its mark, name and definition, its value, and its marks. */
  const Row = (r: { name: string; def: string; value?: JSX.Element; marks?: JSX.Element }) => (
    <div
      class="list-row member-row"
      data-member={r.name}
      role="button"
      tabIndex={0}
      classList={{ selected: picked(r.name) }}
      onClick={() => p.picking.onPick({ kind: "member", name: r.name })}
      onKeyDown={(e) => e.key === "Enter" && p.picking.onPick({ kind: "member", name: r.name })}
      onContextMenu={(e) => memberMenu(e, r.name)}
    >
      <Show when={named(k(r.name))}>{(n) => <MemberIcon n={n()} />}</Show>
      <span class="list-label mono">{r.name}</span>
      <span class="member-def mono" title={r.def}>
        {r.def}
      </span>
      <span class="member-value">{r.value}</span>
      <span class="member-marks">
        <Show when={local(r.name)}>
          <span title={`Only ${o().name}'s own code reads it`}>
            <Lock size={12} />
          </span>
        </Show>
        {r.marks}
        <span class="member-uses" title="Places that name it">
          {usedBy(k(r.name)).length || ""}
        </span>
      </span>
    </div>
  );

  const Now = (n: { name: string; value?: Value | null }) => (
    <Preview value={n.value === undefined ? preview(k(n.name)).value : n.value} known={preview(k(n.name)).known} />
  );

  return (
    <div class="object-sheet">
      <div class="object-top">
        <Show when={o().name === HMI} fallback={<ObjectIcon size={22} />}>
          <span class="kind kind-local">
            <Monitor size={22} />
          </span>
        </Show>
        <div class="object-title">
          <span class="hero mono">{o().name}</span>
          <Show when={o().mesh}>
            <span class="mono faint">{o().mesh}</span>
          </Show>
        </div>
      </div>
      <Section title="Mesh" count={o().imports.length} empty="Add from the mesh on the left.">
        <For each={o().imports}>
          {(i) => (
            <Row
              name={i.alias}
              def={i.entity}
              value={
                <Show when={choosesIntent(i.kind)}>
                  <Show when={!unread(k(i.alias))} fallback={<span class="faint">not read</span>}>
                    <Now name={i.alias} />
                  </Show>
                </Show>
              }
              marks={
                <Show when={i.intent === "write" && choosesIntent(i.kind)}>
                  <span class="tag write">{i.kind === "topic" ? "send" : "write"}</span>
                </Show>
              }
            />
          )}
        </For>
      </Section>
      <Section title="State" count={o().variables.length} add={["Add state", () => newMember("newState", (name) => change({ type: "set_variable", object: o().name, name, variable: { name, start: 0, per: "hmi" } }))]}>
        <For each={o().variables}>
          {(v) => (
            <Row
              name={v.name}
              def={JSON.stringify(v.start)}
              value={<Now name={v.name} />}
              marks={
                <span title={v.per === "screen" ? "Each screen" : "Every screen"}>
                  <Show when={v.per === "screen"} fallback={<Globe size={12} />}>
                    <Monitor size={12} />
                  </Show>
                </span>
              }
            />
          )}
        </For>
      </Section>
      <Section title="Computed" count={o().computed.length} add={["Add a computed value", () => newMember("newValue", (name) => change({ type: "set_computed", object: o().name, name, computed: { name, get: "0" } }))]}>
        <For each={o().computed}>{(c) => <Row name={c.name} def={`= ${c.get}${c.unit ? `, ${c.unit}` : ""}`} value={<Now name={c.name} />} />}</For>
      </Section>
      <Section title="Records" count={o().records.length} add={["Add a record", () => newMember("newRecord", (name) => change({ type: "set_record", object: o().name, name, record: { name, source: source(), every_ms: 100, keep_s: 60 } }))]}>
        <For each={o().records}>{(r) => <Row name={r.name} def={`${r.source}, ${r.keep_s} s`} value={<Now name={r.name} value={recent(k(r.name))} />} />}</For>
      </Section>
      <Section title="Functions" count={o().functions.length} add={["Add a function", () => newMember("newFunction", (name) => change({ type: "set_function", object: o().name, name, function: { name, takes: [], code: "" } }))]}>
        <For each={o().functions}>{(f) => <Row name={f.name} def={`(${f.takes.join(", ")})`} />}</For>
      </Section>
      <Section title="Logic" count={o().logic.length} add={["Add logic", () => addRule()]}>
        <For each={o().logic}>
          {(r) => (
            <div
              class="list-row member-row"
              data-rule={r.name}
              role="button"
              tabIndex={0}
              classList={{ selected: p.picking.picked.kind === "rule" && p.picking.picked.id === r.id }}
              onClick={() => p.picking.onPick({ kind: "rule", id: r.id })}
              onKeyDown={(e) => e.key === "Enter" && p.picking.onPick({ kind: "rule", id: r.id })}
              onContextMenu={(e) => {
                p.picking.onPick({ kind: "rule", id: r.id });
                openMenu(e, [
                  { label: "Duplicate", icon: <Plus size={13} />, run: () => addRule(r) },
                  "-",
                  { label: "Remove", icon: <Trash size={13} />, run: () => change({ type: "set_rule", object: o().name, id: r.id, rule: null }) },
                ]);
              }}
            >
              <span class="kind kind-local">
                <RuleIcon kind={r.when.kind} />
              </span>
              <span class="list-label">{r.name}</span>
              <span class="member-def mono" title={triggerWords(r.when)}>
                {triggerWords(r.when)}
              </span>
            </div>
          )}
        </For>
      </Section>
    </div>
  );

  /** Adds a member under the first free name from `base`, made by `put`. */
  function newMember(base: string, put: (name: string) => void) {
    const name = freeMember(o().name, base);
    add(name, () => put(name));
  }
}

/** A section of the sheet: its title and add button over its rows, `count` of them. */
function Section(p: { title: string; count: number; add?: [string, () => void]; empty?: string; children: JSX.Element }) {
  return (
    <div class="members">
      <div class="members-head">
        <span class="section">{p.title}</span>
        <Show when={p.add}>
          {(a) => (
            <button class="icon-btn" title={a()[0]} onClick={() => a()[1]()}>
              <Plus size={14} />
            </button>
          )}
        </Show>
      </div>
      <Show when={p.count > 0} fallback={<Show when={p.empty}>{(e) => <div class="field-hint members-empty">{e()}</div>}</Show>}>
        <div class="members-rows">{p.children}</div>
      </Show>
    </div>
  );
}
