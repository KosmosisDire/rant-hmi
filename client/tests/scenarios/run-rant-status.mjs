// The demo line stops, so its jam shows among the conditions a page lists, with the line's log
// line, and a button clears it on the line's own status. The handler's log line reaches the
// mesh's log, and a condition the HMI raises shows beside the line's.

export default async function ({ page, hmi, d, eventually }) {
  await hmi.set("Line.Running", true);
  const pageId = await hmi.addPage("Diagnostics");
  const span = (name, y, text) => hmi.addElement(pageId, "span", { name, x: "4", y: String(y), w: "120", h: "4", text, color: "#e4e6e8" });
  const jams = await span("Jams", 4, 'rant.statuses().filter((c) => c.key === "jam").map((c) => [c.node, c.level, c.clearable].join(" ")).join(", ") || "no jam"');
  const lines = await span("Log", 10, 'rant.logs().filter((l) => l.node === "demo_line").map((l) => l.text).at(-1) ?? "no line"');
  const own = await span("Own", 16, 'rant.statuses().filter((c) => c.key === "tank").map((c) => [c.node, c.level, c.text].join(" ")).join() + " / " + rant.logs().some((l) => l.node === "hmi" && l.text === "jam cleared")');
  const clear = await hmi.addElement(pageId, "div", { name: "Clear", x: "4", y: "24", w: "16", h: "8", background: "#2a2f35" });
  await hmi.setHandler(pageId, clear, "tap", 'for (const c of rant.statuses().filter((c) => c.key === "jam")) await rant.clearStatus(c);\nlog("jam cleared");\nrant.setStatus("tank", "warn", "tank over 90%");');

  await d.openPage("Diagnostics");
  await d.tab("Run");
  const el = (id) => page.locator(`.run .el[data-id="${id}"]`);
  const shows = (id, want) => async () => (await el(id).textContent()) === want;
  const says = (id) => async () => `"${await el(id).textContent()}"`;
  // a jam left by a run before goes first
  await el(clear).click();
  await eventually(shows(jams, "no jam"), says(jams));

  await hmi.set("Line.Running", false);
  await eventually(shows(jams, "demo_line warn true"), says(jams));
  await eventually(shows(lines, "Line1 stopped"), says(lines));

  await el(clear).click();
  await eventually(shows(jams, "no jam"), says(jams));
  await eventually(shows(own, "hmi warn tank over 90% / true"), says(own));
  await hmi.set("Line.Running", true);
  await eventually(shows(lines, "Line1 started"), says(lines));
}
