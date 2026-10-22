// A handler as one card: what starts it and what the event brings it, then its code.

import { createEffect, createSignal, For, type JSX, Match, on, Show, Switch } from "solid-js";
import type { Place } from "../../lang/api.js";
import { type Key, keyOf } from "../../page/keys";
import type { SettingInfo } from "../../protocol/SettingInfo";
import { complete, signature, type Suggestion } from "../../state/complete";
import { type Brought, eventInfo, keyWords, type Offered, pOf, settingsOf } from "../../state/events";
import { type Pad, pads } from "../../state/input";
import { DraftInput } from "../../ui/DraftInput";
import { Component, Gamepad2, Keyboard, X, Zap } from "../../ui/icons";
import { closeMenu, type MenuEntry, menuOpen, openMenu } from "../../ui/Menu";

/** An event's mark: a component's own, the keyboard's, a gamepad's, or the pointer's and an
 *  entry's. */
export function EventIcon(p: { from?: Offered["from"]; size?: number }) {
  return (
    <Switch fallback={<Zap size={p.size ?? 13} />}>
      <Match when={p.from === "component"}>
        <Component size={p.size ?? 13} />
      </Match>
      <Match when={p.from === "keyboard"}>
        <Keyboard size={p.size ?? 13} />
      </Match>
      <Match when={p.from === "gamepad"}>
        <Gamepad2 size={p.size ?? 13} />
      </Match>
    </Switch>
  );
}

const MODIFIERS = new Set(["Shift", "Control", "Alt", "AltGraph", "Meta"]);

/** Each button down on `list`'s pads, by name and pad. */
const pressed = (list: readonly (Pad | null)[]) =>
  list.flatMap((g, pad) => (g ? Object.entries(g.buttons).flatMap(([button, down]) => (down ? [{ button, pad: String(pad) }] : [])) : []));

/** A filter's field, never typed in. One with options offers them as a menu, and a pad's takes
 *  the button pressed on a pad while its menu is open: its name, or its pad. A key filter fills
 *  by pressing the key: its field of what the screen's keydown brings, so it matches as the
 *  screen sends it. A modifier alone counts once let go with no other key, so Shift then A
 *  takes "A". */
function FilterField(p: { setting: SettingInfo; from?: Offered["from"]; value: string; onSet: (value: string) => void }) {
  let field!: HTMLInputElement;
  const keyed = () => p.from === "keyboard";
  const [waiting, setWaiting] = createSignal(false);
  const [offering, setOffering] = createSignal(false);
  let modifier: KeyboardEvent | null = null;
  const take = (e: KeyboardEvent) => {
    p.onSet(String(keyOf(e)[p.setting.name as keyof Key]));
    field.blur();
  };
  const offer = () => {
    if (p.setting.options.length === 0) return;
    const at = field.getBoundingClientRect();
    const rows: MenuEntry[] = p.setting.options.map(([value, words]) => ({ label: value, keys: words, run: () => p.onSet(value) }));
    if (p.from === "gamepad") rows.push("-", { label: p.setting.name === "button" ? "Or press it on a pad" : "Or press a button on it", disabled: true });
    openMenu({ x: at.left, y: at.bottom }, rows);
    setOffering(true);
  };
  // a button newly down on a pad while the menu is open picks, past what was down as it opened
  createEffect(
    on(
      () => (offering() && menuOpen() && p.from === "gamepad" ? pads.read() : undefined),
      (now, was) => {
        if (!now) return setOffering(false);
        const fresh = was && pressed(now).find((b) => !pressed(was).some((o) => o.button === b.button && o.pad === b.pad));
        if (!fresh) return;
        closeMenu();
        p.onSet(fresh[p.setting.name as keyof typeof fresh]);
      },
    ),
  );
  return (
    <span class="key-field">
      <input
        ref={field}
        class="editor"
        readOnly
        aria-haspopup={p.setting.options.length > 0 ? "menu" : undefined}
        value={waiting() ? "" : keyWords(p.value)}
        placeholder={waiting() ? "Press a key" : p.setting.default}
        onFocus={() => setWaiting(keyed())}
        onBlur={() => {
          setWaiting(false);
          modifier = null;
        }}
        onClick={offer}
        onKeyDown={(e) => {
          if (!keyed()) return;
          e.preventDefault();
          e.stopPropagation();
          if (e.repeat) return;
          if (MODIFIERS.has(e.key)) modifier = e;
          else take(e);
        }}
        onKeyUp={(e) => modifier?.key === e.key && take(modifier)}
      />
      <Show when={p.value && !waiting()}>
        <button class="icon-btn" title={`Take any ${p.setting.label.toLowerCase()}`} onClick={() => p.onSet("")}>
          <X size={12} />
        </button>
      </Show>
    </span>
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
                <Show when={s.kind === "expression"} fallback={<FilterField setting={s} from={eventInfo(p.name)?.from} value={p.setting?.(s.name) ?? ""} onSet={(v) => p.onAttr?.(s.name, v)} />}>
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
