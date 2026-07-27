/* The sync client: one WebSocket to the backend that owns everything. This module does
 * transport and sequencing only. It never mutates a document and never decides
 * anything: it hands the app snapshots and op batches, in order.
 *
 * Anti-desync rules (PLAN.md) live here: a version that is not last + 1 is a GAP, and a
 * gap discards state and asks for a snapshot rather than patching around the hole. */

import { Doc, Json, Live, Op, PROTO, Registry } from "./types.js";

export interface Handlers {
  snapshot(doc: Doc, registry: Registry, live: Live): void;
  ops(version: number, ops: Op[], origin: number): void;
  live(live: Live): void;
  diag(diag: Json): void;
  status(state: Status, detail: string): void;
}

export type Status = "connecting" | "live" | "offline";

export class Connection {
  private ws: WebSocket | null = null;
  private version = 0;
  private session = 0;
  private retry = 0;
  private timer = 0;

  constructor(private url: string, private handlers: Handlers) {}

  /* the version the client's next edit is based on */
  base(): number {
    return this.version;
  }

  sessionId(): number {
    return this.session;
  }

  connect(): void {
    this.handlers.status("connecting", this.url);
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.send({ type: "hello", proto: PROTO, client_name: "designer" });
    };
    ws.onmessage = (event) => this.onFrame(event.data as string);
    ws.onclose = () => this.reconnect("connection closed");
    ws.onerror = () => this.reconnect("connection error");
  }

  /* Edits go out as a batch against the version this client last saw. There is no
   * optimistic apply: the backend's echo is the only thing that mutates the document,
   * so a view can never diverge. Text inputs commit on blur/Enter, so the round trip
   * is never in the way of typing. */
  apply(ops: Op[]): void {
    if (!ops.length) return;
    this.send({ type: "apply_ops", base_version: this.version, ops });
  }

  view(page_id: number, visible: boolean): void {
    this.send({ type: "view", page_id, visible });
  }

  input(widget_id: number, event: string, value: Json, seq: number): void {
    this.send({ type: "input", widget_id, event, value, seq });
  }

  private send(frame: Json): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  private onFrame(text: string): void {
    let frame: Json;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    switch (frame.type) {
      case "welcome":
        this.session = frame.session_id;
        this.handlers.status("live", "session " + frame.session_id);
        return;
      case "snapshot":
        this.version = frame.version;
        this.handlers.snapshot(frame.doc, frame.registry, frame.live);
        return;
      case "ops_applied":
        if (frame.version !== this.version + 1) {
          /* a gap: never patch around it */
          this.send({ type: "resync" });
          return;
        }
        this.version = frame.version;
        this.handlers.ops(frame.version, frame.ops, frame.origin_session);
        return;
      case "live":
        this.handlers.live(frame);
        return;
      case "diag":
        this.handlers.diag(frame);
        return;
      case "reject":
        /* the backend always follows a reject with a snapshot */
        this.handlers.status("live", "edit refused: " + frame.reason);
        return;
      default:
        return;
    }
  }

  private reconnect(why: string): void {
    if (this.ws) {
      this.ws.onopen = this.ws.onmessage = this.ws.onclose = this.ws.onerror = null;
      this.ws = null;
    }
    if (this.timer) return;
    this.version = 0;
    this.handlers.status("offline", why);
    const delay = Math.min(4000, 250 * Math.pow(2, this.retry++));
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      this.connect();
    }, delay);
  }
}
