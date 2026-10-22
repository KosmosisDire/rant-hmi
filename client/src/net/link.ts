// How a screen reaches its backend: a WebSocket, or in rant-hmi-app the window's own link to
// the backend in its process, which no other program can reach. Both bring the pieces the
// backend's lanes send, and take the screen's messages whole, each way in order.

declare global {
  interface Window {
    /** Set by rant-hmi-app before the page loads, when its backend runs in the same process. */
    rantHmiApp?: boolean;
  }
}

/** What a link tells the connection. */
export interface Events {
  opened(): void;
  heard(data: ArrayBuffer): void;
  closed(): void;
}

export interface Link {
  /** Sends one message, false while the link is not open. */
  send(bytes: Uint8Array<ArrayBuffer>): boolean;
  /** A network lies under it, so WebRTC beside it may be faster. */
  network: boolean;
}

/** This screen is in rant-hmi-app's window, its backend in the same process. */
export const inApp = window.rantHmiApp === true;

export function openLink(on: Events): Link {
  return inApp ? appLink(on) : socketLink(on);
}

function socketLink(on: Events): Link {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${scheme}://${location.host}/ws`);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => on.opened();
  ws.onmessage = (e) => on.heard(e.data as ArrayBuffer);
  ws.onclose = () => on.closed();
  return {
    network: true,
    send(bytes) {
      if (ws.readyState !== WebSocket.OPEN) return false;
      ws.send(bytes);
      return true;
    },
  };
}

/** The app's link, served on the window's own scheme: `POST /link` opens a session, `POST
 *  /link/<n>` sends, and `GET /link/<n>` waits for what the backend sends. Each way carries
 *  messages after their u32 lengths. One send is out at a time, and what queues meanwhile goes
 *  in the next, so the backend hears them in order. */
function appLink(on: Events): Link {
  let session: string | null = null;
  let ended = false;
  let queue: Uint8Array[] = [];
  let sending = false;
  const end = () => {
    if (ended) return;
    ended = true;
    on.closed();
  };
  const flush = async () => {
    if (sending || ended || queue.length === 0) return;
    sending = true;
    const body = framed(queue);
    queue = [];
    const ok = await fetch(`/link/${session}`, { method: "POST", body }).then((r) => r.ok, () => false);
    sending = false;
    if (!ok) return end();
    void flush();
  };
  const poll = async () => {
    while (!ended) {
      const r = await fetch(`/link/${session}`).catch(() => null);
      if (!r?.ok) return end();
      const data = await r.arrayBuffer();
      if (ended) return;
      for (const piece of unframed(data)) on.heard(piece);
    }
  };
  fetch("/link", { method: "POST" })
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.statusText))))
    .then((n) => {
      session = n;
      on.opened();
      void poll();
    }, end);
  return {
    network: false,
    send(bytes) {
      if (session === null || ended) return false;
      // the encoder reuses its buffer, so the message is copied to wait
      queue.push(bytes.slice());
      void flush();
      return true;
    },
  };
}

function framed(messages: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const body = new Uint8Array(messages.reduce((n, m) => n + 4 + m.length, 0));
  const view = new DataView(body.buffer);
  let at = 0;
  for (const m of messages) {
    view.setUint32(at, m.length, true);
    body.set(m, at + 4);
    at += 4 + m.length;
  }
  return body;
}

function* unframed(data: ArrayBuffer): Generator<ArrayBuffer> {
  const view = new DataView(data);
  for (let at = 0; at + 4 <= data.byteLength; ) {
    const n = view.getUint32(at, true);
    yield data.slice(at + 4, at + 4 + n);
    at += 4 + n;
  }
}
