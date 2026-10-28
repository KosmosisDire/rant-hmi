// A Node client for the backend, speaking the protocol a screen speaks. Tests set up state
// with it, and an MCP server or an AI agent can drive the HMI through the same calls.

import { Decoder, Encoder } from "cbor-x";

const encoder = new Encoder({ useRecords: false });
const decoder = new Decoder({ mapsAsObjects: true, useRecords: false, int64AsNumber: true });

export class Hmi {
  /** Connects and waits until the backend has sent everything a screen starts from, of which
   *  its pages come last. */
  static async connect(url, timeoutMs = 5000) {
    const hmi = new Hmi(new WebSocket(url));
    await hmi.next((m) => m.type === "pages", timeoutMs);
    return hmi;
  }

  constructor(ws) {
    this.ws = ws;
    this.ws.binaryType = "arraybuffer";
    this.state = { objects: [], ...members([]), enums: [], pages: [], entities: [], values: {}, tokens: [] };
    this.waiters = [];
    // each message comes in pieces, `[u16 lane][u8 more]` then its share, joined per lane
    this.parts = new Map();
    this.ws.onmessage = (e) => {
      const bytes = new Uint8Array(e.data);
      const lane = bytes[0] | (bytes[1] << 8);
      const parts = [...(this.parts.get(lane) ?? []), bytes.subarray(3)];
      if (bytes[2] === 1) return this.parts.set(lane, parts);
      this.parts.delete(lane);
      const msg = decoder.decode(parts.length === 1 ? parts[0] : Buffer.concat(parts));
      if (!(lane & 0x8000) && msg.type === "values") this.seen = msg.seq;
      this.receive(msg);
      // a big value's lane, whose next value comes once this one is said to be taken
      if (lane & 0x8000 && msg.type === "values") for (const v of msg.values) this.send({ type: "took", alias: v.alias, seq: msg.seq });
    };
    this.ws.onopen = () => {
      // the heartbeat: a silent screen is dropped, and the small values it applied let the next go
      this.beat = setInterval(() => this.send({ type: "ping", t: performance.now(), seen: this.seen }), 100);
    };
    this.ws.onclose = () => clearInterval(this.beat);
  }

  receive(msg) {
    const s = this.state;
    if (msg.type === "objects") Object.assign(s, { objects: msg.objects }, members(msg.objects));
    if (msg.type === "enums") s.enums = msg.enums;
    if (msg.type === "pages") s.pages = msg.pages;
    if (msg.type === "mesh") s.entities = msg.entities;
    if (msg.type === "theme") s.tokens = msg.tokens;
    if (msg.type === "values") for (const v of msg.values) s.values[v.alias] = v;
    if (msg.type === "page") {
      const at = s.pages.findIndex((p) => p.id === msg.page.id);
      if (at < 0) s.pages.push(msg.page);
      else s.pages[at] = msg.page;
    }
    this.waiters = this.waiters.filter((w) => !w(msg));
  }

  send(msg) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(encoder.encode(msg));
  }

  /** The next message `match` accepts. A refusal rejects. */
  next(match, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the backend did not answer in time")), timeoutMs);
      this.waiters.push((msg) => {
        if (msg.type === "refused") {
          clearTimeout(timer);
          reject(new Error(msg.text));
          return true;
        }
        if (!match(msg)) return false;
        clearTimeout(timer);
        resolve(msg);
        return true;
      });
    });
  }

  /** Waits until `ready` holds for the state, as the mesh and values arrive over time. */
  async until(ready, what, timeoutMs = 5000) {
    const start = Date.now();
    while (!ready(this.state)) {
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** How many values of `alias` come in `ms`. */
  async count(alias, ms) {
    let n = 0;
    const counting = (msg) => {
      if (msg.type === "values") n += msg.values.filter((v) => v.alias === alias).length;
      return false;
    };
    this.waiters.push(counting);
    await new Promise((r) => setTimeout(r, ms));
    this.waiters = this.waiters.filter((w) => w !== counting);
    return n;
  }

  /** Makes the mesh entity `entity`, a whole path, the member `key` names, as `Line.Speed`. Its
   *  object is made first when missing, rooted at the entity's top folder. */
  async import(key, entity, intent = "read") {
    await this.until((s) => s.entities.some((e) => e.name === entity), `${entity} on the mesh`);
    const kind = this.state.entities.find((e) => e.name === entity).kind;
    if (this.state.imports.some((i) => i.alias === key && i.entity === entity && i.intent === intent)) return;
    // an entity takes one member and a key one entity, so an earlier scenario's member goes first
    for (const i of this.state.imports.filter((i) => i.entity === entity || i.alias === key)) await this.unimport(i.alias);
    const [object, alias] = split(key);
    if (!this.object(object)) await this.addObject(object, entity.split("/")[0]);
    const mesh = this.object(object).mesh;
    const path = !mesh ? entity : entity.startsWith(`${mesh}/`) ? entity.slice(mesh.length + 1) : `/${entity}`;
    this.send({ type: "import", object, import: { alias, entity: path, kind, intent } });
    await this.next((m) => m.type === "objects" && this.state.imports.some((i) => i.alias === key));
  }

  async unimport(key) {
    const [object, alias] = split(key);
    this.send({ type: "unimport", object, alias });
    await this.next((m) => m.type === "objects" && !this.state.imports.some((i) => i.alias === key));
  }

  object(name) {
    return this.state.objects.find((o) => o.name === name);
  }

  async addObject(name, mesh = "") {
    this.send({ type: "set_object", name: "", object: { name, mesh } });
    await this.next((m) => m.type === "objects" && !!this.object(name));
  }

  /** Sets the state `key` names, as `Hmi.count`, adding it when new. With no start it goes. */
  setVariable(key, start, per = "hmi") {
    const [object, name] = split(key);
    this.send({ type: "set_variable", object, name, variable: start === undefined ? null : { name, start, per } });
  }

  setComputed(key, computed) {
    const [object, name] = split(key);
    this.send({ type: "set_computed", object, name, computed: computed && { name, ...computed } });
  }

  setRecord(key, record) {
    const [object, name] = split(key);
    this.send({ type: "set_record", object, name, record: record && { name, ...record } });
  }

  /** Adds, with no id, changes or with no rule removes a rule of `object`'s logic. */
  async setRule(object, id, rule) {
    this.send({ type: "set_rule", object, id, rule });
    await this.next((m) => m.type === "objects");
  }

  set(alias, value, path = "") {
    this.send({ type: "set", alias, path, value });
  }

  async edit(edit) {
    this.send({ type: "edit", edit });
    return this.next((m) => m.type === "page" || m.type === "made");
  }

  async addPage(name) {
    this.send({ type: "edit", edit: { kind: "add_page", name } });
    return (await this.next((m) => m.type === "made")).id;
  }

  async addComponent(name) {
    this.send({ type: "edit", edit: { kind: "add_component", name } });
    return (await this.next((m) => m.type === "made")).id;
  }

  async addElement(page, tag, props, parent = null, component = null) {
    this.send({ type: "edit", edit: { kind: "add_element", page, parent, index: null, element: { id: "", tag, component, props, handlers: [], children: [] } } });
    return (await this.next((m) => m.type === "made")).id;
  }

  async setProps(page, id, props) {
    this.send({ type: "edit", edit: { kind: "set_props", page, id, props } });
    await this.next((m) => m.type === "page" && m.page.id === page);
  }

  async setHandler(page, id, event, code, attrs, filter) {
    this.send({ type: "edit", edit: { kind: "set_handler", page, id, event, filter, code, attrs } });
    await this.next((m) => m.type === "page" && m.page.id === page);
  }

  async removeElement(page, id) {
    this.send({ type: "edit", edit: { kind: "remove_element", page, id } });
    await this.next((m) => m.type === "page" && m.page.id === page);
  }

  undo() {
    this.send({ type: "undo" });
  }

  redo() {
    this.send({ type: "redo" });
  }

  page(id) {
    return this.state.pages.find((p) => p.id === id);
  }

  close() {
    clearInterval(this.beat);
    this.ws.close();
  }
}

/** The object and the member's name a key names, `Line` and `Speed` of `Line.Speed`. */
const split = (key) => [key.slice(0, key.indexOf(".")), key.slice(key.indexOf(".") + 1)];

/** Every object's members as lists, each named by its key and each mesh member with its whole
 *  entity path, as screens and the engine see them. A rule names its object. */
function members(objects) {
  const keyed = (list, o) => list.map((m) => ({ ...m, name: `${o.name}.${m.name}` }));
  const entity = (o, path) => (path.startsWith("/") ? path.slice(1) : o.mesh ? `${o.mesh}/${path}` : path);
  return {
    imports: objects.flatMap((o) => o.imports.map((i) => ({ ...i, alias: `${o.name}.${i.alias}`, entity: entity(o, i.entity) }))),
    variables: objects.flatMap((o) => keyed(o.variables, o)),
    records: objects.flatMap((o) => keyed(o.records, o)),
    computed: objects.flatMap((o) => keyed(o.computed, o)),
    functions: objects.flatMap((o) => keyed(o.functions, o)),
    rules: objects.flatMap((o) => o.logic.map((r) => ({ ...r, object: o.name }))),
  };
}
