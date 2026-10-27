// What scenarios of a screen's links share: counting the big values its data worker hands the
// page against those the HMI sent, and a way to the HMI between it and the screen, which may be
// slow, refuse every second socket, or cut connections mid message.

import net from "node:net";

import { Decoder } from "cbor-x";

/** An init script that counts in `window.__big` the big values the data worker hands the page,
 *  and keeps when each came in `window.__bigAt`. */
export function countBig() {
  const own = Object.getOwnPropertyDescriptor(Worker.prototype, "onmessage");
  Object.defineProperty(Worker.prototype, "onmessage", {
    get: own.get,
    set(f) {
      own.set.call(this, (e) => {
        if (e.data && typeof e.data === "object" && "msg" in e.data) {
          window.__big = (window.__big ?? 0) + 1;
          (window.__bigAt ??= []).push(Date.now());
        }
        f(e);
      });
    },
  });
}

/** An init script that keeps in `window.__sent` what the page sent on its sockets and its link
 *  channel, the newest last. */
export function keepSent() {
  for (const kind of [WebSocket, RTCDataChannel]) {
    const own = kind.prototype.send;
    kind.prototype.send = function (data) {
      if (typeof data !== "string") (window.__sent ??= []).push(Array.from(new Uint8Array(ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data)));
      if (window.__sent?.length > 200) window.__sent.shift();
      return own.call(this, data);
    };
  }
}

const decoder = new Decoder({ mapsAsObjects: true, useRecords: false });

/** The paths page `p` last told the backend it reads, each written with dots, as `keepSent` kept. */
export async function told(p) {
  const decoded = (b) => {
    try {
      return [decoder.decode(Uint8Array.from(b))];
    } catch {
      return [];
    }
  };
  const watch = (await p.evaluate(() => window.__sent ?? [])).flatMap(decoded).filter((m) => m?.type === "watch").at(-1);
  return watch?.reads?.map((path) => path.join(".")) ?? null;
}

/** The big values of `alias` page `p` got in 1.5 s, and those the HMI sent meanwhile, as test
 *  client `hmi` got them, so a source a busy machine slows never counts against the page. */
export async function pictures(hmi, p, alias) {
  const big = () => p.evaluate(() => window.__big ?? 0);
  const before = await big();
  const [sent] = await Promise.all([hmi.count(alias, 1500), p.waitForTimeout(1500)]);
  return { got: (await big()) - before, sent };
}

/** Whether a page kept up with what was sent, one perhaps still on its way as the count ends. */
export const keptUp = ({ got, sent }) => got >= 1 && got >= Math.min(3, sent - 1);

/** A way to the HMI on `port` at `host`: with `rate`, that many bytes a second toward the screen
 *  in one queue every connection shares, the backend read no further while 32 KB wait, so it
 *  feels the link push back as TCP does, and with `refuse` no second socket. With `far` each
 *  request names a screen on another host, as a proxy does, so the backend takes the screen
 *  for far: its values compressed, and on its WebRTC link channel once that opens. `cut` ends
 *  each connection whose request starts with `path` at once, mid message as it may be. */
export async function between(port, { host = "127.0.0.1", rate = 0, refuse = false, far = false } = {}) {
  const queue = [];
  let size = 0;
  const ups = new Set();
  const open = new Set();
  const tick =
    rate &&
    setInterval(() => {
      for (let room = rate / 100; room > 0 && queue.length; ) {
        const head = queue[0];
        const n = Math.min(room, head.chunk.length);
        if (!head.down.destroyed) head.down.write(head.chunk.subarray(0, n));
        head.chunk = head.chunk.subarray(n);
        if (head.chunk.length === 0) queue.shift();
        size -= n;
        room -= n;
      }
      if (size < 16 << 10) for (const up of ups) up.resume();
    }, 10);
  const server = net.createServer((down) => {
    down.once("data", (first) => {
      const path = /^GET (\S+)/.exec(first.toString("latin1"))?.[1] ?? "";
      if (refuse && path.startsWith("/bulk")) return down.destroy();
      // a socket still connecting keeps what it is given in order
      const up = net.connect(port, host);
      up.write(far ? Buffer.from(first.toString("latin1").replace("\r\n", "\r\nX-Forwarded-For: 203.0.113.9\r\n"), "latin1") : first);
      down.pipe(up);
      if (!rate) up.pipe(down);
      else {
        ups.add(up);
        up.on("data", (chunk) => {
          queue.push({ down, chunk });
          size += chunk.length;
          if (size > 32 << 10) for (const u of ups) u.pause();
        });
      }
      const c = {
        path,
        end() {
          open.delete(c);
          ups.delete(up);
          up.destroy();
          down.destroy();
        },
      };
      open.add(c);
      for (const s of [up, down]) s.on("close", c.end).on("error", c.end);
    });
    down.on("error", () => down.destroy());
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    /** Ends the connections whose request starts with `path`, and says how many. */
    cut(path) {
      const those = [...open].filter((c) => c.path.startsWith(path));
      for (const c of those) c.end();
      return those.length;
    },
    close() {
      for (const c of [...open]) c.end();
      clearInterval(tick);
      server.close();
    },
  };
}

/** A way to the HMI on `port` that refuses every second socket, and how to close it. */
export const refusing = (port) => between(port, { refuse: true });
