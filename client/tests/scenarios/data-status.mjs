// A user shows the HMI's own state on a page: Hmi/Status and Hmi/Clients are on the mesh like
// any entity, read only, and import as any other, this screen among the clients, its round trip
// measured anew 20 times a second.

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
  check(typeof status.version === "string" && status.started_at > 1_700_000_000, `the status reads ${JSON.stringify(status)}`);
  await eventually(() => (hmi.state.values.Screens?.value ?? []).some((c) => c.address === "127.0.0.1" && c.ping_ms > 0), "this screen listed with its ping");
  const pings = new Set();
  for (const start = Date.now(); Date.now() - start < 1000; await page.waitForTimeout(10)) pings.add(JSON.stringify((hmi.state.values.Screens?.value ?? []).map((c) => c.ping_ms)));
  check(pings.size >= 8, `the round trips changed ${pings.size} times in a second`);
}
