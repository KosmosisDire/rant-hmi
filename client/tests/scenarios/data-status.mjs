// A user shows the HMI's own state on a page: Hmi/Status and Hmi/Clients are on the mesh like
// any entity, read only, and import as any other, this screen among the clients, its round trip
// measured anew 20 times a second and its jitter smoothed. When it started is a timestamp a
// page's math works with.

export default async function ({ page, hmi, d, check, eventually }) {
  await d.tab("Data");
  const left = page.locator(".screen:not([hidden]) .sidebar.left");
  await left.locator(".list-row.branch", { hasText: /^Hmi\/$/ }).click();
  await left.locator('.list-row[title="Hmi/Status"]').waitFor();
  check(!hmi.state.entities.find((e) => e.name === "Hmi/Status").writable, "the status takes writes");

  await hmi.import("HmiStatus", "Hmi/Status");
  await hmi.import("Screens", "Hmi/Clients");
  await eventually(() => hmi.state.values.HmiStatus?.value?.clients >= 1, "the status to count this screen");
  const status = hmi.state.values.HmiStatus.value;
  check(typeof status.version === "string" && status.started_at > 1_700_000_000_000_000, `the status reads ${JSON.stringify(status)}`);
  await eventually(() => (hmi.state.values.Screens?.value ?? []).some((c) => c.address === "127.0.0.1" && c.ping_ms > 0), "this screen listed with its ping");
  // changes counted, not values: a page's clock steps by 0.1 ms, so its round trips here repeat
  let [last, changes] = ["", 0];
  for (const start = Date.now(); Date.now() - start < 1000; await page.waitForTimeout(10)) {
    const now = JSON.stringify((hmi.state.values.Screens?.value ?? []).map((c) => c.ping_ms));
    if (now !== last) changes++;
    last = now;
  }
  check(changes >= 8, `the round trips changed ${changes} times in a second`);
  // a timestamp is microseconds a page's math can work with, as how long ago it started
  const pageId = await hmi.addPage("Status age");
  const age = await hmi.addElement(pageId, "span", { name: "age", x: "4", y: "4", w: "40", h: "4", text: 'Math.round((Date.now() * 1000 - HmiStatus.started_at) / 1e6) + " s"' });
  await d.openPage("Status age");
  await eventually(async () => /^\d+ s$/.test((await d.el(age).textContent()) ?? ""), async () => `the age reads ${await d.el(age).textContent()}`);
  const jitter = (hmi.state.values.Screens?.value ?? []).map((c) => c.jitter_ms);
  check(jitter.every((j) => typeof j === "number" && j >= 0 && j < 50) && jitter.some((j) => j > 0), `the jitters read ${jitter}`);
}
