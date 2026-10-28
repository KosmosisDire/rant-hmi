// A designer builds a Dropdown and a mode switch in the editor alone, each laid out in whatever
// box it gets, its look inputs that start at the theme's tokens. The dropdown keeps its open
// state of its own, lists its options by repeating one row, closes when a press lands outside
// it, and draws its list over what lies below, as wide as it, scrolling past its rows. The switch
// repeats a segment per option, sharing its width. Both pick a mode for the page.

export default async function ({ page, hmi, d, check, eventually }) {
  hmi.setVariable("Hmi.mode", "Auto");

  await d.addComponent("Dropdown", 20, 4);
  await d.sizing("Fill");
  await d.addInput("value", '""', { twoWay: true });
  await d.addInput("options", '["Auto", "Manual", "Off"]');
  await d.addInput("rows", "6");
  await d.addInput("fill", "$panel3");
  await d.addInput("listFill", "$panel2");
  await d.addInput("pickedFill", "$accentBg");
  await d.addInput("textColour", "$text");
  await d.addInput("textSize", "1.6");
  await d.addInput("radius", "$radius");
  await d.addVariable("open", "false");
  await d.addSends("change");
  await d.add("frame", { Name: "face", x: "0", y: "0", w: "100%", h: "100%", Fill: "fill", Radius: "radius" });
  await d.handler("tap", "open = !open;");
  await d.handler("outside", "open = false;");
  await d.add("frame", { Name: "content", x: "0", y: "0", w: "100%", h: "100%", Fill: "", Radius: "" });
  await d.layOut("Left to right", "Center left");
  await d.setField("Padding", "1.2");
  await d.add("text", { Name: "label", w: "fill", h: "hug", Text: "value", Colour: "textColour", Size: "textSize" });
  await d.select("content");
  await d.add("diagram", { Name: "chevron", w: "2", h: "2" });
  await d.addShape("polyline", { Points: '"0.4,0.7 1,1.3 1.6,0.7"', Stroke: "$dim", Thickness: "0.2", Transform: '`rotate(${open ? 180 : 0} 1 1)`' });
  await d.select("face");
  // under the face, as wide as it, its rows one under another
  await d.add("frame", { Name: "list", x: "0", y: "100%", w: "100%", h: "hug", Fill: "listFill", Radius: "radius" });
  await d.layOut("Top to bottom", undefined, "0");
  await d.setField("Padding", "0.4");
  await d.css('visibility: open ? "visible" : "hidden"\nmargin-top: 0.4\nbox-shadow: "0 8px 24px #000a"\nmax-height: rows * 3.6 + 0.8\noverflow-y: "auto"');
  await d.add("frame", { Name: "option", w: "fill", h: "3.6", Fill: 'item === value ? pickedFill : "transparent"', Radius: "$radiusSmall" });
  await d.setField("Repeat", "options");
  await d.handler("tap", 'value = item;\nopen = false;\nemit("change", item);');
  await d.layOut("Left to right", "Center left");
  await d.setField("Padding", "0.8");
  await d.add("text", { Name: "optionLabel", w: "fill", h: "hug", Text: "item", Colour: "textColour", Size: "textSize" });

  await d.addComponent("ModeSwitch", 24, 4);
  await d.sizing("Fill");
  await d.addInput("value", '"Auto"', { twoWay: true });
  await d.addInput("options", '["Auto", "Manual"]');
  await d.addInput("fill", "$panel");
  await d.addInput("colour", "$accent");
  await d.addInput("textColour", "$text");
  await d.addInput("pickedTextColour", "$onFill");
  await d.addInput("textSize", "1.5");
  await d.addInput("radius", "$radiusPill");
  await d.addSends("change");
  await d.add("frame", { Name: "track", x: "0", y: "0", w: "100%", h: "100%", Fill: "fill", Radius: "radius" });
  await d.layOut("Left to right", undefined, "0");
  await d.add("frame", { Name: "segment", w: "fill", h: "fill", Fill: 'item === value ? colour : "transparent"', Radius: "radius" });
  await d.setField("Repeat", "options");
  await d.handler("tap", 'value = item;\nemit("change", item);');
  await d.layOut("Left to right", "Center");
  await d.add("text", { Name: "segmentLabel", w: "hug", h: "hug", Text: "item", Colour: "item === value ? pickedTextColour : textColour", Size: "textSize" });

  await d.addPage("Modes");
  const drop = await d.place("Dropdown", { x: "4", y: "4", w: "20", h: "4", value: "Hmi.mode" });
  const swap = await d.place("ModeSwitch", { x: "28", y: "4", w: "24", h: "4", value: "Hmi.mode", options: '["Auto", "Manual", "Off"]' });
  const wide = await d.place("ModeSwitch", { x: "28", y: "12", w: "48", h: "6", value: "Hmi.mode", options: '["Auto", "Manual", "Off"]' });
  // a card placed after the dropdown, which its open list must cover
  const card = await d.add("frame", { Name: "card", x: "4", y: "9", w: "24", h: "12", Fill: "$panel3" });

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
  const [face, under] = [await inst(drop).locator('.el[data-name="face"]').boundingBox(), await list.boundingBox()];
  check(Math.abs(under.width - face.width) < 1 && under.y > face.y + face.height, "the list is not under the face, as wide as it");
  await manual.click();
  await eventually(() => hmi.state.values["Hmi.mode"]?.value === "Manual", "picking Manual to set the mode");
  await eventually(async () => !(await list.isVisible()), "the list to close on a pick");

  // the switch follows, and a press outside closes an open dropdown
  const segment = (n) => inst(swap).locator('.el[data-name="segment"]').nth(n);
  await eventually(async () => (await segment(1).evaluate((e) => getComputedStyle(e).backgroundColor)) === "rgb(220, 56, 83)", "the switch to show Manual");
  // a wider switch shares its width between its segments, each label in its middle
  const [track, parts] = [await inst(wide).boundingBox(), await inst(wide).locator('.el[data-name="segment"]').evaluateAll((es) => es.map((e) => e.getBoundingClientRect().width))];
  check(parts.length === 3 && parts.every((w) => Math.abs(w - track.width / 3) < 1), `the segments are ${parts.map(Math.round)} wide in ${Math.round(track.width)}`);
  await inst(drop).locator('.el[data-name="face"]').click();
  await eventually(() => list.isVisible(), "the list to open again");
  await page.mouse.click(900, 600);
  await eventually(async () => !(await list.isVisible()), "a press outside to close it");
  await segment(2).click();
  await eventually(() => hmi.state.values["Hmi.mode"]?.value === "Off", "the switch to set the mode");
  await eventually(async () => (await inst(drop).locator('.el[data-name="label"]').textContent()) === "Off", "the dropdown to follow");
  check(card !== drop, "the card is the dropdown");

  // a long one shows its rows, its padding above and below, and scrolls to the rest
  await d.tab("Design");
  const long = await d.place("Dropdown", { x: "4", y: "24", w: "20", h: "4", value: "Hmi.mode", options: '["Auto", "Manual", "Off", "Jog", "Home", "Teach", "Test", "Service"]', rows: "4" });
  await d.tab("Run");
  const longList = inst(long).locator('.el[data-name="list"]');
  await inst(long).locator('.el[data-name="face"]').click();
  await eventually(() => longList.isVisible(), "the long list to open");
  const [box, row] = [await longList.boundingBox(), await inst(long).locator('.el[data-name="option"]').first().boundingBox()];
  check(Math.abs(box.height / row.height - (4 + 0.8 / 3.6)) < 0.05, `the long list to show 4 rows, ${box.height} high with rows ${row.height}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 400);
  const service = inst(long).locator('.el[data-name="option"]').nth(7);
  await eventually(async () => {
    const s = await service.boundingBox();
    return s.y >= box.y - 1 && s.y + s.height <= box.y + box.height + 1;
  }, "a wheel to scroll the last option into the list");
  await service.click();
  await eventually(() => hmi.state.values["Hmi.mode"]?.value === "Service", "picking the last option to set the mode");
}
