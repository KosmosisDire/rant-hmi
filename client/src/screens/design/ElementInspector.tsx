import { createMemo, createSignal, For, Show, useContext } from "solid-js";
import { produce } from "solid-js/store";
import { send } from "../../net/connection";
import { OWN, POINTER, SHAPES } from "../../page/PageView";
import type { Element } from "../../protocol/Element";
import type { Input } from "../../protocol/Input";
import type { Interface } from "../../protocol/Interface";
import type { Local } from "../../protocol/Local";
import type { Page } from "../../protocol/Page";
import type { Shows } from "../../protocol/Shows";
import { docScope, pageScope } from "../../state/bind";
import { componentNames, REPEAT } from "../../state/complete";
import { component, page as pageOf, setState, startPage, state } from "../../state/store";
import { openPage } from "../../state/view";
import { DraftInput } from "../../ui/DraftInput";
import { Popover } from "../../ui/Popover";
import { EventCard } from "../logic/EventCard";
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
  Copy,
  Plus,
  Trash,
  X,
  Zap,
} from "../../ui/icons";
import { makeComponent } from "./component";
import type { Typing } from "./DesignScreen";
import { BorderField, Field, type FieldProps, kindOf, type Where, WhereContext } from "./Field";
import { AddShape, GEOMETRY, PAINT, shapeKeys } from "./ShapeFields";
import { TAG_WORDS, TagIcon } from "./TagIcon";
import { type Align, align, chain, find, scopeOf, sendEdits, setProps, showProps, spread, tops } from "./tree";

/** The CSS a field offers by name, what it holds and an example of it. Anything else lives in
 *  the free CSS box. */
type Look = [string, string, Partial<FieldProps>];
const LOOK: Look[] = [
  ["Fill", "background", { kind: "colour", placeholder: "#2a2f35" }],
  ["Radius", "border-radius", { kind: "number", min: 0, placeholder: "0" }],
  ["Opacity", "opacity", { kind: "number", min: 0, max: 1, step: 0.01, placeholder: "1" }],
];
const TEXT_LOOK: Look[] = [
  ["Colour", "color", { kind: "colour", placeholder: "#e4e6e8" }],
  ["Size", "font-size", { kind: "number", min: 1, placeholder: "16" }],
  ["Weight", "font-weight", { kind: "choice", options: ["300", "400", "500", "600", "700"], placeholder: "400" }],
  ["Align", "text-align", { kind: "choice", options: ['"left"', '"center"', '"right"'], placeholder: '"left"' }],
];
const NAMED = new Set([...[...LOOK, ...TEXT_LOOK].map(([, key]) => key), "border-width", "border-style", "border-color"]);

/** The right sidebar: the selected element's properties, a word on several, or the page's
 *  when none is selected. */
export function ElementInspector(p: { page: Page | undefined; selected: string[]; typing: Typing | null }) {
  const element = createMemo(() => (p.page && p.selected.length === 1 ? find(p.page.children, p.selected[0]) : undefined));
  const where = createMemo((): Where => {
    const doc = p.page;
    if (!doc?.interface) return { scope: pageScope, place: "handler" };
    return { scope: docScope(doc), names: componentNames(doc), place: "component" };
  });
  return (
    <Show when={p.page}>
      {(page) => (
        <WhereContext.Provider value={where}>
          <Show when={element()} fallback={p.selected.length > 1 ? <Several page={page()} ids={p.selected} /> : <PageInspector page={page()} />}>
            {(e) => <Properties page={page().id} element={e()} typing={p.typing?.id === e().id ? p.typing : null} />}
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
        <button class="button" onClick={() => makeComponent(p.page, p.ids)}>
          <Component size={12} />
          Make a component
        </button>
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
  // a copy's name, free among the pages, spelled as a component's when it is one
  const duplicate = () => {
    const spell = (n: number) => (isComponent() ? `${p.page.name}Copy${n > 1 ? n : ""}` : `${p.page.name} copy${n > 1 ? ` ${n}` : ""}`);
    let n = 1;
    while (state.pages.some((pg) => pg.name === spell(n))) n++;
    send({ type: "edit", edit: { kind: "copy_page", page: p.page.id, name: spell(n) } });
  };
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
              <Variables page={p.page.id} variables={i().variables} />
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
            kind="colour"
            value={p.page.fill}
            placeholder="#15171a"
            onWrite={(fill) => send({ type: "edit", edit: { kind: "set_fill", page: p.page.id, fill: fill ?? "" } }) && setState("pages", (pg) => pg.id === p.page.id, { fill: fill ?? "" })}
            onShow={(fill) => setState("pages", (pg) => pg.id === p.page.id, { fill })}
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
        <button class="button" onClick={duplicate}>
          <Copy size={12} />
          Duplicate
        </button>
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

function Properties(p: { page: string; element: Element; typing: Typing | null }) {
  // inside a repeat, every field and handler reads the copy's index and item too
  const outer = useContext(WhereContext);
  const repeats = () => chain(pageOf(p.page)?.children ?? [], p.element.id)?.some((e) => !!e.props.repeat?.trim());
  const where = (): Where => {
    const doc = pageOf(p.page);
    return { ...outer(), scope: doc ? scopeOf(doc, p.element.id) : outer().scope, also: repeats() ? REPEAT : undefined };
  };
  // a property's value and its write, as a field takes them
  const prop = (key: string) => ({
    get value() {
      return p.element.props[key] ?? "";
    },
    onWrite: (t: string | null) => setProps(p.page, p.element.id, { [key]: t }),
    onShow: (t: string) => showProps(p.page, p.element.id, { [key]: t }),
  });
  const text = () => p.element.tag === "span";
  const instance = () => p.element.tag === "use";
  const input = () => p.element.tag === "input";
  const drawing = () => p.element.tag === "svg";
  const shape = () => SHAPES.has(p.element.tag);
  // the field a double click types into: the one asked for, else the element's main one
  const typed = (key: string) => {
    const t = p.typing;
    const want = t?.key ?? (text() || p.element.tag === "text" ? "text" : input() ? "value" : "name");
    return t && want === key ? t.n : undefined;
  };
  // the properties no field names, as CSS lines, or a shape's as attribute lines
  const named = () => (shape() ? shapeKeys(p.element.tag) : NAMED);
  const loose = (k: string) => !OWN.has(k) && !named().has(k);
  const other = () =>
    Object.entries(p.element.props)
      .filter(([k]) => loose(k))
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
      if (loose(k) && !next.has(k)) props[k] = null;
    }
    for (const [k, v] of next) props[k] = v;
    setProps(p.page, p.element.id, props);
  };
  return (
    <WhereContext.Provider value={where}>
      <div class="pane-head">
        <span class="head-title">
          <TagIcon tag={p.element.tag} size={14} />
          <span>{p.element.props.name ?? p.element.id}</span>
        </span>
        <span class="tag">{TAG_WORDS[p.element.tag]}</span>
      </div>
      <div class="pane-body pad">
        <div class="section">Element</div>
        <Field {...prop("name")} label="Name" plain focus={typed("name")} />
        <Field {...prop("repeat")} label="Repeat" placeholder="a list, or a count" />
        <Show when={p.element.props.repeat}>
          <div class="field-hint">Drawn once for each item. It and all inside it read index, from 0, and item.</div>
        </Show>
        <Show when={!shape()}>
          <div class="section">Placement</div>
          <div class="placement">
            <For each={["x", "y", "w", "h"]}>{(k) => <Field {...prop(k)} label={k} kind="number" inside min={k === "w" || k === "h" ? 0 : undefined} />}</For>
          </div>
        </Show>
        <Show when={p.element.tag === "img"}>
          <div class="section">Image</div>
          <Field {...prop("src")} label="Source" placeholder="Camera" />
          <Field {...prop("fit")} label="Fit" kind="choice" options={['"meet"', '"slice"', '"stretch"']} placeholder='"meet"' />
          <div class="field-hint">A mesh import of a Rant Image, or a URL in quotes. A drawing over it with the same fit and the picture's size as its view box lines its shapes up with the pixels.</div>
        </Show>
        <Show when={p.element.tag === "video"}>
          <div class="section">Video</div>
          <Field {...prop("src")} label="Source" placeholder="Camera" />
          <Field {...prop("fit")} label="Fit" kind="choice" options={['"meet"', '"slice"', '"stretch"']} placeholder='"meet"' />
          <div class="field-hint">A mesh import of a camera, by name. An H264 topic plays as it is, any other through its Video child, which rant-transcoder makes on the camera's host. A drawing over it lines up as over an image.</div>
        </Show>
        <Show when={drawing()}>
          <div class="section">Drawing</div>
          <Field {...prop("viewbox")} label="View box" placeholder="its size" />
          <Field {...prop("fit")} label="Fit" kind="choice" options={['"meet"', '"slice"', '"stretch"']} placeholder='"meet"' />
          <div class="field-hint">Shapes are drawn in the view box's units, by default its size in pixels. Each value is an expression, so a shape can follow a live value.</div>
        </Show>
        <Show when={shape()}>
          <div class="section">{TAG_WORDS[p.element.tag]}</div>
          <For each={GEOMETRY[p.element.tag] ?? []}>{([label, key, more]) => <Field {...prop(key)} {...more} label={label} focus={typed(key)} />}</For>
          <div class="section">Paint</div>
          <For each={PAINT.filter(([, key]) => !(p.element.tag === "g" && key === "transform"))}>{([label, key, more]) => <Field {...prop(key)} {...more} label={label} />}</For>
          <div class="section">More attributes</div>
          <DraftInput multiline class="editor css" value={other()} placeholder={'stroke-linejoin: "round"'} onCommit={setOther} />
        </Show>
        <Show when={(drawing() || shape()) && pageOf(p.page)}>{(pg) => <AddShape page={pg()} element={p.element} />}</Show>
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
                {(i) => <Field {...prop(i.name)} label={i.name} kind={kindOf(i.default)} placeholder={i.default} />}
              </For>
            </>
          )}
        </Show>
        <Show when={text()}>
          <div class="section">Text</div>
          <Field {...prop("text")} label="Text" kind="text" focus={typed("text")} />
        </Show>
        <Show when={input()}>
          <div class="section">Input</div>
          <Field {...prop("value")} label="Value" placeholder="Speed" focus={typed("value")} />
          <div class="field-hint">A name such as Speed takes what an operator enters. Anything else only shows.</div>
        </Show>
        <Show when={text() || input()}>
          <For each={TEXT_LOOK}>{([label, key, more]) => <Field {...prop(key)} {...more} label={label} />}</For>
        </Show>
        <Show when={!instance() && !shape()}>
          <div class="section">Look</div>
          <Field {...prop("background")} {...LOOK[0][2]} label="Fill" />
          <BorderField props={p.element.props} write={(props) => setProps(p.page, p.element.id, props)} show={(props) => showProps(p.page, p.element.id, props)} />
          <For each={LOOK.slice(1)}>{([label, key, more]) => <Field {...prop(key)} {...more} label={label} />}</For>
          <div class="section">More CSS</div>
          <DraftInput multiline class="editor css" value={other()} placeholder={'box-shadow: "0 2px 8px #0008"'} onCommit={setOther} />
        </Show>
        <Events page={p.page} element={p.element} />
      </div>
      <div class="pane-foot">
        <Show when={p.element.tag === "div"}>
          <button class="button" onClick={() => makeComponent(pageOf(p.page)!, [p.element.id])}>
            <Component size={12} />
            Make a component
          </button>
        </Show>
        <button class="button" onClick={() => send({ type: "edit", edit: { kind: "remove_element", page: p.page, id: p.element.id } })}>
          <Trash size={12} />
          Delete
        </button>
      </div>
    </WhereContext.Provider>
  );
}

/** The element's handlers, each a card: the event on top, the code below. Every change names
 *  one event, so two quick changes never undo each other. */
function Events(p: { page: string; element: Element }) {
  const where = useContext(WhereContext);
  const [adding, setAdding] = createSignal(false);
  let ghost!: HTMLButtonElement;
  const write = (event: string, code: string | null, after?: string) => send({ type: "edit", edit: { kind: "set_handler", page: p.page, id: p.element.id, event, code, after } });
  // what this element hears: an input what is entered, others the pointer's events, and an
  // instance its component's own
  const offered = () =>
    p.element.tag === "input" ? ["change"] : [...POINTER, ...(p.element.tag === "use" ? (component(p.element.component ?? "")?.interface?.events ?? []) : [])];
  // a handler for an event no longer offered still shows, so none hides
  const events = () => [...new Set([...offered(), ...p.element.handlers.map((h) => h.event)])];
  const unused = () => offered().filter((e) => !p.element.handlers.some((h) => h.event === e));
  return (
    <>
      <div class="section">Events</div>
      {/* one card per event, so a card never turns into another event's under the pointer */}
      <For each={events()}>
        {(event) => (
          <Show when={p.element.handlers.find((h) => h.event === event)}>
            {(h) => (
              <EventCard
                name={event}
                code={h().code}
                onCode={(code) => write(event, code)}
                onRemove={() => write(event, null)}
                after={h().after}
                onAfter={event === "hold" ? (after) => write(event, h().code, after) : undefined}
                removeTitle={`Remove the ${event} handler`}
                place={where().place}
                names={where().names}
                also={where().also}
                placeholder={where().place === "component" ? 'emit("change", p);' : "Speed = Speed + 0.1;"}
              />
            )}
          </Show>
        )}
      </For>
      <Show when={unused().length > 0}>
        <button ref={ghost} class="ghost" classList={{ on: adding() }} onClick={() => setAdding(!adding())}>
          <Plus size={13} />
          Add event
          <span class="ghost-trail">{unused().join(", ")}</span>
        </button>
      </Show>
      <Show when={adding() && unused().length > 0}>
        <Popover anchor={ghost} onClose={() => setAdding(false)} class="choice-list">
          <For each={unused()}>
            {(e) => (
              <button
                class="menu-item"
                onClick={() => {
                  setAdding(false);
                  write(e, "");
                }}
              >
                <Zap size={13} />
                <span class="mono">{e}</span>
              </button>
            )}
          </For>
        </Popover>
      </Show>
      <Show when={p.element.handlers.length === 0}>
        <div class="field-hint">
          {p.element.tag === "input"
            ? "Add one to run code when an operator enters a value. The code reads it as p.value."
            : "Add one to run code when this is tapped, pressed, let go, held or dragged, or a press lands outside it. The code reads where as p.x and p.y."}
        </div>
      </Show>
    </>
  );
}

/** What places an instance, which no input or variable may be called, as the backend says. */
const PLACING = new Set(["name", "repeat", "x", "y", "w", "h"]);

/** A name an input or a component's variable may take. */
const localName = (t: string) => /^[a-z][A-Za-z0-9]*$/.test(t.trim()) && !PLACING.has(t.trim());

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
          <div class="handler" data-input={i.name}>
            <div class="handler-head">
              <DraftInput
                class="editor input-name"
                value={i.name}
                accept={localName}
                title="camelCase, and none of name, repeat, x, y, w or h"
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

/** A component's own variables, each a box: its name and what each instance starts it at. */
function Variables(p: { page: string; variables: Local[] }) {
  const write = (name: string, local: Local | null) => {
    if (!send({ type: "edit", edit: { kind: "set_local", page: p.page, name, local } })) return;
    putInterface(p.page, (i) => {
      const at = i.variables.findIndex((x) => x.name === name);
      if (at >= 0 && local) Object.assign(i.variables[at], local);
      else if (at >= 0) i.variables.splice(at, 1);
    });
  };
  const add = () => {
    let name = "state";
    for (let n = 2; p.variables.some((v) => v.name === name); n++) name = `state${n}`;
    write(name, { name, start: "0" });
  };
  return (
    <>
      <div class="section section-row">
        Variables
        <button class="icon-btn" title="Add a variable" onClick={add}>
          <Plus size={13} />
        </button>
      </div>
      <For each={p.variables} fallback={<div class="field-hint">What each instance keeps of its own on each screen, read and set by name in its code.</div>}>
        {(v) => (
          <div class="handler" data-var={v.name}>
            <div class="handler-head">
              <DraftInput
                class="editor input-name"
                value={v.name}
                accept={localName}
                title="camelCase, and none of name, repeat, x, y, w or h"
                onCommit={(name) => write(v.name, { ...v, name: name.trim() })}
              />
              <button class="icon-btn" title={`Remove the variable ${v.name}`} onClick={() => write(v.name, null)}>
                <X size={13} />
              </button>
            </div>
            <div class="field input-default">
              <label>Start</label>
              <DraftInput value={v.start} onCommit={(start) => write(v.name, { ...v, start })} />
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
          <div class="handler-head sends-row" data-sends={e}>
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
