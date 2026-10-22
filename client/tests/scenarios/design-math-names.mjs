// A component whose inputs are called min and max still calls the math functions of those
// names: a call by a library function's name always reaches it, and the plain name is the
// input, as a knob's sweep reads `max((value - min) / (max - min) * 75, 0)`.

export default async function ({ hmi, d, check, eventually }) {
  const dial = await hmi.addComponent("RangeDial");
  await hmi.edit({ kind: "resize_page", page: dial, width: 30, height: 6 });
  for (const [name, start] of [["min", "0"], ["max", "100"], ["value", "30"]]) {
    await hmi.edit({ kind: "set_input", page: dial, name, input: { name, default: start, bindable: false } });
  }
  await hmi.addElement(dial, "span", { name: "sweep", x: "0", y: "0", w: "30", h: "6", text: '`${max((value - min) / (max - min) * 75, 0)} ${min(max, 50)}`' });
  const pageId = await hmi.addPage("Math names");
  const inst = await hmi.addElement(pageId, "use", { name: "Dial", x: "4", y: "4", w: "30", h: "6" }, null, "RangeDial");
  await d.openPage("Math names");
  let reads = "";
  await eventually(async () => (reads = (await d.el(inst).innerText().catch(() => "")).trim()) === "22.5 50", () => `the dial to read 22.5 50, it reads "${reads}"`);
  check((await d.el(inst).locator(".faulty").count()) === 0, "the dial's text is faulty");
}
