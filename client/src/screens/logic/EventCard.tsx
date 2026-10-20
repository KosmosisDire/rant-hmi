// A handler as one card: what starts it and, in a few words, what it does, what the event
// brings, then its code.

import { For, type JSX, Show } from "solid-js";
import { complete, type Place, type Suggestion } from "../../state/complete";
import { type Brought, type Offered, pOf } from "../../state/events";
import { summary, uses } from "../../state/uses";
import { DraftInput } from "../../ui/DraftInput";
import { Component, X, Zap } from "../../ui/icons";

/** An event's mark: a component's own, or the pointer's and an entry's. */
export function EventIcon(p: { from?: Offered["from"]; size?: number }) {
  return (
    <Show when={p.from === "component"} fallback={<Zap size={p.size ?? 13} />}>
      <Component size={p.size ?? 13} />
    </Show>
  );
}

export function EventCard(p: {
  name: string;
  icon?: JSX.Element;
  code: string;
  onCode: (code: string) => void;
  onRemove?: () => void;
  removeTitle?: string;
  place: Place;
  /** What completion offers in place of the mesh imports, as a component offers its own. */
  names?: Suggestion[];
  /** Names it reads besides, as a repeat's `index` and `item`. */
  also?: Suggestion[];
  placeholder?: string;
  /** What the event hands the code as `p`. */
  brings?: Brought;
  /** A hold's time, an expression in ms, and its write. */
  after?: string;
  onAfter?: (text: string) => void;
  /** The trigger's settings, between the head and the code. */
  children?: JSX.Element;
}) {
  const meta = () => summary(uses(p.code, p.names));
  const reads = () => (p.brings ? [...(p.also ?? []), pOf(p.brings)] : p.also);
  return (
    <div class="event">
      <div class="event-head">
        <span class="event-icon">{p.icon ?? <Zap size={13} />}</span>
        <span class="event-name">{p.name}</span>
        <span class="event-meta" title={meta()}>
          {meta()}
        </span>
        <Show when={p.onRemove}>
          <button class="icon-btn" title={p.removeTitle} onClick={() => p.onRemove?.()}>
            <X size={13} />
          </button>
        </Show>
      </div>
      <Show when={p.onAfter}>
        <div class="event-when">
          <div class="field">
            <label>After ms</label>
            <DraftInput value={p.after ?? ""} placeholder="500" onCommit={(t) => p.onAfter?.(t.trim())} complete={(t, c) => complete(t, c, "expression", p.names, p.also)} />
          </div>
        </div>
      </Show>
      {p.children}
      <Show when={p.brings}>
        {(b) => (
          <div class="event-brings mono">
            <span class="event-p">p</span> ={" "}
            <Show when={b().value === undefined} fallback={<span>{b().value}</span>}>
              {"{ "}
              <For each={b().fields}>
                {(f, n) => (
                  <>
                    <span class="event-field" title={f.type}>
                      {f.label}
                    </span>
                    {n() < b().fields.length - 1 ? ", " : ""}
                  </>
                )}
              </For>
              {" }"}
            </Show>
          </div>
        )}
      </Show>
      <DraftInput
        multiline
        code
        class="editor code"
        value={p.code}
        placeholder={p.placeholder}
        onCommit={p.onCode}
        complete={(t, c) => complete(t, c, p.place, p.names, reads())}
      />
    </div>
  );
}
