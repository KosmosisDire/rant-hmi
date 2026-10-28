// A user checks where a member is named before changing it: its inspector lists each page
// element and handler that names it, leaves out text that only says its name, and opens the
// page a place is on.

export default async function ({ page, hmi, d, check }) {
  const pageId = await hmi.addPage("Uses");
  await hmi.addElement(pageId, "span", { name: "speedText", x: "44", y: "44", w: "176", h: "44", text: 'Line.Speed.toFixed(1) + " m/s"' });
  await hmi.addElement(pageId, "span", { name: "label", x: "44", y: "110", w: "176", h: "44", text: '"Speed"' });
  const knob = await hmi.addElement(pageId, "div", { name: "speedUp", x: "264", y: "44", w: "88", h: "88" });
  await hmi.setHandler(pageId, knob, "tap", "Line.Speed = Line.Speed + 0.1;");
  await d.openObject("Line");
  await d.pickMember("Speed");
  const used = page.locator(".screen:not([hidden]) .sidebar.right .list-row");
  const rows = (await used.allTextContents()).map((t) => t.trim());
  check(rows.some((r) => r.startsWith("speedText") && r.includes("Uses, text")), `the text naming Speed is not listed: ${rows}`);
  check(rows.some((r) => r.startsWith("speedUp") && r.includes("tap handler")), `the handler naming Speed is not listed: ${rows}`);
  check(!rows.some((r) => r.startsWith("label")), "a text that only says Speed was listed");

  await used.filter({ hasText: "speedText" }).click();
  await page.locator(".screen:not([hidden]) .page-row.open", { hasText: "Uses" }).waitFor();
  check((await page.locator(".tab.on").textContent()).includes("Design"), "the Design tab did not open");
}
