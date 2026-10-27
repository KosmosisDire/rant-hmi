// A screen that opens its second way again while the last is still open, as when WebTransport
// opened on the HMI's side too late for the page, which then took a socket, gets the big value
// that was on its way on the last at once, not once the HMI gives up waiting on word of it.

import { Hmi } from "../hmi.mjs";

export default async function ({ hmi, sys, check, eventually }) {
  await hmi.import("AgainScan", "Cell/Scan");
  const screen = new Hmi(new WebSocket(sys.ws));
  let hello;
  screen.waiters.push((m) => (m.type === "hello" && (hello = m), false));
  await screen.next((m) => m.type === "rules");
  /** A second way for the screen, keeping when each value came, never saying one was taken. */
  const second = () => {
    const ws = new WebSocket(`${sys.ws.replace(/\/ws$/, "")}/bulk?session=${hello.session}&key=${hello.key}`);
    ws.binaryType = "arraybuffer";
    ws.came = [];
    ws.onmessage = (e) => new Uint8Array(e.data)[2] === 0 && ws.came.push(Date.now());
    return ws;
  };
  try {
    const first = second();
    await eventually(() => first.came.length > 0, "the scan on the first second way", 5000);
    const again = second();
    await new Promise((r) => (again.onopen = r));
    const opened = Date.now();
    first.close();
    await eventually(() => again.came.length > 0, "the scan on the second way opened again", 3000);
    check(again.came[0] - opened < 1000, `the scan came ${again.came[0] - opened} ms after the second way opened again`);
    again.close();
  } finally {
    screen.close();
  }
}
