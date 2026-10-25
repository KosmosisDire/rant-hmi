// What the backend's lanes send (lanes.rs): each message in pieces, `[u16 lane][u8 more]` then
// its share, the lanes taking turns, so a small message never waits behind a whole picture. On
// WebTransport each message comes on a stream of its own instead (wt.rs).

/** Set on the lane of an import's value too big to share a message, which the data worker reads. */
export const BIG = 0x8000;

/** Joins pieces into messages for `whole`, with the lane each came in. */
export function joiner(whole: (bytes: Uint8Array, lane: number) => void): (data: ArrayBuffer) => void {
  const parts = new Map<number, Uint8Array[]>();
  return (data) => {
    const bytes = new Uint8Array(data);
    const lane = bytes[0] | (bytes[1] << 8);
    const piece = bytes.subarray(3);
    const before = parts.get(lane);
    if (bytes[2] === 1) {
      if (before) before.push(piece);
      else parts.set(lane, [piece]);
      return;
    }
    if (!before) return whole(piece, lane);
    parts.delete(lane);
    whole(joined([...before, piece]), lane);
  };
}

function joined(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return all;
}

/** Reads each stream WebTransport session `wt` brings whole, for `whole`, until it closes. */
export async function streams(wt: WebTransport, whole: (bytes: Uint8Array) => void) {
  const incoming = (wt.incomingUnidirectionalStreams as ReadableStream<ReadableStream<Uint8Array>>).getReader();
  for (;;) {
    const { value, done } = await incoming.read();
    if (done) return;
    read(value).then(whole, () => {});
  }
}

async function read(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return parts.length === 1 ? parts[0] : joined(parts);
    parts.push(value);
  }
}

/** `bytes` in a buffer of their own, which can be handed to a worker. */
export function own(bytes: Uint8Array): ArrayBuffer {
  const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
  return (whole ? bytes : bytes.slice()).buffer as ArrayBuffer;
}
