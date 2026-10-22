// A handler as one card: what starts it and what the event brings it, then its code.

import { For, type JSX, Show } from "solid-js";
import type { Place } from "../../lang/api.js";
import type { Handler } from "../../protocol/Handler";
import { complete, signature, type Suggestion } from "../../state/complete";
import { type Brought, eventInfo, type Offered, pOf } from "../../state/events";
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
  /** Each new number puts the caret in the code. */
  focus?: number;
  /** The settings its event takes, as written, and the write of one, empty for its default. */
  attrs?: Handler["attrs"];
  onAttr?: (name: string, text: string) => void;
  /** The trigger's settings, between the head and the code. */
  children?: JSX.Element;
}) {
  const reads = () => (p.brings ? [...(p.also ?? []), pOf(p.brings)] : p.also);
  const settings = () => (p.onAttr ? (eventInfo(p.name)?.settings ?? []) : []);
  return (
    <div class="event">
      <div class="event-head">
        <span class="event-icon">{p.icon ?? <Zap size={13} />}</span>
        <span class="event-name">{p.name}</span>
        <span class="event-meta mono">
          <Show when={p.brings}>
            {(b) => (
              <>
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
              </>
            )}
          </Show>
        </span>
        <Show when={p.onRemove}>
          <button class="icon-btn" title={p.removeTitle} onClick={() => p.onRemove?.()}>
            <X size={13} />
          </button>
        </Show>
      </div>
      <Show when={settings().length > 0}>
        <div class="event-when">
          <For each={settings()}>
            {(s) => (
              <div class="field">
                <label>{s.label}</label>
                <DraftInput value={p.attrs?.[s.name] ?? ""} placeholder={s.default} onCommit={(text) => p.onAttr?.(s.name, text.trim())} complete={(text, c) => complete(text, c, "expression", p.names, p.also)} />
              </div>
            )}
          </For>
        </div>
      </Show>
      {p.children}
      <DraftInput
        multiline
        code
        class="editor code"
        value={p.code}
        placeholder={p.placeholder}
        focus={p.focus}
        onCommit={p.onCode}
        complete={(t, c) => complete(t, c, p.place, p.names, reads())}
        hint={(t, c) => signature(t, c, p.place)}
      />
    </div>
  );
}
