// A handler as one card: what starts it and what the event brings it, then its code.

import { For, type JSX, Match, Show, Switch } from "solid-js";
import type { Place } from "../../lang/api.js";
import { complete, signature, type Suggestion } from "../../state/complete";
import { type Brought, type Offered, pOf, settingsOf } from "../../state/events";
import { DraftInput } from "../../ui/DraftInput";
import { Component, Keyboard, X, Zap } from "../../ui/icons";

/** An event's mark: a component's own, the keyboard's, or the pointer's and an entry's. */
export function EventIcon(p: { from?: Offered["from"]; size?: number }) {
  return (
    <Switch fallback={<Zap size={p.size ?? 13} />}>
      <Match when={p.from === "component"}>
        <Component size={p.size ?? 13} />
      </Match>
      <Match when={p.from === "keyboard"}>
        <Keyboard size={p.size ?? 13} />
      </Match>
    </Switch>
  );
}

export function EventCard(p: {
  name: string;
  /** What its filters take, beside its name. */
  filter?: string;
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
  /** Each setting its event takes, as written, and the write of one, empty for its default. */
  setting?: (name: string) => string | undefined;
  onAttr?: (name: string, text: string) => void;
  /** The trigger's settings, between the head and the code. */
  children?: JSX.Element;
}) {
  const reads = () => (p.brings ? [...(p.also ?? []), pOf(p.brings)] : p.also);
  const settings = () => (p.onAttr ? settingsOf(p.name) : []);
  return (
    <div class="event">
      <div class="event-head">
        <span class="event-icon">{p.icon ?? <Zap size={13} />}</span>
        <span class="event-name">{p.name}</span>
        <Show when={p.filter}>
          <span class="event-filter">{p.filter}</span>
        </Show>
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
                {/* a filter is taken as it is, Space too, an expression as code */}
                <Show
                  when={s.kind === "expression"}
                  fallback={<DraftInput value={p.setting?.(s.name) ?? ""} placeholder={s.default} onCommit={(text) => p.onAttr?.(s.name, text)} />}
                >
                  <DraftInput value={p.setting?.(s.name) ?? ""} placeholder={s.default} onCommit={(text) => p.onAttr?.(s.name, text.trim())} complete={(text, c) => complete(text, c, "expression", p.names, p.also)} />
                </Show>
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
