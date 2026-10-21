// Records on the Data screen: the table of each value's history and a record's inspector.

import { batch, For, Show } from "solid-js";
import { send } from "../../net/connection";
import type { Record } from "../../protocol/Record";
import type { Sample } from "../../protocol/Sample";
import type { Value } from "../../protocol/Value";
import { complete } from "../../state/complete";
import { freeLocal } from "../../state/names";
import { live, putLocal, state } from "../../state/store";
import { DraftInput } from "../../ui/DraftInput";
import { Grid } from "../../ui/Grid";
import { ChartSpline, Copy, Plus, Trash } from "../../ui/icons";
import { copyText, openMenu } from "../../ui/Menu";
import { Preview } from "../../ui/Preview";
import type { Picking } from "./DataScreen";
import { UsedBy } from "./UsedBy";

function setRecord(name: string, record: Record | null) {
  if (send({ type: "set_record", name, record })) putLocal("records", name, record);
}

/** A record's samples now, oldest first. */
function samples(name: string): Sample[] {
  return (live(name).value as unknown as Sample[] | null) ?? [];
}

/** The latest values, as a list the preview draws as bars when they are numbers. */
const recent = (name: string) => samples(name).slice(-24).map((s) => s.v) as Value[];

/** Seconds or minutes, as a person says them. */
const span = (s: number) => (s >= 120 && s % 60 === 0 ? `${s / 60} min` : `${s} s`);

export function RecordsTable(p: Picking) {
  const add = () => {
    const name = freeLocal("newRecord");
    setRecord(name, { name, source: state.imports[0]?.alias ?? "0", every_ms: 100, keep_s: 60 });
    p.onSelect({ kind: "record", name });
  };
  return (
    <>
      <div class="detail-head">
        <span class="hero">Records</span>
        <span class="tag">{state.records.length}</span>
        <button class="button" onClick={add}>
          <Plus size={12} />
          Add a record
        </button>
      </div>
      <div class="hint">A value's history, sampled on the system whether or not a screen watches. Pages read it as a list of t and v, to plot.</div>
      <div class="detail-body">
        <Show when={state.records.length > 0} fallback={<div class="placeholder">No records yet.</div>}>
          <Grid cols={["Name", "Records", "Every", "Keeps", "Latest"]}>
            <For each={state.records}>
              {(r) => {
                const picked = () => p.selection?.kind === "record" && p.selection.name === r.name;
                return (
                  <tr
                    class="row"
                    classList={{ selected: picked() }}
                    onClick={() => p.onSelect({ kind: "record", name: r.name })}
                    onContextMenu={(e) => {
                      p.onSelect({ kind: "record", name: r.name });
                      openMenu(e, [{ label: "Copy the name", icon: <Copy size={13} />, run: () => copyText(r.name) }, "-", { label: "Delete", icon: <Trash size={13} />, run: () => setRecord(r.name, null) }]);
                    }}
                  >
                    <td class="name">
                      <span>
                        <span class="kind kind-local">
                          <ChartSpline size={14} />
                        </span>
                        <span class="mono">{r.name}</span>
                      </span>
                    </td>
                    <td class="mono">{r.source}</td>
                    <td>{r.every_ms} ms</td>
                    <td>{span(r.keep_s)}</td>
                    <td class="cell-value">
                      <Preview value={recent(r.name)} known={live(r.name).known} />
                    </td>
                  </tr>
                );
              }}
            </For>
          </Grid>
        </Show>
      </div>
    </>
  );
}

const whole = (t: string) => /^\d+$/.test(t.trim());

export function RecordView(p: { record: Record; onRenamed: (name: string) => void; onOpen: (page: string) => void }) {
  // a rename moves the selection in the same step, so this view never loses its record
  const change = (to: Partial<Record>) => {
    const [name, next] = [p.record.name, { ...p.record, ...to }];
    batch(() => {
      setRecord(name, next);
      if (next.name !== name) p.onRenamed(next.name);
    });
  };
  return (
    <>
      <div class="pane-head">
        <span class="head-title">
          <span class="kind kind-local">
            <ChartSpline size={14} />
          </span>
          <span class="mono">{p.record.name}</span>
        </span>
        <span class="tag">record</span>
      </div>
      <div class="pane-body pad">
        <div class="section">Record</div>
        <div class="field">
          <label>Name</label>
          <DraftInput value={p.record.name} accept={(t) => /^[a-z][A-Za-z0-9_]*$/.test(t.trim())} onCommit={(name) => change({ name: name.trim() })} />
        </div>
        <div class="field">
          <label>Records</label>
          <DraftInput value={p.record.source} placeholder="Speed" accept={(t) => t.trim() !== ""} onCommit={(source) => change({ source: source.trim() })} complete={(t, c) => complete(t, c, "expression")} />
        </div>
        <div class="field">
          <label>Every ms</label>
          <DraftInput value={String(p.record.every_ms)} accept={(t) => whole(t) && Number(t) >= 50} onCommit={(t) => change({ every_ms: Number(t) })} />
        </div>
        <div class="field">
          <label>Keeps s</label>
          <DraftInput value={String(p.record.keep_s)} accept={(t) => whole(t) && Number(t) >= 1 && Number(t) <= 86400} onCommit={(t) => change({ keep_s: Number(t) })} />
        </div>
        <div class="section">Now</div>
        <div class="field">
          <label>Samples</label>
          <span class="mono">{samples(p.record.name).length}</span>
        </div>
        <div class="field">
          <label>Latest</label>
          <Preview value={recent(p.record.name)} known={live(p.record.name).known} />
        </div>
        <UsedBy name={p.record.name} onOpen={p.onOpen} />
      </div>
    </>
  );
}
