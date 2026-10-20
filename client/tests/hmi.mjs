// A Node client for the backend, speaking the protocol a screen speaks. Tests set up state
// with it, and an MCP server or an AI agent can drive the HMI through the same calls.

import { Decoder, Encoder } from "cbor-x";

const encoder = new Encoder({ useRecords: false });
const decoder = new Decoder({ mapsAsObjects: true, useRecords: false });

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
    this.state = { imports: [], pages: [], entities: [], values: {}, peers: [] };
    this.waiters = [];
    this.ws.onmessage = (e) => this.receive(decoder.decode(new Uint8Array(e.data)));
    this.ws.onopen = () => {
      // the heartbeat: a silent screen is dropped
      this.beat = setInterval(() => this.send({ type: "ping", t: performance.now() }), 100);
    };
    this.ws.onclose = () => clearInterval(this.beat);
  }

  receive(msg) {
    const s = this.state;
    if (msg.type === "imports") s.imports = msg.imports;
    if (msg.type === "pages") s.pages = msg.pages;
    if (msg.type === "mesh") s.entities = msg.entities;
    if (msg.type === "health") s.peers = msg.peers;
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

  async import(alias, entity, intent = "read") {
    await this.until((s) => s.entities.some((e) => e.name === entity), `${entity} on the mesh`);
    const kind = this.state.entities.find((e) => e.name === entity).kind;
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

  async addElement(page, tag, props, parent = null) {
    this.send({ type: "edit", edit: { kind: "add_element", page, parent, tag, props } });
    return (await this.next((m) => m.type === "made")).id;
  }

  async setProps(page, id, props) {
    this.send({ type: "edit", edit: { kind: "set_props", page, id, props } });
    await this.next((m) => m.type === "page" && m.page.id === page);
  }

  async removeElement(page, id) {
    this.send({ type: "edit", edit: { kind: "remove_element", page, id } });
    await this.next((m) => m.type === "page" && m.page.id === page);
  }

  page(id) {
    return this.state.pages.find((p) => p.id === id);
  }

  close() {
    clearInterval(this.beat);
    this.ws.close();
  }
}
