// Records on the Data screen: the table of each value's history and a record's inspector.

import type { Record } from "../../protocol/Record";
import type { Sample } from "../../protocol/Sample";
import type { Value } from "../../protocol/Value";
import { LOCAL, EVERY_MS, KEEP_S } from "../../protocol/rules";
import { change } from "../../state/change";
import { complete } from "../../state/complete";
import { freeLocal } from "../../state/names";
import { live, state } from "../../state/store";
import { DraftInput } from "../../ui/DraftInput";
import { ChartSpline } from "../../ui/icons";
import { Preview } from "../../ui/Preview";
import type { Picking } from "./DataScreen";
import { changing, ItemPane, ItemTable, type Kind, NameField } from "./Items";
import { UsedBy } from "./UsedBy";

/** The records, as the Data screen finds and changes them. */
export const RECORDS: Kind<Record> = {
  holds: "record",
  items: () => state.records,
  name: (r) => r.name,
  put: (name, record) => {
    change({ type: "set_record", name, record });
  },
};

/** A record's samples now, oldest first. */
function samples(name: string): Sample[] {
  return (live(name).value as unknown as Sample[] | null) ?? [];
}

/** The latest values, as a list the preview draws as bars when they are numbers. */
const recent = (name: string) => samples(name).slice(-24).map((s) => s.v) as Value[];

/** Seconds or minutes, as a person says them. */
const span = (s: number) => (s >= 120 && s % 60 === 0 ? `${s / 60} min` : `${s} s`);

const Mark = () => (
  <span class="kind kind-local">
    <ChartSpline size={14} />
  </span>
);

export function RecordsTable(p: Picking) {
  return (
    <ItemTable
      kind={RECORDS}
      picking={p}
      title="Records"
      hint="A value's history, sampled on the system whether or not a screen watches. Pages read it as a list of t and v, to plot."
      empty="No records yet."
      add={["Add a record", (): Record => ({ name: freeLocal("newRecord"), source: state.imports[0]?.alias ?? "0", every_ms: 100, keep_s: 60 })]}
      cols={["Name", "Records", "Every", "Keeps", "Latest"]}
      mark={Mark}
      cells={(r) => (
        <>
          <td class="mono">{r.source}</td>
          <td>{r.every_ms} ms</td>
          <td>{span(r.keep_s)}</td>
          <td class="cell-value">
            <Preview value={recent(r.name)} known={live(r.name).known} />
          </td>
        </>
      )}
    />
  );
}

const whole = (t: string) => /^\d+$/.test(t.trim());
const within = ([low, high]: readonly [number, number], n: number) => n >= low && n <= high;

export function RecordView(p: { record: Record; picking: Picking }) {
  const change = changing(RECORDS, () => p.record, p.picking);
  return (
    <ItemPane mark={<Mark />} name={p.record.name} tag="record">
      <div class="section">Record</div>
      <NameField value={p.record.name} shape={LOCAL} onCommit={(name) => change({ name })} />
      <div class="field">
        <label>Records</label>
        <DraftInput value={p.record.source} placeholder="Speed" accept={(t) => t.trim() !== ""} onCommit={(source) => change({ source: source.trim() })} complete={(t, c) => complete(t, c, "system")} />
      </div>
      <div class="field">
        <label>Every ms</label>
        <DraftInput value={String(p.record.every_ms)} accept={(t) => whole(t) && within(EVERY_MS, Number(t))} onCommit={(t) => change({ every_ms: Number(t) })} />
      </div>
      <div class="field">
        <label>Keeps s</label>
        <DraftInput value={String(p.record.keep_s)} accept={(t) => whole(t) && within(KEEP_S, Number(t))} onCommit={(t) => change({ keep_s: Number(t) })} />
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
      <UsedBy name={p.record.name} onOpen={p.picking.onOpen} />
    </ItemPane>
  );
}
