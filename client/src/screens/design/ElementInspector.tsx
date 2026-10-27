import { createMemo, createSignal, For, Show, useContext } from "solid-js";
import { CONTEXTS, cssFault, homeOf, OWN } from "../../page/PageView";
import { isPart } from "../../page/parts";
import type { Element } from "../../protocol/Element";
import { SENDERS } from "../../protocol/events";
import type { Handler } from "../../protocol/Handler";
import type { Input } from "../../protocol/Input";
import type { Local } from "../../protocol/Local";
import type { Page } from "../../protocol/Page";
import { COMPONENT, EVENT, INPUT } from "../../protocol/rules";
import type { Shows } from "../../protocol/Shows";
import type { Sizing } from "../../protocol/Sizing";
import { docScope, type Flow, pageScope, resolve, type Scope, sizeWord, tokenValue } from "../../state/bind";
import { complete, completeCss, completeType, componentNames, drawing, REPEAT, signature, signatureCss } from "../../state/complete";
import { typeList } from "../../state/types";
import { brings, filterWords, handlerKey, type Offered, offered, settingOf } from "../../state/events";
import { fits, freeName } from "../../state/names";
import { edit, show } from "../../state/change";
import { component, page as pageOf, state } from "../../state/store";
import { paintCss } from "../../ui/highlight";
import { openPage } from "../../state/view";
import { chain, find } from "../../state/elements";
import { DraftInput } from "../../ui/DraftInput";
import { openMenu } from "../../ui/Menu";
import { Popover } from "../../ui/Popover";
import { Choice } from "../../ui/Choice";
import { EventCard, EventIcon } from "../logic/EventCard";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  Pin,
  PinOff,
  Plus,
  X,
} from "../../ui/icons";
import type { Typing } from "./DesignScreen";
import { BorderField, Field, type FieldProps, keysOf, kindOf, type Moving, PADDING, PartsField, Points, POINTS, RADIUS, type Where, WhereContext } from "./Field";
import { AddRow } from "./AddRow";
import { addPart, cameraFields, PART_KINDS, partFields, partKeys } from "./SceneFields";
import { addShape, GEOMETRY, ORIGINS, PAINT, ROTATE, SHAPE_KINDS, shapeKeys, type Spec, TURN } from "./ShapeFields";
import { TAG_WORDS, TagIcon } from "./TagIcon";
import { absolute, type Align, align, boxOf, boxText, flowed, originEdits, roomOf, scopeOf, sendEdits, setProps, showProps, spread, tops } from "./tree";

/** The CSS a field offers by name, what it holds and an example of it. Anything else lives in
 *  the free CSS box. */
const LOOK: Spec[] = [
  ["Fill", "background", { kind: "colour", placeholder: "#2a2f35" }],
  ["Opacity", "opacity", { kind: "number", min: 0, max: 1, step: 0.01, placeholder: "1" }],
  // hidden clips what it holds to its box, as a card or a chart wants
  ["Overflow", "overflow", { kind: "choice", options: ['"visible"', '"hidden"'], placeholder: '"visible"' }],
];
const TEXT_LOOK: Spec[] = [
  ["Colour", "color", { kind: "colour", placeholder: "#e4e6e8" }],
  ["Size", "font-size", { kind: "number", min: 0.1, step: 0.1, placeholder: "1.6" }],
  ["Weight", "font-weight", { kind: "choice", options: ["300", "400", "500", "600", "700"], placeholder: "400" }],
  ["Align", "text-align", { kind: "choice", options: ['"left"', '"center"', '"right"'], placeholder: '"left"' }],
  // a text's lines within its box, as CSS aligns a block's content
  ["Vertical", "align-content", { kind: "choice", options: ['"start"', '"center"', '"end"'], placeholder: '"start"' }],
];
/** The properties whose changes may animate, by key, each the CSS property it draws as. */
const ANIMATES: Record<string, string> = {
  x: "left",
  y: "top",
  w: "width",
  h: "height",
  rotate: "rotate",
  background: "background",
  opacity: "opacity",
  color: "color",
  "font-size": "font-size",
  "border-radius": "border-radius",
};
/** What of an instance animates: its box, never its inputs. */
const BOX = new Set(["x", "y", "w", "h", "rotate"]);

/** The least and most a size the page works out may be, each with its field once set. */
const LIMITS: [string, string, "w" | "h", string][] = [
  ["min w", "min-width", "w", "Min width"],
  ["min h", "min-height", "h", "Min height"],
  ["max w", "max-width", "w", "Max width"],
  ["max h", "max-height", "h", "Max height"],
];
const NAMED = new Set([...[...LOOK, ...TEXT_LOOK, ...TURN].map(([, key]) => key), "border-width", "border-style", "border-color", ...keysOf(RADIUS), ...keysOf(PADDING), "gap", "position", ...LIMITS.map(([, key]) => key)]);
/** What an instance's own fields show of its box: its turn, its place out of a flow, its size's bounds. */
const BOX_NAMED = new Set(["rotate", "position", ...LIMITS.map(([, key]) => key)]);

/** The right sidebar: the selected element's properties, a word on several, or the page's
 *  when none is selected. */
export function ElementInspector(p: { page: Page | undefined; selected: string[]; typing: Typing | null }) {
  const element = createMemo(() => (p.page && p.selected.length === 1 ? find(p.page.children, p.selected[0]) : undefined));
  const where = createMemo((): Where => {
    const doc = p.page;
    if (!doc?.interface) return { scope: pageScope, handlers: "handler", expressions: "expression" };
    return { scope: docScope(doc), names: componentNames(doc), handlers: "component", expressions: "expression" };
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

/** Several selected elements: how many, and lining them up. */
function Several(p: { page: Page; ids: string[] }) {
  return (
    <>
      <div class="pane-head">
        <span class="head-title">{p.ids.length} elements</span>
        <span class="tag">selection</span>
      </div>
      <div class="pane-body pad">
        <LineUp page={p.page} ids={p.ids} />
        <div class="placeholder">Drag one to move them all, or nudge them with the arrows. The grips of the box around them size them all. Shift click adds an element or takes it away.</div>
      </div>
    </>
  );
}

/** Lining up and spreading several elements, or what a group holds. */
function LineUp(p: { page: Page; ids: string[] }) {
  const few = () => tops(p.page, p.ids).length < 3;
  return (
    <>
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
    </>
  );
}

const SHOWS: [Shows, string][] = [
  ["full", "Full"],
  ["over", "Over"],
];

/** How a component's instances draw it, as each choice says. */
const SIZINGS: [Sizing, string, string][] = [
  ["scale", "Scale", "Scaled whole to fit the box it is placed at, keeping its shape"],
  ["fill", "Fill", "Laid out in the box it is placed at, so what it places in percents stretches"],
];

/** A page side in units, as the backend allows. */
const side = (t: string) => /^\d+$/.test(t.trim()) && Number(t) >= 1 && Number(t) <= 1600;

function PageInspector(p: { page: Page }) {
  const resize = (width: number, height: number) => edit({ kind: "resize_page", page: p.page.id, width, height });
  const isComponent = () => p.page.interface !== null;
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
            accept={(t) => (isComponent() ? fits(COMPONENT, t.trim()) : t.trim() !== "")}
            onCommit={(name) => edit({ kind: "rename_page", page: p.page.id, name })}
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
              <div class="field">
                <label>Sizing</label>
                <Choice options={SIZINGS} value={i().sizing} onPick={(sizing) => edit({ kind: "set_sizing", page: p.page.id, sizing })} />
              </div>
              <Inputs page={p.page.id} inputs={i().inputs} />
              <Variables page={p.page.id} variables={i().variables} />
              <Sends page={p.page.id} events={i().events} />
            </>
          )}
        </Show>
        <Show when={!isComponent()}>
          <div class="section">Look</div>
          <Field
            label="Fill"
            kind="colour"
            value={p.page.fill}
            placeholder="$ground"
            onWrite={(fill) => edit({ kind: "set_fill", page: p.page.id, fill: fill ?? "" })}
            onShow={(fill) => show({ kind: "set_fill", page: p.page.id, fill })}
          />
          <div class="field">
            <label>Shows</label>
            <Choice options={SHOWS} value={p.page.shows} onPick={(shows) => edit({ kind: "set_shows", page: p.page.id, shows })} />
          </div>
        </Show>
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
    // a frame's own properties are CSS, which the browser may drop, and of an instance's only its turn
    check: placed() && !OWN.has(key) && (!instance() || key === "rotate") ? (v: unknown) => cssFault(key, v) : undefined,
    motion: moving(key),
  });
  // how a property's changes animate, in the element's transition, where it draws as CSS
  const moving = (key: string): Moving | undefined => {
    if (!ANIMATES[key] || !placed() || grouped() || (instance() && !BOX.has(key))) return undefined;
    return {
      property: ANIMATES[key],
      get transition() {
        return p.element.props.transition ?? "";
      },
      write: (t) => setProps(p.page, p.element.id, { transition: t }),
    };
  };
  // a new origin leaves the element where it is drawn
  const newOrigin = (t: string | null) => sendEdits(originEdits(pageOf(p.page)!, p.element.id, t));
  const text = () => p.element.tag === "span";
  const instance = () => p.element.tag === "use";
  const input = () => p.element.tag === "input";
  const diagram = () => p.element.tag === "svg";
  // a shape draws in a diagram and a part in a scene, the rest is placed on the page
  const placed = () => homeOf(p.element.tag) === "page";
  const shape = () => homeOf(p.element.tag) === "diagram";
  const part = () => homeOf(p.element.tag) === "scene";
  const scene = () => p.element.tag === "scene";
  const grouped = () => p.element.tag === "group";
  // the context a canvas draws with, which its draw code completes for
  const context = () => {
    const r = resolve(p.element.props.context, where().scope);
    return r.ok && r.value === "webgl2" ? "webgl2" : "2d";
  };
  // a frame that lays it out places it, so its x and y wait, unless it is placed freely
  const room = () => {
    const doc = pageOf(p.page);
    return doc ? roomOf(doc, p.element.id) : undefined;
  };
  const flowing = () => {
    const r = room();
    return !!r && flowed(p.element, r, where().scope);
  };
  // out of the flow it stays where it was drawn, and back in it its x and y wait again
  const placeFreely = () => {
    const [doc, r] = [pageOf(p.page), room()];
    if (!doc || !r) return;
    const b = boxOf(p.element, r, undefined, where().scope);
    setProps(p.page, p.element.id, { position: '"absolute"', x: boxText(p.element, "x", b, r), y: boxText(p.element, "y", b, r) });
  };
  // hug fits what it holds or shows, fill takes the room its frame's flow leaves
  const sizing = () => ({ hug: p.element.props.layout !== undefined || text() || instance(), fill: flowing() });
  const fixed = (k: "w" | "h") => {
    const doc = pageOf(p.page);
    const b = doc && absolute(doc, p.element.id);
    if (b) setProps(p.page, p.element.id, { [k]: String(Math.round(k === "w" ? b.w : b.h)) });
  };
  // a size that may hug or fill offers them from its label, which a dotted line marks
  const sizes = (k: "w" | "h") => {
    if (!sizing().hug && !sizing().fill) return undefined;
    const now = () => sizeWord(p.element.props[k]);
    const mark = (on: boolean) => (on ? <Check size={13} /> : undefined);
    // a limit starts at the size drawn now, and a second pick takes it away
    const limit = (key: string) => {
      const doc = pageOf(p.page);
      const b = doc && absolute(doc, p.element.id);
      if (p.element.props[key] !== undefined) setProps(p.page, p.element.id, { [key]: null });
      else if (b) setProps(p.page, p.element.id, { [key]: String(Math.round(k === "w" ? b.w : b.h)) });
    };
    const choose = (lead: HTMLElement) => {
      const r = lead.getBoundingClientRect();
      openMenu({ x: r.left, y: r.bottom + 4 }, [
        { label: "Fixed", icon: mark(!now()), run: () => now() && fixed(k) },
        ...(sizing().hug ? [{ label: "Hug", icon: mark(now() === "hug"), run: () => setProps(p.page, p.element.id, { [k]: "hug" }) }] : []),
        ...(sizing().fill ? [{ label: "Fill", icon: mark(now() === "fill"), run: () => setProps(p.page, p.element.id, { [k]: "fill" }) }] : []),
        "-",
        ...LIMITS.filter(([, , of]) => of === k).map(([, key, , words]) => ({ label: words, icon: mark(p.element.props[key] !== undefined), run: () => limit(key) })),
      ]);
    };
    return { icon: <span class="sizes">{k}</span>, title: "Drag to change it, click for Fixed, Hug, Fill or its least and most", onClick: choose };
  };
  // the field a double click types into: the one asked for, else the element's main one
  const typed = (key: string) => {
    const t = p.typing;
    const want = t?.key ?? (text() || p.element.tag === "text" ? "text" : input() ? "value" : "name");
    return t && want === key ? t.n : undefined;
  };
  // the properties no field names, as CSS lines, or a shape's as attribute lines
  const named = () => (shape() ? shapeKeys(p.element.tag) : isPart(p.element.tag) ? partKeys(p.element.tag) : instance() ? BOX_NAMED : NAMED);
  const inputs = () => new Set(component(p.element.component ?? "")?.interface?.inputs.map((i) => i.name));
  const loose = (k: string) => !OWN.has(k) && !named().has(k) && !(instance() && inputs().has(k));
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
        <Show
          when={!grouped()}
          fallback={
            <>
              <LineUp page={pageOf(p.page)!} ids={p.element.children.map((c) => c.id)} />
              <div class="placeholder">A group keeps what it holds together. A click picks it whole and another the part under the pointer, and its grips size all it holds. Ctrl Shift G ungroups it.</div>
            </>
          }
        >
          <Field {...prop("repeat")} label="Repeat" placeholder="a list, or a count" />
        </Show>
        <Show when={placed() && !grouped()}>
          <div class="section">Placement</div>
          <div class="placement">
            <For each={flowing() ? ["w", "h"] : ["x", "y", "w", "h"]}>
              {(k) => <Field {...prop(k)} label={k} kind="number" inside percent min={k === "w" || k === "h" ? 0 : undefined} lead={k === "w" || k === "h" ? sizes(k) : undefined} />}
            </For>
            <For each={LIMITS.filter(([, key]) => p.element.props[key] !== undefined)}>{([label, key]) => <Field {...prop(key)} label={label} kind="number" inside min={0} />}</For>
          </div>
          <Show when={room()?.flows}>
            <Show
              when={flowing()}
              fallback={
                <button class="ghost" title="Its frame lays it out again, after what comes before it" onClick={() => setProps(p.page, p.element.id, { position: null })}>
                  <PinOff size={13} />
                  Put it back in the layout
                </button>
              }
            >
              <button class="ghost" title="Its x and y place it over the layout, which leaves it out" onClick={placeFreely}>
                <Pin size={13} />
                Place it freely
              </button>
            </Show>
          </Show>
          {/* the point x and y place, its children count from and it turns about */}
          <Field {...prop("origin")} onWrite={newOrigin} label="Origin" kind="point" options={ORIGINS} placeholder='"0% 0%"' />
          <Turn prop={prop} specs={[ROTATE]} />
          <Show when={p.element.tag === "div"}>
            <AutoLayout page={p.page} element={p.element} prop={prop} />
          </Show>
        </Show>
        <Show when={p.element.tag === "media"}>
          <div class="section">Media</div>
          <Field {...prop("src")} label="Source" placeholder="Camera" source />
          <Field {...prop("fit")} label="Fit" kind="choice" options={['"meet"', '"slice"', '"stretch"']} placeholder='"meet"' />
        </Show>
        <Show when={diagram()}>
          <div class="section">Diagram</div>
          <Field {...prop("viewbox")} label="View box" placeholder="its size" />
          <Field {...prop("fit")} label="Fit" kind="choice" options={['"meet"', '"slice"', '"stretch"']} placeholder='"meet"' />
        </Show>
        <Show when={p.element.tag === "markup"}>
          <div class="section">SVG</div>
          <DraftInput
            multiline
            code
            class="editor code"
            value={p.element.props.markup ?? ""}
            placeholder={['`<svg viewBox="0 0 100 100">', '  <circle cx="50" cy="50" r="${Speed * 40}"/>', '</svg>`'].join("\n")}
            onCommit={(t) => setProps(p.page, p.element.id, { markup: t.trim() === "" ? null : t })}
            complete={(t, c) => complete(t, c, where().expressions, where().names, where().also)}
          />
        </Show>
        <Show when={p.element.tag === "canvas"}>
          <div class="section">Canvas</div>
          <Field {...prop("context")} label="Context" kind="choice" options={CONTEXTS.map((c) => `"${c}"`)} placeholder='"2d"' />
          <DraftInput
            multiline
            code
            class="editor code"
            value={p.element.props.draw ?? ""}
            placeholder={["ctx.fillStyle = $accent;", "ctx.fillRect(0, 0, width * Speed, height);"].join("\n")}
            onCommit={(t) => setProps(p.page, p.element.id, { draw: t.trim() === "" ? null : t })}
            complete={(t, c) => complete(t, c, where().expressions, where().names, [...(where().also ?? []), ...drawing(context())])}
          />
        </Show>
        <Show when={shape()}>
          <div class="section">{TAG_WORDS[p.element.tag]}</div>
          <For each={GEOMETRY[p.element.tag] ?? []}>{([label, key, more]) => <Field {...prop(key)} {...more} label={label} focus={typed(key)} />}</For>
          <Turn prop={(key) => (key === "origin" ? { ...prop(key), onWrite: newOrigin } : prop(key))} specs={TURN} />
          <div class="section">Paint</div>
          <For each={PAINT.filter(([, key]) => !(p.element.tag === "g" && key === "transform"))}>{([label, key, more]) => <Field {...prop(key)} {...more} label={label} />}</For>
          <div class="section">More attributes</div>
          <LooseProps page={p.page} element={p.element} loose={loose} placeholder="stroke-linejoin: round" css={false} />
        </Show>
        <Show when={(diagram() || shape()) && pageOf(p.page)}>{(pg) => <AddRow section="Shapes" label="Add shape" kinds={SHAPE_KINDS} onAdd={(tag) => addShape(pg(), p.element, tag)} />}</Show>
        <Show when={scene()}>
          <div class="section">Camera</div>
          <For each={cameraFields()}>{([label, key, more]) => <Field {...prop(key)} {...more} label={label} />}</For>
        </Show>
        <Show when={part()}>
          <div class="section">{TAG_WORDS[p.element.tag]}</div>
          <For each={isPart(p.element.tag) ? partFields(p.element.tag) : []}>{([label, key, more]) => <Field {...prop(key)} {...more} label={label} />}</For>
        </Show>
        <Show when={(scene() || part()) && pageOf(p.page)}>{(pg) => <AddRow section="Parts" label="Add part" kinds={PART_KINDS} onAdd={(tag) => addPart(pg(), p.element, tag)} />}</Show>
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
        <Show when={instance() && component(p.element.component ?? "")?.interface?.inputs}>
          {(inputs) => (
            <Show when={inputs().length > 0}>
              <div class="section">Inputs</div>
              <For each={inputs()}>{(i) => <Field {...prop(i.name)} label={i.name} kind={kindOf(i.default)} placeholder={i.default} />}</For>
            </Show>
          )}
        </Show>
        {/* CSS on the instance's box, as dimming or hiding it whole */}
        <Show when={instance() && component(p.element.component ?? "")}>
          <div class="section">More CSS</div>
          <LooseProps page={p.page} element={p.element} loose={loose} placeholder="opacity: Running ? 1 : 0.4" css />
        </Show>
        <Show when={text()}>
          <div class="section">Text</div>
          <Field {...prop("text")} label="Text" kind="text" focus={typed("text")} />
        </Show>
        <Show when={input()}>
          <div class="section">Input</div>
          <Field {...prop("value")} label="Value" placeholder="Speed" focus={typed("value")} />
        </Show>
        <Show when={text() || input()}>
          <For each={TEXT_LOOK.filter(([, key]) => text() || key !== "align-content")}>{([label, key, more]) => <Field {...prop(key)} {...more} label={label} />}</For>
        </Show>
        <Show when={placed() && !instance() && !grouped()}>
          <div class="section">Look</div>
          <Field {...prop("background")} {...LOOK[0][2]} label="Fill" />
          <BorderField props={p.element.props} write={(props) => setProps(p.page, p.element.id, props)} show={(props) => showProps(p.page, p.element.id, props)} />
          <PartsField of={RADIUS} props={p.element.props} write={(props) => setProps(p.page, p.element.id, props)} show={(props) => showProps(p.page, p.element.id, props)} motion={moving("border-radius")} />
          <For each={LOOK.slice(1)}>{([label, key, more]) => <Field {...prop(key)} {...more} label={label} />}</For>
          <div class="section">More CSS</div>
          <LooseProps page={p.page} element={p.element} loose={loose} placeholder="box-shadow: 0 0.2 0.8 $border" css />
        </Show>
        <Show when={!grouped() && !part()}>
          <Events page={p.page} element={p.element} focus={(key) => typed(`on:${key}`)} />
        </Show>
      </div>
    </WhereContext.Provider>
  );
}

/** A theme token as code names it, `$accent`. */
const TOKEN = /\$[A-Za-z_]\w*/g;

const tokenOf = (name: string) => state.tokens.find((t) => `$${t.name}` === name);

/** A value typed as plain CSS, as `0 0.2 0.8 $border`, where no expression reads: text the
 *  browser takes, a template where it names tokens so they stay live. Else as it was typed. */
function asCss(key: string, value: string, scope: Scope): string {
  const v = value.trim();
  const r = resolve(v, scope);
  if (r.ok || r.unknown || /^["'`]/.test(v)) return value;
  let now: string;
  try {
    now = v.replace(TOKEN, (name) => {
      const t = tokenOf(name);
      return t ? String(tokenValue(t)) : name;
    });
  } catch {
    return value;
  }
  if (cssFault(key, now)) return value;
  if (![...v.matchAll(TOKEN)].some(([name]) => tokenOf(name))) return JSON.stringify(v);
  const escaped = v.replace(/[`\\]|\$\{/g, (c) => `\\${c}`);
  return `\`${escaped.replace(TOKEN, (name) => (tokenOf(name) ? `\${${name}}` : name))}\``;
}

/** The properties no field names, as lines of `key: value` in one box: CSS on a frame's or an
 *  instance's box, or a shape's attributes. Each value is an expression, or plain CSS kept as
 *  text, and what would not show is said under the box. */
function LooseProps(p: { page: string; element: Element; loose: (key: string) => boolean; placeholder: string; css: boolean }) {
  const where = useContext(WhereContext);
  const lines = () =>
    Object.entries(p.element.props)
      .filter(([k]) => p.loose(k))
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
  // why each would not show, and for words without quotes a way to make them text
  const faults = () =>
    Object.entries(p.element.props).flatMap(([k, v]) => {
      if (!p.loose(k) || v === undefined) return [];
      const r = resolve(v, where().scope);
      if (!r.ok) return r.unknown ? [] : [{ key: k, text: `${k}: ${r.error}`, quote: /["'`]/.test(v) ? undefined : JSON.stringify(v.trim()) }];
      const bad = p.css && r.value !== undefined && r.value !== null && r.value !== "" ? cssFault(k, r.value) : undefined;
      return bad ? [{ key: k, text: bad, quote: undefined }] : [];
    });
  const commit = (body: string) => {
    const next = new Map<string, string>();
    for (const line of body.split("\n")) {
      const at = line.indexOf(":");
      if (at > 0) next.set(line.slice(0, at).trim(), asCss(line.slice(0, at).trim(), line.slice(at + 1).trim(), where().scope));
    }
    const props: Record<string, string | null> = {};
    for (const k of Object.keys(p.element.props)) if (p.loose(k) && !next.has(k)) props[k] = null;
    for (const [k, v] of next) props[k] = v;
    setProps(p.page, p.element.id, props);
  };
  return (
    <>
      <DraftInput
        multiline
        class="editor css"
        value={lines()}
        placeholder={p.placeholder}
        onCommit={commit}
        complete={(t, c) => completeCss(t, c, where().names, where().also)}
        hint={signatureCss}
        paint={paintCss}
      />
      <For each={faults()}>
        {(f) => (
          <span class="field-note">
            {f.text}
            <Show when={f.quote}>
              {(q) => (
                <>
                  {" "}
                  <button class="field-fix" onClick={() => setProps(p.page, p.element.id, { [f.key]: q() })}>
                    Make it text
                  </button>
                </>
              )}
            </Show>
          </span>
        )}
      </For>
    </>
  );
}

/** Each way a frame may lay out what it holds, as its button says it. */
const DIRECTIONS: [Flow, string, typeof ArrowRight][] = [
  ["right", "Left to right", ArrowRight],
  ["down", "Top to bottom", ArrowDown],
  ["left", "Right to left", ArrowLeft],
  ["up", "Bottom to top", ArrowUp],
];

/** How a frame lays out what it holds: not at all, each placed by its x and y, or one after
 *  another in a direction, with a gap or spread over its length, padding, wrapping and a point
 *  they sit at. */
function AutoLayout(p: { page: string; element: Element; prop: (key: string) => Pick<FieldProps, "value" | "onWrite" | "onShow"> }) {
  const text = (key: string) => p.element.props[key]?.trim();
  const set = (props: Record<string, string | null>) => setProps(p.page, p.element.id, props);
  const spread = () => text("gap") === '"auto"';
  return (
    <>
      <div class="section">Auto layout</div>
      <Show
        when={p.element.props.layout !== undefined}
        fallback={
          <button class="ghost" onClick={() => set({ layout: '"down"', gap: p.element.props.gap ?? "$space" })}>
            <Plus size={13} />
            Lay out what it holds
          </button>
        }
      >
        <div class="field">
          <label>Direction</label>
          <div class="tool-row">
            <For each={DIRECTIONS}>
              {([flow, title, Icon]) => (
                <button class="icon-btn" classList={{ on: text("layout") === `"${flow}"` }} title={title} onClick={() => set({ layout: `"${flow}"` })}>
                  <Icon size={15} />
                </button>
              )}
            </For>
            <button class="icon-btn" title="Stop laying out, so each part is placed by its x and y" onClick={() => set({ layout: null, wrap: null, align: null, gap: spread() ? null : (p.element.props.gap ?? null) })}>
              <X size={14} />
            </button>
          </div>
        </div>
        <Field {...p.prop("wrap")} label="Wrap" kind="flag" placeholder="false" />
        <div class="field">
          <label>Spacing</label>
          <Choice
            options={[
              [false, "Packed", "A gap between each"],
              [true, "Spread", "Spread over the frame's whole length"],
            ]}
            value={spread()}
            onPick={(spread) => set({ gap: spread ? '"auto"' : "$space" })}
          />
        </div>
        <Show when={!spread()}>
          <Field {...p.prop("gap")} label="Gap" kind="number" min={0} placeholder="0" />
        </Show>
        <PartsField of={PADDING} props={p.element.props} write={set} show={(props) => showProps(p.page, p.element.id, props)} />
        <div class="field">
          <label>Align</label>
          <Points values={POINTS.map((w) => `"${w}"`)} on={text("align") ?? '"top left"'} pick={(v) => set({ align: v === '"top left"' ? null : v })} />
        </div>
        {/* which part draws over the next where they overlap */}
        <div class="field">
          <label>On top</label>
          <Choice
            options={[
              [false, "Last", "Each part over the one before it"],
              [true, "First", "Each part over the one after it"],
            ]}
            value={text("stack") === '"first"'}
            onPick={(first) => set({ stack: first ? '"first"' : null })}
          />
        </div>
      </Show>
    </>
  );
}

/** How the element turns: a frame by its rotation, a shape about its origin too. */
function Turn(p: { prop: (key: string) => Pick<FieldProps, "value" | "onWrite" | "onShow" | "motion">; specs: Spec[] }) {
  return (
    <>
      <div class="section">Turn</div>
      <For each={p.specs}>{([label, key, more]) => <Field {...p.prop(key)} {...more} label={label} />}</For>
    </>
  );
}

/** What heads each sender's events in the event menu. */
/** The element's handlers, each a card: the event on top, the code below. Every change names
 *  one handler by its event and filter, so two quick changes never undo each other. */
function Events(p: { page: string; element: Element; focus: (key: string) => number | undefined }) {
  const where = useContext(WhereContext);
  const [adding, setAdding] = createSignal(false);
  let ghost!: HTMLButtonElement;
  const write = (h: Pick<Handler, "event" | "filter">, code: string | null, attrs?: Record<string, string | null>) =>
    edit({ kind: "set_handler", page: p.page, id: p.element.id, event: h.event, filter: h.filter, code, attrs });
  const heard = () => offered(p.element);
  // in the order events are offered, a handler for one no longer offered after, so none hides
  const keys = () => {
    const events = [...new Set([...heard().map((o) => o.event), ...p.element.handlers.map((h) => h.event)])];
    return events.flatMap((event) => p.element.handlers.filter((h) => h.event === event).map((h) => handlerKey(h.event, h.filter)));
  };
  // an event is offered again while none of its handlers takes any, as keydown for another key
  const unused = () => heard().filter((o) => !p.element.handlers.some((h) => h.event === o.event && Object.keys(h.filter).length === 0));
  // each sender's events stand apart, a component's under its name, once there are two
  const groups = () => {
    const from = [...new Set(unused().map((o) => o.from))];
    const head = (f: Offered["from"]) => (f === "component" ? (p.element.component ?? undefined) : SENDERS[f]);
    return from.map((f) => ({ head: from.length > 1 ? head(f) : undefined, list: unused().filter((o) => o.from === f) }));
  };
  return (
    <>
      <div class="section">Events</div>
      {/* one card per handler, so a card never turns into another's under the pointer */}
      <For each={keys()}>
        {(key) => (
          <Show when={p.element.handlers.find((h) => handlerKey(h.event, h.filter) === key)}>
            {(h) => (
              <EventCard
                name={h().event}
                filter={filterWords(h())}
                icon={<EventIcon from={heard().find((o) => o.event === h().event)?.from} />}
                code={h().code}
                onCode={(code) => write(h(), code)}
                onRemove={() => write(h(), null)}
                setting={(name) => settingOf(h(), name)}
                onAttr={(name, text) => write(h(), h().code, { [name]: text || null })}
                removeTitle={`Remove the ${h().event} handler`}
                place={where().handlers}
                names={where().names}
                also={where().also}
                brings={brings(p.element, h().event)}
                focus={p.focus(key)}
                placeholder={where().handlers === "component" ? 'emit("change", p);' : "Speed = Speed + 0.1;"}
              />
            )}
          </Show>
        )}
      </For>
      <Show when={unused().length > 0}>
        <button ref={ghost} class="ghost" classList={{ on: adding() }} onClick={() => setAdding(!adding())}>
          <Plus size={13} />
          Add event
          <span class="ghost-trail">{unused().map((o) => o.event).join(", ")}</span>
        </button>
      </Show>
      <Show when={adding() && unused().length > 0}>
        <Popover anchor={ghost} onClose={() => setAdding(false)} class="choice-list events-list">
          <For each={groups()}>
            {(g) => (
              <>
                <Show when={g.head}>
                  <div class="menu-head">{g.head}</div>
                </Show>
                <For each={g.list}>
                  {(o) => (
                    <button
                      class="menu-item"
                      onClick={() => {
                        setAdding(false);
                        write({ event: o.event, filter: {} }, "");
                      }}
                    >
                      <EventIcon from={o.from} />
                      <span class="mono">{o.event}</span>
                      <span class="menu-trail">{o.words}</span>
                    </button>
                  )}
                </For>
              </>
            )}
          </For>
        </Popover>
      </Show>
    </>
  );
}

/** What an input's default and a variable's start complete: the theme's tokens and the math. */
const constants = (text: string, caret: number) => complete(text, caret, "theme", []);

/** A name an input or a component's variable may take. */
const localName = (t: string) => fits(INPUT, t.trim());

/** A component's interface list's head, with its add button. */
function ListHead(p: { title: string; add: string; onAdd: () => void }) {
  return (
    <div class="section section-row">
      {p.title}
      <button class="icon-btn" title={p.add} onClick={() => p.onAdd()}>
        <Plus size={13} />
      </button>
    </div>
  );
}

/** A component's inputs, each a box: its name, whether it may be written back, its default and
 *  the types it takes. */
function Inputs(p: { page: string; inputs: Input[] }) {
  const write = (name: string, input: Input | null) => edit({ kind: "set_input", page: p.page, name, input });
  const add = () => {
    const name = freeName("input", (n) => p.inputs.some((i) => i.name === n));
    write(name, { name, default: "0", bindable: false, type: "" });
  };
  return (
    <>
      <ListHead title="Inputs" add="Add an input" onAdd={add} />
      <For each={p.inputs}>
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
              <DraftInput value={i.default} onCommit={(d) => write(i.name, { ...i, default: d })} complete={constants} hint={(t, c) => signature(t, c, "theme")} />
            </div>
            <div class="field input-type">
              <label>Type</label>
              <DraftInput
                value={i.type}
                accept={typeList}
                placeholder="any"
                title="The types it takes, apart by spaces, so the editor offers the component for an import of one"
                onCommit={(type) => write(i.name, { ...i, type })}
                complete={completeType}
              />
            </div>
          </div>
        )}
      </For>
    </>
  );
}

/** A component's own variables, each a box: its name and what each instance starts it at. */
function Variables(p: { page: string; variables: Local[] }) {
  const write = (name: string, local: Local | null) => edit({ kind: "set_local", page: p.page, name, local });
  const add = () => {
    const name = freeName("state", (n) => p.variables.some((v) => v.name === n));
    write(name, { name, start: "0" });
  };
  return (
    <>
      <ListHead title="Variables" add="Add a variable" onAdd={add} />
      <For each={p.variables}>
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
              <DraftInput value={v.start} onCommit={(start) => write(v.name, { ...v, start })} complete={constants} hint={(t, c) => signature(t, c, "theme")} />
            </div>
          </div>
        )}
      </For>
    </>
  );
}

/** The events a component sends with `emit`, which each instance may handle. */
function Sends(p: { page: string; events: string[] }) {
  const write = (name: string, to: string | null) => edit({ kind: "set_event", page: p.page, name, to });
  const add = () => {
    const name = freeName("change", (n) => p.events.includes(n));
    write(name, name);
  };
  return (
    <>
      <ListHead title="Sends" add="Add an event it sends" onAdd={add} />
      <For each={p.events}>
        {(e) => (
          <div class="handler-head sends-row" data-sends={e}>
            <DraftInput class="editor input-name" value={e} accept={(t) => fits(EVENT, t.trim())} onCommit={(to) => write(e, to.trim())} />
            <button class="icon-btn" title={`Stop sending ${e}`} onClick={() => write(e, null)}>
              <X size={13} />
            </button>
          </div>
        )}
      </For>
    </>
  );
}
