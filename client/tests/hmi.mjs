// A Node client for the backend, speaking the protocol a screen speaks. Tests set up state
// with it, and an MCP server or an AI agent can drive the HMI through the same calls.

import { Decoder, Encoder } from "cbor-x";

const encoder = new Encoder({ useRecords: false });
const decoder = new Decoder({ mapsAsObjects: true, useRecords: false, int64AsNumber: true });

export class Hmi {
  /** Connects and waits until the backend has sent everything a screen starts from. */
  static async connect(url, timeoutMs = 5000) {
    const hmi = new Hmi(new WebSocket(url));
    await hmi.next((m) => m.type === "health", timeoutMs);
    return hmi;
  }

  constructor(ws) {
    this.ws = ws;
    this.ws.binaryType = "arraybuffer";
    this.state = { imports: [], variables: [], records: [], computed: [], enums: [], rules: [], pages: [], entities: [], values: {}, peers: [], tokens: [] };
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
    if (msg.type === "imports") s.imports = msg.imports;
    if (msg.type === "variables") s.variables = msg.variables;
    if (msg.type === "records") s.records = msg.records;
    if (msg.type === "computed") s.computed = msg.computed;
    if (msg.type === "enums") s.enums = msg.enums;
    if (msg.type === "rules") s.rules = msg.rules;
    if (msg.type === "pages") s.pages = msg.pages;
    if (msg.type === "mesh") s.entities = msg.entities;
    if (msg.type === "health") s.peers = msg.peers;
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

  async import(alias, entity, intent = "read") {
    await this.until((s) => s.entities.some((e) => e.name === entity), `${entity} on the mesh`);
    const kind = this.state.entities.find((e) => e.name === entity).kind;
    if (this.state.imports.some((i) => i.alias === alias && i.entity === entity && i.intent === intent)) return;
    // an entity takes one alias and an alias one entity, so an earlier scenario's import goes first
    for (const i of this.state.imports.filter((i) => i.entity === entity || i.alias === alias)) await this.unimport(i.alias);
    this.send({ type: "import", import: { alias, entity, kind, intent } });
    await this.next((m) => m.type === "imports" && m.imports.some((i) => i.alias === alias));
  }

  async unimport(alias) {
    this.send({ type: "unimport", alias });
    await this.next((m) => m.type === "imports" && !m.imports.some((i) => i.alias === alias));
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

  async setRule(id, rule) {
    this.send({ type: "edit", edit: { kind: "set_rule", id, rule } });
    await this.next((m) => m.type === "rules");
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
