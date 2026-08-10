/* The sync client: one WebSocket to the backend that owns everything. This module does
 * transport and sequencing only. It never mutates a document and never decides
 * anything: it hands the app snapshots and op batches, in order.
 *
 * Anti-desync rules (PLAN.md) live here: a version that is not last + 1 is a GAP, and a
 * gap discards state and asks for a snapshot rather than patching around the hole. */

import { AttrTable, BuiltinDef, Diag, Doc, Json, Lang, Live, LogEntry, Mesh, NodeAttrs, Op, PROTO, Registry } from "./types.js";

export interface Handlers {
  /* the snapshot carries diagnostics too: they are computed at compile time, which is
     usually before this client existed, so there is no later frame to learn them from.
     `builtins` is the built-ins' editable document form (the fork source); `attrTable`
     the closed attr vocabulary; neither ever changes at runtime, so the
     snapshot is their only carrier. */
  snapshot(doc: Doc, registry: Registry, live: Live, diag: Diag[], mesh: Mesh,
           lang: Lang, attrTable: AttrTable, builtins: BuiltinDef[],
           nodeAttrs: Record<string, NodeAttrs>): void;
  ops(version: number, ops: Op[], origin: number): void;
  live(live: Live): void;
  diag(diag: Diag[]): void;
  /* the reflected entity tree changed (a peer or schema came or went) */
  mesh(mesh: Mesh): void;
  /* the log: `fresh` entries just happened (append them, pop what pops); the
     snapshot's backlog is history (fresh = false — replace, and never pop) */
  log(entries: LogEntry[], fresh: boolean): void;
  status(state: Status, detail: string): void;
}

export type Status = "connecting" | "live" | "offline";

export class Connection {
  private ws: WebSocket | null = null;
  private version = 0;
  private session = 0;
  private retry = 0;
  private timer = 0;
  private inflight = false;
  private pending: Op[] = [];

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
   * is never in the way of typing.
   *
   * ONE batch in flight at a time: a commit issued before the previous echo lands is
   * queued and sent against the echoed version, so a rapid committer (a color-picker
   * drag) can never self-inflict a stale base and the reject it brings. */
  apply(ops: Op[]): void {
    if (!ops.length) return;
    if (this.inflight) {
      for (const op of ops) this.enqueue(op);
      return;
    }
    this.inflight = true;
    this.send({ type: "apply_ops", base_version: this.version, ops });
  }

  /* the newest set_prop to a (node, key) replaces a queued one: a drag coalesces to
     whatever is current when the echo lands, never a backlog of stale frames */
  private enqueue(op: Op): void {
    if (op.op === "set_prop") {
      const at = this.pending.findIndex(
        (queued) => queued.op === "set_prop" && queued.node === op.node && queued.key === op.key,
      );
      if (at >= 0) {
        this.pending[at] = op;
        return;
      }
    }
    this.pending.push(op);
  }

  private flush(): void {
    this.inflight = false;
    if (!this.pending.length) return;
    const ops = this.pending;
    this.pending = [];
    this.inflight = true;
    this.send({ type: "apply_ops", base_version: this.version, ops });
  }

  view(page_id: number, visible: boolean): void {
    this.send({ type: "view", page_id, visible });
  }

  input(widget_id: number, event: string, value: Json, seq: number, part = ""): void {
    this.send({ type: "input", widget_id, event, value, seq, part });
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
        /* a snapshot settles everything outstanding (it follows every reject and
           resync), so anything queued goes out against its fresh version */
        this.version = frame.version;
        this.handlers.snapshot(frame.doc, frame.registry, frame.live,
          frame.diag?.compile ?? [], frame.mesh ?? { entities: [] },
          frame.lang ?? { builtins: [], methods: [] },
          frame.attr_table ?? { kinds: [], common: [], perKind: {} },
          frame.builtins ?? [],
          frame.node_attrs ?? {});
        this.handlers.log(frame.log ?? [], false);
        this.flush();
        return;
      case "ops_applied":
        if (frame.version !== this.version + 1) {
          /* a gap: never patch around it */
          this.send({ type: "resync" });
          return;
        }
        this.version = frame.version;
        this.handlers.ops(frame.version, frame.ops, frame.origin_session);
        /* our own echo: the in-flight batch landed, the queue may go out */
        if (frame.origin_session === this.session) this.flush();
        return;
      case "live":
        this.handlers.live(frame);
        return;
      case "diag":
        this.handlers.diag(frame.compile ?? []);
        return;
      case "mesh":
        this.handlers.mesh({ entities: frame.entities ?? [], types: frame.types ?? [] });
        return;
      case "log":
        this.handlers.log(frame.entries ?? [], true);
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
    /* no optimism: edits that never reached the old session are dropped, not replayed */
    this.inflight = false;
    this.pending = [];
    this.handlers.status("offline", why);
    const delay = Math.min(4000, 250 * Math.pow(2, this.retry++));
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      this.connect();
    }, delay);
  }
}
