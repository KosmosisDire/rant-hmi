import { createContext, createMemo, createSignal, For, Match, Show, Switch, useContext } from "solid-js";
import { produce } from "solid-js/store";
import { send } from "../../net/connection";
import { OWN, POINTER } from "../../page/PageView";
import type { Element } from "../../protocol/Element";
import type { Input } from "../../protocol/Input";
import type { Interface } from "../../protocol/Interface";
import type { Page } from "../../protocol/Page";
import type { Shows } from "../../protocol/Shows";
import { docScope, isConstant, pageScope, resolve, type Scope } from "../../state/bind";
import { complete, type Place, type Suggestion } from "../../state/complete";
import { component, setState, startPage, state } from "../../state/store";
import { openPage } from "../../state/view";
import { DraftInput } from "../../ui/DraftInput";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  Component,
  Plus,
  Square,
  TextCursorInput,
  Trash,
  Type,
  X,
} from "../../ui/icons";
import { type Align, align, find, sendEdits, setProps, spread, tops } from "./tree";

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

/** Where the fields stand: the names their code reads, and what completion offers instead
 *  of the datapoints, as a component offers its inputs. */
interface Where {
  scope: Scope;
  names?: Suggestion[];
  /** Where a handler here runs. */
  place: Place;
}

const WhereContext = createContext<() => Where>((): Where => ({ scope: pageScope, place: "handler" }));

/** The right sidebar: the selected element's properties, a word on several, or the page's
 *  when none is selected. */
export function ElementInspector(p: { page: Page | undefined; selected: string[] }) {
  const element = createMemo(() => (p.page && p.selected.length === 1 ? find(p.page.children, p.selected[0]) : undefined));
  const where = createMemo((): Where => {
    const doc = p.page;
    if (!doc?.interface) return { scope: pageScope, place: "handler" };
    const names: Suggestion[] = doc.interface.inputs.map((i) => ({ label: i.name, insert: i.name, icon: "local", type: i.bindable ? "two way input" : "input" }));
    return { scope: docScope(doc), names, place: "component" };
  });
  return (
    <Show when={p.page}>
      {(page) => (
        <WhereContext.Provider value={where}>
          <Show when={element()} fallback={p.selected.length > 1 ? <Several page={page()} ids={p.selected} /> : <PageInspector page={page()} />}>
            {(e) => <Properties page={page().id} element={e()} />}
          </Show>
        </WhereContext.Provider>
      )}
    </Show>
  );
}

/** The ways to line elements up, each as its button says it. */
const LINE_UP: [Align, string, typeof AlignStartVertical][] = [
  ["left", "Line up left edges", AlignStartVertical],
  ["centre", "Line up centres across", AlignCenterVertical],
  ["right", "Line up right edges", AlignEndVertical],
  ["top", "Line up top edges", AlignStartHorizontal],
  ["middle", "Line up middles", AlignCenterHorizontal],
  ["bottom", "Line up bottom edges", AlignEndHorizontal],
];

/** Several selected elements: how many, lining them up, and removing them. */
function Several(p: { page: Page; ids: string[] }) {
  const remove = () => sendEdits(tops(p.page, p.ids).map((e) => ({ kind: "remove_element", page: p.page.id, id: e.id })));
  const few = () => tops(p.page, p.ids).length < 3;
  return (
    <>
      <div class="pane-head">
        <span class="head-title">{p.ids.length} elements</span>
        <span class="tag">selection</span>
      </div>
      <div class="pane-body pad">
        <div class="section">Line up</div>
        <div class="tool-row">
          <For each={LINE_UP}>
            {([how, title, Icon]) => (
              <button class="icon-btn" title={title} onClick={() => align(p.page, p.ids, how)}>
                <Icon size={15} />
              </button>
            )}
          </For>
        </div>
        <div class="section">Spread</div>
        <div class="tool-row">
          <button class="icon-btn" title="Spread evenly across" disabled={few()} onClick={() => spread(p.page, p.ids, true)}>
            <AlignHorizontalDistributeCenter size={15} />
          </button>
          <button class="icon-btn" title="Spread evenly down" disabled={few()} onClick={() => spread(p.page, p.ids, false)}>
            <AlignVerticalDistributeCenter size={15} />
          </button>
        </div>
        <div class="placeholder">Drag one to move them all, or nudge them with the arrows. Shift click adds an element or takes it away.</div>
      </div>
      <div class="pane-foot">
        <button class="button" onClick={remove}>
          <Trash size={12} />
          Delete all
        </button>
      </div>
    </>
  );
}

const SHOWS: [Shows, string][] = [
  ["full", "Full"],
  ["over", "Over"],
];

/** A page side in pixels, as the backend allows. */
const side = (t: string) => /^\d+$/.test(t.trim()) && Number(t) >= 1 && Number(t) <= 16384;

function PageInspector(p: { page: Page }) {
  // here at once too, since the other side is sent with it
  const resize = (width: number, height: number) => {
    if (send({ type: "edit", edit: { kind: "resize_page", page: p.page.id, width, height } })) setState("pages", (pg) => pg.id === p.page.id, { width, height });
  };
  const isComponent = () => p.page.interface !== null;
  const lastPage = () => !isComponent() && state.pages.filter((pg) => pg.interface === null).length < 2;
  return (
    <>
      <div class="pane-head">
        <span class="head-title">{p.page.name}</span>
        <span class="tag">{isComponent() ? "component" : "page"}</span>
      </div>
      <div class="pane-body pad">
        <div class="section">{isComponent() ? "Component" : "Page"}</div>
        <div class="field">
          <label>Name</label>
          <DraftInput
            value={p.page.name}
            accept={(t) => (isComponent() ? /^[A-Z][A-Za-z0-9]*$/.test(t.trim()) : t.trim() !== "")}
            onCommit={(name) => send({ type: "edit", edit: { kind: "rename_page", page: p.page.id, name } })}
          />
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
        <Show when={p.page.interface}>
          {(i) => (
            <>
              <Inputs page={p.page.id} inputs={i().inputs} />
              <Sends page={p.page.id} events={i().events} />
            </>
          )}
        </Show>
        <Show
          when={!isComponent()}
          fallback={<div class="placeholder">Place it on a page with the component button over the layers. Every instance shows what is drawn here.</div>}
        >
          <div class="section">Look</div>
          <Field
            label="Fill"
            value={p.page.fill}
            placeholder="#15171a"
            onWrite={(fill) => send({ type: "edit", edit: { kind: "set_fill", page: p.page.id, fill: fill ?? "" } })}
          />
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
            when={startPage() === p.page.id}
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
        </Show>
      </div>
      <div class="pane-foot">
        <button
          class="button"
          disabled={lastPage()}
          title={lastPage() ? "A project keeps at least one page" : undefined}
          onClick={() => send({ type: "edit", edit: { kind: "remove_page", page: p.page.id } })}
        >
          <Trash size={12} />
          {isComponent() ? "Delete component" : "Delete page"}
        </button>
      </div>
    </>
  );
}

function Properties(p: { page: string; element: Element }) {
  // a property's value and its write, as a field takes them
  const prop = (key: string) => ({
    get value() {
      return p.element.props[key] ?? "";
    },
    onWrite: (t: string | null) => setProps(p.page, p.element.id, { [key]: t }),
  });
  const text = () => p.element.tag === "span";
  const instance = () => p.element.tag === "use";
  const input = () => p.element.tag === "input";
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
          <Switch fallback={<Square size={14} />}>
            <Match when={text()}>
              <Type size={14} />
            </Match>
            <Match when={instance()}>
              <Component size={14} />
            </Match>
            <Match when={input()}>
              <TextCursorInput size={14} />
            </Match>
          </Switch>
          <span>{p.element.props.name ?? p.element.id}</span>
        </span>
        <span class="tag">{instance() ? "instance" : text() ? "text" : input() ? "input" : "frame"}</span>
      </div>
      <div class="pane-body pad">
        <div class="section">Element</div>
        <Field {...prop("name")} label="Name" plain />
        <div class="section">Placement</div>
        <div class="placement">
          <For each={["x", "y", "w", "h"]}>{(k) => <Field {...prop(k)} label={k} />}</For>
        </div>
        <Show when={instance()}>
          <div class="section">Component</div>
          <div class="field">
            <label>Shows</label>
            <span class="instance-of">
              <span class="mono">{p.element.component}</span>
              <Show when={component(p.element.component ?? "")} fallback={<span class="field-note">is missing</span>}>
                {(c) => (
                  <button class="button" onClick={() => openPage(c().id)}>
                    Open it
                  </button>
                )}
              </Show>
            </span>
          </div>
        </Show>
        <Show when={instance() && component(p.element.component ?? "")}>
          {(c) => (
            <>
              <div class="section">Inputs</div>
              <For each={c().interface?.inputs} fallback={<div class="field-hint">{c().name} takes no inputs yet. Add them on the component.</div>}>
                {(i) => <Field {...prop(i.name)} label={i.name} placeholder={i.default} />}
              </For>
            </>
          )}
        </Show>
        <Show when={text()}>
          <div class="section">Text</div>
          <Field {...prop("text")} label="Text" />
        </Show>
        <Show when={input()}>
          <div class="section">Input</div>
          <Field {...prop("value")} label="Value" placeholder="Speed" />
          <div class="field-hint">A name such as Speed takes what an operator enters. Anything else only shows.</div>
        </Show>
        <Show when={text() || input()}>
          <For each={TEXT_LOOK}>{([label, key, hint]) => <Field {...prop(key)} label={label} placeholder={hint} />}</For>
        </Show>
        <Show when={!instance()}>
          <div class="section">Look</div>
          <For each={LOOK}>{([label, key, hint]) => <Field {...prop(key)} label={label} placeholder={hint} />}</For>
          <div class="section">More CSS</div>
          <DraftInput multiline class="editor css" value={other()} placeholder={'box-shadow: "0 2px 8px #0008"'} onCommit={setOther} />
        </Show>
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

/** An event as a person reads it: Tap, or a component's own as it is spelled. */
const label = (event: string) => ([...POINTER, "change"].includes(event) ? event[0].toUpperCase() + event.slice(1) : event);

/** The element's handlers, each a box: the event on top, the code below. Every change names
 *  one event, so two quick changes never undo each other. */
function Events(p: { page: string; element: Element }) {
  const where = useContext(WhereContext);
  const [adding, setAdding] = createSignal(false);
  const write = (event: string, code: string | null) => send({ type: "edit", edit: { kind: "set_handler", page: p.page, id: p.element.id, event, code } });
  // what this element hears: an input what is entered, others the pointer's events, and an
  // instance its component's own
  const offered = () =>
    p.element.tag === "input" ? ["change"] : [...POINTER, ...(p.element.tag === "use" ? (component(p.element.component ?? "")?.interface?.events ?? []) : [])];
  // a handler for an event no longer offered still shows, so none hides
  const events = () => [...new Set([...offered(), ...p.element.handlers.map((h) => h.event)])];
  const unused = () => offered().filter((e) => !p.element.handlers.some((h) => h.event === e));
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
            {(e) => (
              <button
                class="button"
                onClick={() => {
                  setAdding(false);
                  write(e, "");
                }}
              >
                {label(e)}
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={p.element.handlers.length === 0 && !adding()}>
        <div class="field-hint">
          {p.element.tag === "input"
            ? "Add one to run code when an operator enters a value. The code reads it as p.value."
            : "Add one to run code when this is tapped, pressed, let go or dragged. The code reads where as p.x and p.y."}
        </div>
      </Show>
      {/* one box per event, so a box never turns into another event's under the pointer */}
      <For each={events()}>
        {(event) => (
          <Show when={p.element.handlers.find((h) => h.event === event)}>
            {(h) => (
              <div class="handler">
                <div class="handler-head">
                  <span class="handler-event">{label(event)}</span>
                  <button class="icon-btn" title={`Remove the ${event} handler`} onClick={() => write(event, null)}>
                    <X size={13} />
                  </button>
                </div>
                <DraftInput
                  multiline
                  class="editor code"
                  value={h().code}
                  placeholder={where().place === "component" ? 'emit("change", p);' : "Speed = Speed + 0.1;"}
                  onCommit={(code) => write(event, code)}
                  complete={(t, c) => complete(t, c, where().place, where().names)}
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
function Field(p: { label: string; value: string; onWrite: (text: string | null) => void; placeholder?: string; plain?: boolean }) {
  const where = useContext(WhereContext);
  const value = () => p.value;
  const write = (t: string) => p.onWrite(t.trim() === "" ? null : t);
  const status = createMemo(() => {
    if (p.plain) return undefined;
    const r = resolve(value(), where().scope);
    if (r.ok) return undefined;
    if (r.unknown) return { text: `${r.unknown} is unknown right now` };
    return { text: r.error, words: !/["'`]/.test(value()) };
  });
  return (
    <div class="field" classList={{ bound: !p.plain && !isConstant(value()) }}>
      <label>{p.label}</label>
      <DraftInput value={value()} placeholder={p.placeholder} onCommit={write} complete={p.plain ? undefined : (t, c) => complete(t, c, "expression", where().names)} />
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

/** Changes a component's interface here at once too, in place, so a change right after builds
 *  on this one. The backend sends the page back should it refuse. */
function putInterface(page: string, change: (i: Interface) => void) {
  setState("pages", (pg) => pg.id === page, "interface", produce((i) => i && change(i)));
}

/** A component's inputs, each a box: its name, whether it may be written back, its default. */
function Inputs(p: { page: string; inputs: Input[] }) {
  const write = (name: string, input: Input | null) => {
    if (!send({ type: "edit", edit: { kind: "set_input", page: p.page, name, input } })) return;
    putInterface(p.page, (i) => {
      const at = i.inputs.findIndex((x) => x.name === name);
      if (at >= 0 && input) Object.assign(i.inputs[at], input);
      else if (at >= 0) i.inputs.splice(at, 1);
    });
  };
  const add = () => {
    let name = "input";
    for (let n = 2; p.inputs.some((i) => i.name === name); n++) name = `input${n}`;
    write(name, { name, default: "0", bindable: false });
  };
  return (
    <>
      <div class="section section-row">
        Inputs
        <button class="icon-btn" title="Add an input" onClick={add}>
          <Plus size={13} />
        </button>
      </div>
      <For each={p.inputs} fallback={<div class="field-hint">What each instance fills in, read here by name.</div>}>
        {(i) => (
          <div class="handler">
            <div class="handler-head">
              <DraftInput
                class="editor input-name"
                value={i.name}
                accept={(t) => /^[a-z][A-Za-z0-9]*$/.test(t.trim())}
                onCommit={(name) => write(i.name, { ...i, name: name.trim() })}
              />
              <label class="check" title="The component may write it back to what the instance binds it to">
                <input type="checkbox" checked={i.bindable} onChange={(e) => write(i.name, { ...i, bindable: e.currentTarget.checked })} />
                two way
              </label>
              <button class="icon-btn" title={`Remove the input ${i.name}`} onClick={() => write(i.name, null)}>
                <X size={13} />
              </button>
            </div>
            <div class="field input-default">
              <label>Default</label>
              <DraftInput value={i.default} onCommit={(d) => write(i.name, { ...i, default: d })} />
            </div>
          </div>
        )}
      </For>
    </>
  );
}

/** The events a component sends with `emit`, which each instance may handle. */
function Sends(p: { page: string; events: string[] }) {
  const write = (name: string, to: string | null) => {
    if (!send({ type: "edit", edit: { kind: "set_event", page: p.page, name, to } })) return;
    putInterface(p.page, (i) => {
      const at = i.events.indexOf(name);
      if (at >= 0 && to) i.events[at] = to;
      else if (at >= 0) i.events.splice(at, 1);
    });
  };
  const add = () => {
    let name = "change";
    for (let n = 2; p.events.includes(name); n++) name = `change${n}`;
    write(name, name);
  };
  return (
    <>
      <div class="section section-row">
        Sends
        <button class="icon-btn" title="Add an event it sends" onClick={add}>
          <Plus size={13} />
        </button>
      </div>
      <For each={p.events} fallback={<div class="field-hint">Events its code sends with emit, for instances to handle.</div>}>
        {(e) => (
          <div class="handler-head sends-row">
            <DraftInput class="editor input-name" value={e} accept={(t) => /^[a-z][A-Za-z0-9]*$/.test(t.trim())} onCommit={(to) => write(e, to.trim())} />
            <button class="icon-btn" title={`Stop sending ${e}`} onClick={() => write(e, null)}>
              <X size={13} />
            </button>
          </div>
        )}
      </For>
    </>
  );
}
