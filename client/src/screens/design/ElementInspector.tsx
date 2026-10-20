import { createMemo, createSignal, For, Show } from "solid-js";
import { send } from "../../net/connection";
import { state } from "../../state/store";
import { OWN } from "../../page/PageView";
import type { Element } from "../../protocol/Element";
import type { Event } from "../../protocol/Event";
import type { Page } from "../../protocol/Page";
import type { Shows } from "../../protocol/Shows";
import { isConstant, resolve } from "../../state/bind";
import { complete } from "../../state/complete";
import { DraftInput } from "../../ui/DraftInput";
import { Plus, Square, Trash, Type, X } from "../../ui/icons";
import { find, setProps } from "./tree";

/** The CSS a field offers by name, with an example of what it takes. Anything else lives
 *  in the free CSS box. */
const LOOK: [string, string, string][] = [
  ["Fill", "background", "#2a2f35"],
  ["Border", "border", '"1px solid #3a4046"'],
  ["Radius", "border-radius", "0"],
  ["Opacity", "opacity", "1"],
];
const TEXT_LOOK: [string, string, string][] = [
  ["Colour", "color", "#e4e6e8"],
  ["Size", "font-size", "16"],
  ["Weight", "font-weight", "400"],
  ["Align", "text-align", '"left"'],
];
const NAMED = new Set([...LOOK, ...TEXT_LOOK].map(([, key]) => key));

/** The right sidebar: the selected element's properties, or the page's when none is. */
export function ElementInspector(p: { page: Page | undefined; selected: string | null }) {
  const element = createMemo(() => (p.page && p.selected ? find(p.page.children, p.selected) : undefined));
  return (
    <Show when={p.page}>
      {(page) => (
        <Show when={element()} fallback={<PageInspector page={page()} />}>
          {(e) => <Properties page={page().id} element={e()} />}
        </Show>
      )}
    </Show>
  );
}

const SHOWS: [Shows, string][] = [
  ["full", "Full"],
  ["over", "Over"],
];

/** A page side in pixels, as the backend allows. */
const side = (t: string) => /^\d+$/.test(t.trim()) && Number(t) >= 1 && Number(t) <= 16384;

function PageInspector(p: { page: Page }) {
  const resize = (width: number, height: number) => send({ type: "edit", edit: { kind: "resize_page", page: p.page.id, width, height } });
  return (
    <>
      <div class="pane-head">
        <span class="head-title">{p.page.name}</span>
        <span class="tag">page</span>
      </div>
      <div class="pane-body pad">
        <div class="section">Page</div>
        <div class="field">
          <label>Name</label>
          <DraftInput value={p.page.name} accept={(t) => t.trim() !== ""} onCommit={(name) => send({ type: "edit", edit: { kind: "rename_page", page: p.page.id, name } })} />
        </div>
        <div class="section">Size</div>
        <div class="placement">
          <div class="field">
            <label>w</label>
            <DraftInput value={String(p.page.width)} accept={side} onCommit={(t) => resize(Number(t), p.page.height)} />
          </div>
          <div class="field">
            <label>h</label>
            <DraftInput value={String(p.page.height)} accept={side} onCommit={(t) => resize(p.page.width, Number(t))} />
          </div>
        </div>
        <div class="field">
          <label>Shows</label>
          <div class="choice">
            <For each={SHOWS}>
              {([shows, label]) => (
                <button classList={{ on: p.page.shows === shows }} onClick={() => p.page.shows !== shows && send({ type: "edit", edit: { kind: "set_shows", page: p.page.id, shows } })}>
                  {label}
                </button>
              )}
            </For>
          </div>
        </div>
        <div class="field-hint">{p.page.shows === "over" ? "Opened over another page, as a dialog: the page beneath stays in sight." : "Covers the screen when opened."}</div>
        <div class="section">Operators</div>
        <Show
          when={(state.project?.start ?? state.pages[0]?.id) === p.page.id}
          fallback={
            <button class="button" onClick={() => send({ type: "set_start", page: p.page.id })}>
              Start operators here
            </button>
          }
        >
          <div class="field-hint">Operators' screens open on this page.</div>
        </Show>
        <div class="placeholder">
          Select an element to change it. Every value is an expression: text goes in quotes, like <code>"Running"</code>, and <code>Speed.toFixed(1)</code> shows a live
          value.
        </div>
      </div>
      <div class="pane-foot">
        <button
          class="button"
          disabled={state.pages.length < 2}
          title={state.pages.length < 2 ? "A project keeps at least one page" : undefined}
          onClick={() => send({ type: "edit", edit: { kind: "remove_page", page: p.page.id } })}
        >
          <Trash size={12} />
          Delete page
        </button>
      </div>
    </>
  );
}

function Properties(p: { page: string; element: Element }) {
  const text = () => p.element.tag === "span";
  const other = () =>
    Object.entries(p.element.props)
      .filter(([k]) => !OWN.has(k) && !NAMED.has(k))
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
  const setOther = (body: string) => {
    const next = new Map<string, string>();
    for (const line of body.split("\n")) {
      const at = line.indexOf(":");
      if (at > 0) next.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
    }
    const props: Record<string, string | null> = {};
    for (const [k] of Object.entries(p.element.props)) {
      if (!OWN.has(k) && !NAMED.has(k) && !next.has(k)) props[k] = null;
    }
    for (const [k, v] of next) props[k] = v;
    setProps(p.page, p.element.id, props);
  };
  return (
    <>
      <div class="pane-head">
        <span class="head-title">
          <Show when={text()} fallback={<Square size={14} />}>
            <Type size={14} />
          </Show>
          <span>{p.element.props.name ?? p.element.id}</span>
        </span>
        <span class="tag">{text() ? "text" : "frame"}</span>
      </div>
      <div class="pane-body pad">
        <div class="section">Element</div>
        <Field {...p} key="name" label="Name" plain />
        <div class="section">Placement</div>
        <div class="placement">
          <For each={["x", "y", "w", "h"]}>{(k) => <Field {...p} key={k} label={k} />}</For>
        </div>
        <Show when={text()}>
          <div class="section">Text</div>
          <Field {...p} key="text" label="Text" />
          <For each={TEXT_LOOK}>{([label, key, hint]) => <Field {...p} key={key} label={label} placeholder={hint} />}</For>
        </Show>
        <div class="section">Look</div>
        <For each={LOOK}>{([label, key, hint]) => <Field {...p} key={key} label={label} placeholder={hint} />}</For>
        <div class="section">More CSS</div>
        <DraftInput multiline class="editor css" value={other()} placeholder={'box-shadow: "0 2px 8px #0008"'} onCommit={setOther} />
        <Events page={p.page} element={p.element} />
      </div>
      <div class="pane-foot">
        <button class="button" onClick={() => send({ type: "edit", edit: { kind: "remove_element", page: p.page, id: p.element.id } })}>
          <Trash size={12} />
          Delete
        </button>
      </div>
    </>
  );
}

const EVENTS: [Event, string][] = [
  ["tap", "Tap"],
  ["press", "Press"],
  ["release", "Release"],
];

/** The element's handlers, each a box: the event on top, the code the backend runs below.
 *  Every change names one event, so two quick changes never undo each other. */
function Events(p: { page: string; element: Element }) {
  const [adding, setAdding] = createSignal(false);
  const write = (event: Event, code: string | null) => send({ type: "edit", edit: { kind: "set_handler", page: p.page, id: p.element.id, event, code } });
  const unused = () => EVENTS.filter(([e]) => !p.element.handlers.some((h) => h.event === e));
  return (
    <>
      <div class="section section-row">
        Events
        <Show when={unused().length > 0}>
          <button class="icon-btn" classList={{ on: adding() }} title="Add an event" onClick={() => setAdding(!adding())}>
            <Plus size={13} />
          </button>
        </Show>
      </div>
      <Show when={adding() && unused().length > 0}>
        <div class="event-menu">
          <For each={unused()}>
            {([e, label]) => (
              <button
                class="button"
                onClick={() => {
                  setAdding(false);
                  write(e, "");
                }}
              >
                {label}
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={p.element.handlers.length === 0 && !adding()}>
        <div class="field-hint">Add one to run code when this is tapped, pressed or let go.</div>
      </Show>
      {/* one box per event, so a box never turns into another event's under the pointer */}
      <For each={EVENTS}>
        {([event, label]) => (
          <Show when={p.element.handlers.find((h) => h.event === event)}>
            {(h) => (
              <div class="handler">
                <div class="handler-head">
                  <span class="handler-event">{label}</span>
                  <button class="icon-btn" title={`Remove the ${event} handler`} onClick={() => write(event, null)}>
                    <X size={13} />
                  </button>
                </div>
                <DraftInput
                  multiline
                  class="editor code"
                  value={h().code}
                  placeholder="Speed = Speed + 0.1;"
                  onCommit={(code) => write(event, code)}
                  complete={(t, c) => complete(t, c, "handler")}
                />
              </div>
            )}
          </Show>
        )}
      </For>
    </>
  );
}

/** One property, an expression unless `plain`. Under it, what stops it showing, and for
 *  words that fail for want of quotes, a way to make them text. */
function Field(p: { page: string; element: Element; key: string; label: string; placeholder?: string; plain?: boolean }) {
  const value = () => p.element.props[p.key] ?? "";
  const write = (t: string) => setProps(p.page, p.element.id, { [p.key]: t.trim() === "" ? null : t });
  const status = createMemo(() => {
    if (p.plain) return undefined;
    const r = resolve(value());
    if (r.ok) return undefined;
    if (r.unknown) return { text: `${r.unknown} is unknown right now` };
    return { text: r.error, words: !/["'`]/.test(value()) };
  });
  return (
    <div class="field" classList={{ bound: !p.plain && !isConstant(value()) }}>
      <label>{p.label}</label>
      <DraftInput value={value()} placeholder={p.placeholder} onCommit={write} complete={p.plain ? undefined : (t, c) => complete(t, c, "expression")} />
      <Show when={status()}>
        {(s) => (
          <span class="field-note">
            {s().text}
            <Show when={s().words}>
              <br />
              Text goes in quotes.{" "}
              <button class="field-fix" onClick={() => write(JSON.stringify(value().trim()))}>
                Make it text
              </button>
            </Show>
          </span>
        )}
      </Show>
    </div>
  );
}
