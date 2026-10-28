// A record's inspector: what it samples, how often and for how long, and its samples now.

import type { Object as Thing } from "../../protocol/Object";
import type { Record } from "../../protocol/Record";
import { EVERY_MS, KEEP_S, LOCAL } from "../../protocol/rules";
import type { Sample } from "../../protocol/Sample";
import type { Value } from "../../protocol/Value";
import { change } from "../../state/change";
import { complete } from "../../state/complete";
import { key } from "../../state/names";
import { live } from "../../state/store";
import { DraftInput } from "../../ui/DraftInput";
import { paint } from "../../ui/highlight";
import { Preview } from "../../ui/Preview";
import { MemberPane } from "./Member";
import type { Picking } from "./ObjectsScreen";

/** A record's samples now, oldest first, by its key. */
function samples(k: string): Sample[] {
  return (live(k).value as unknown as Sample[] | null) ?? [];
}

/** The latest values, as a list the preview draws as bars when they are numbers. */
export const recent = (k: string) => samples(k).slice(-24).map((s) => s.v) as Value[];

const whole = (t: string) => /^\d+$/.test(t.trim());
const within = ([low, high]: readonly [number, number], n: number) => n >= low && n <= high;

export function RecordView(p: { object: Thing; record: Record; picking: Picking }) {
  const k = () => key(p.object.name, p.record.name);
  const put = (to: Partial<Record>) => change({ type: "set_record", object: p.object.name, name: p.record.name, record: { ...p.record, ...to } });
  return (
    <MemberPane object={p.object} name={p.record.name} picking={p.picking} shape={LOCAL} rename={(name) => put({ name })}>
      <div class="field">
        <label>Source</label>
        <DraftInput
          value={p.record.source}
          placeholder="Speed"
          accept={(t) => t.trim() !== ""}
          onCommit={(source) => put({ source: source.trim() })}
          complete={(t, c) => complete(t, c, "system", undefined, undefined, p.object.name)}
          paint={(src) => paint(src, p.object.name)}
        />
      </div>
      <div class="field">
        <label>Every ms</label>
        <DraftInput value={String(p.record.every_ms)} accept={(t) => whole(t) && within(EVERY_MS, Number(t))} onCommit={(t) => put({ every_ms: Number(t) })} />
      </div>
      <div class="field">
        <label>Keep s</label>
        <DraftInput value={String(p.record.keep_s)} accept={(t) => whole(t) && within(KEEP_S, Number(t))} onCommit={(t) => put({ keep_s: Number(t) })} />
      </div>
      <div class="section">Now</div>
      <div class="field">
        <label>Samples</label>
        <span class="mono">{samples(k()).length}</span>
      </div>
      <div class="field">
        <label>Latest</label>
        <Preview value={recent(k())} known={live(k()).known} />
      </div>
    </MemberPane>
  );
}
