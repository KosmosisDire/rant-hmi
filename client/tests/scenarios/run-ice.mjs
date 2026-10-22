// A screen's data connection finds its way through a NAT. The backend asks the project's STUN
// server what the outside sees of its port and tells the screen, which reaches it there alone:
// a NAT in the test stands between them, and the screen hears of no other address.

import dgram from "node:dgram";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OVER_CHANNELS = "Reached over WebRTC data channels";
const COOKIE = [0x21, 0x12, 0xa4, 0x42];

async function udp() {
  const s = dgram.createSocket("udp4");
  await new Promise((r) => s.bind(0, "127.0.0.1", r));
  return s;
}

export default async function ({ page, hmi, sys, check, eventually }) {
  // each outside sender gets its own inside port toward the backend, as a NAT gives
  const nat = await udp();
  const carried = { in: 0, out: 0 };
  const inside = new Map();
  let backend = null;
  nat.on("message", (msg, from) => {
    if (!backend) return;
    const key = `${from.address}:${from.port}`;
    if (!inside.has(key)) {
      const ready = udp();
      inside.set(key, ready);
      ready.then((s) =>
        s.on("message", (m) => {
          carried.out++;
          nat.send(m, from.port, from.address);
        }),
      );
    }
    carried.in++;
    inside.get(key).then((s) => s.send(msg, backend.port, backend.address));
  });

  // a STUN server that tells whoever asks that the outside sees it at the NAT
  const stun = await udp();
  stun.on("message", (msg, from) => {
    if (msg.length < 20 || msg.readUInt16BE(0) !== 1) return;
    backend = from;
    const out = Buffer.alloc(32);
    out.writeUInt16BE(0x0101, 0);
    out.writeUInt16BE(12, 2);
    msg.copy(out, 4, 4, 20);
    out.writeUInt16BE(0x0020, 20);
    out.writeUInt16BE(8, 22);
    out.writeUInt16BE(1, 24);
    out.writeUInt16BE(nat.address().port ^ 0x2112, 26);
    [127, 0, 0, 1].forEach((b, i) => out.writeUInt8(b ^ COOKIE[i], 28 + i));
    stun.send(out, from.port, from.address);
  });

  const file = join(sys.project, "hmi.toml");
  const before = readFileSync(file, "utf8");
  const urls = `stun:127.0.0.1:${stun.address().port}`;
  const reloaded = hmi.next((m) => m.type === "project");
  writeFileSync(file, `name = "Demo line"\n[[ice]]\nurls = "${urls}"\n`);
  await reloaded;

  const context = await page.context().browser().newContext();
  await context.addInitScript(() => {
    const Own = window.RTCPeerConnection;
    window.given = [];
    window.told = [];
    window.RTCPeerConnection = class extends Own {
      constructor(c) {
        window.given.push(c?.iceServers);
        // the test's STUN server answers for the backend only, so the screen asks none
        super({ ...c, iceServers: [] });
      }
      setRemoteDescription(d) {
        const lines = d.sdp.split("\r\n");
        window.told.push(...lines.filter((l) => l.startsWith("a=candidate")));
        return super.setRemoteDescription({ type: d.type, sdp: lines.filter((l) => !/ typ host/.test(l)).join("\r\n") });
      }
      addIceCandidate(c) {
        window.told.push(c?.candidate);
        return super.addIceCandidate(c);
      }
    };
  });
  const screen = await context.newPage();
  await screen.goto(sys.url);
  try {
    const link = screen.locator(".statusbar .stat").first();
    await eventually(async () => (await link.getAttribute("title")) === OVER_CHANNELS, "the screen's channels to open through the NAT");
    const given = await screen.evaluate(() => window.given);
    check(JSON.stringify(given[0]) === JSON.stringify([{ urls }]), `the screen was given the servers ${JSON.stringify(given)}`);
    const told = await screen.evaluate(() => window.told);
    const outside = `127.0.0.1 ${nat.address().port} typ srflx`;
    check(told.some((c) => c?.includes(outside)), `the screen was told ${JSON.stringify(told)}`);
    check(carried.in > 0 && carried.out > 0, `the NAT carried ${carried.in} in and ${carried.out} out`);
    check(sys.backend.log.includes(`shows the outside 127.0.0.1:${nat.address().port}`), "the backend logs the outside its STUN server told");
  } finally {
    await context.close();
    const restored = hmi.next((m) => m.type === "project");
    writeFileSync(file, before);
    await restored;
    nat.close();
    stun.close();
    for (const s of inside.values()) (await s).close();
  }
}
