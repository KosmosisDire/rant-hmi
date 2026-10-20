// A designer builds a Dropdown and a mode switch in the editor alone. The dropdown keeps its
// open state of its own, lists its options by repeating one row, closes when a press lands
// outside it, and draws its list over what lies below. The switch repeats a segment per
// option. Both pick a mode for the page.

export default async function ({ page, hmi, d, check, eventually }) {
  hmi.send({ type: "set_variable", name: "mode", variable: { name: "mode", start: "Auto", per: "hmi" } });

  await d.addComponent("Dropdown", 220, 44);
  await d.addInput("value", '""', true);
  await d.addInput("options", '["Auto", "Manual", "Off"]');
  await d.addVariable("open", "false");
  await d.addSends("change");
  await d.add("frame", { Name: "face", x: "0", y: "0", w: "220", h: "44", Fill: "#2a2f35", Radius: "6" });
  await d.handler("tap", "open = !open;");
  await d.handler("outside", "open = false;");
  await d.add("text", { Name: "label", x: "14", y: "0", w: "160", h: "44", Text: "value", Colour: "#e4e6e8", Size: "18" });
  await d.css('line-height: "44px"');
  await d.select("face");
  await d.add("drawing", { Name: "chevron", x: "184", y: "12", w: "20", h: "20" });
  await d.addShape("polyline", { Points: '"4,7 10,13 16,7"', Stroke: "#9aa0a6", Width: "2", Transform: '`rotate(${open ? 180 : 0} 10 10)`' });
  await d.select("face");
  await d.add("frame", { Name: "list", x: "0", y: "48", w: "220", h: "options.length * 40 + 8", Fill: "#2a2f35", Radius: "6" });
  await d.css('display: open ? "block" : "none"\nbox-shadow: "0 8px 24px #000a"');
  await d.add("frame", { Name: "option", x: "4", y: "4 + index * 40", w: "212", h: "40", Fill: 'item === value ? "#33415a" : "transparent"', Radius: "4" });
  await d.setField("Repeat", "options");
  await d.handler("tap", 'value = item;\nopen = false;\nemit("change", item);');
  await d.add("text", { Name: "optionLabel", x: "10", y: "0", w: "192", h: "40", Text: "item", Colour: "#e4e6e8", Size: "16" });
  await d.css('line-height: "40px"');

  await d.addComponent("ModeSwitch", 264, 44);
  await d.addInput("value", '"Auto"', true);
  await d.addInput("options", '["Auto", "Manual"]');
  await d.addSends("change");
  await d.add("frame", { Name: "track", x: "0", y: "0", w: "264", h: "44", Fill: "#1e2125", Radius: "22" });
  await d.add("frame", { Name: "segment", x: "index * 264 / options.length", y: "0", w: "264 / options.length", h: "44", Fill: 'item === value ? "#4a8fd6" : "transparent"', Radius: "22" });
  await d.setField("Repeat", "options");
  await d.handler("tap", 'value = item;\nemit("change", item);');
  await d.add("text", { Name: "segmentLabel", x: "0", y: "0", w: "264 / options.length", h: "44", Text: "item", Colour: "#e4e6e8", Size: "16", Align: '"center"' });
  await d.css('line-height: "44px"');

  await d.addPage("Modes");
  const drop = await d.place("Dropdown", { x: "44", y: "44", w: "220", h: "44", value: "mode" });
  const swap = await d.place("ModeSwitch", { x: "308", y: "44", w: "264", h: "44", value: "mode", options: '["Auto", "Manual", "Off"]' });
  // a card placed after the dropdown, which its open list must cover
  const card = await d.add("frame", { Name: "card", x: "44", y: "100", w: "264", h: "132", Fill: "#3a4046" });

  await d.tab("Run");
  const inst = (id) => page.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
  await eventually(async () => (await inst(drop).locator('.el[data-name="label"]').textContent()) === "Auto", "the dropdown to show the mode");
  const list = inst(drop).locator('.el[data-name="list"]');
  check(!(await list.isVisible()), "the list shows before it is opened");
  await inst(drop).locator('.el[data-name="face"]').click();
  await eventually(() => list.isVisible(), "a tap to open the list");
  // the list is on top where it overlaps the card
  const manual = inst(drop).locator('.el[data-name="option"]').nth(1);
  const at = await manual.boundingBox();
  const top = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest(".el[data-name]")?.dataset.name, [at.x + at.width / 2, at.y + at.height / 2]);
  check(top === "optionLabel" || top === "option", `the open list is under ${top}`);
  await manual.click();
  await eventually(() => hmi.state.values.mode?.value === "Manual", "picking Manual to set the mode");
  await eventually(async () => !(await list.isVisible()), "the list to close on a pick");

  // the switch follows, and a press outside closes an open dropdown
  const segment = (n) => inst(swap).locator('.el[data-name="segment"]').nth(n);
  await eventually(async () => (await segment(1).evaluate((e) => getComputedStyle(e).backgroundColor)) === "rgb(74, 143, 214)", "the switch to show Manual");
  await inst(drop).locator('.el[data-name="face"]').click();
  await eventually(() => list.isVisible(), "the list to open again");
  await page.mouse.click(900, 600);
  await eventually(async () => !(await list.isVisible()), "a press outside to close it");
  await segment(2).click();
  await eventually(() => hmi.state.values.mode?.value === "Off", "the switch to set the mode");
  await eventually(async () => (await inst(drop).locator('.el[data-name="label"]').textContent()) === "Off", "the dropdown to follow");
  check(card !== drop, "the card is the dropdown");
}
