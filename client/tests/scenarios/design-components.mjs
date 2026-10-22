// A new user makes a Indicator component and places it twice: instances draw it scaled and pick as
// one piece, a rename reaches them and its file, a placed component stays, and Open it goes
// to it.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, check, eventually }) {
  await d.tab("Design");
  const side = (sel) => page.locator(`.screen:not([hidden]) .sidebar.${sel}`);
  await side("left").locator('button[title="Add a component"]').click();
  await side("right").locator(".head-title", { hasText: "Component" }).waitFor();
  const name = d.field("Name");
  await name.fill("Indicator");
  await name.press("Enter");
  await eventually(() => hmi.state.pages.some((p) => p.name === "Indicator" && p.interface), "the component named Indicator");
  const indicator = hmi.state.pages.find((p) => p.name === "Indicator");

  await d.addRow("Frame");
  await eventually(() => hmi.page(indicator.id).children.length === 1, "a frame in the component");
  await side("right").locator(".tag", { hasText: "frame" }).waitFor();
  await page.keyboard.press("Escape");
  await d.addRow("Text");
  await eventually(() => hmi.page(indicator.id).children.length === 2, "a text in the component");

  const indicators = await hmi.addPage("Indicators");
  await d.openPage("Indicators");
  const place = async () => {
    await d.addRow("Place a component", "Indicator");
  };
  await place();
  await eventually(() => hmi.page(indicators).children.length === 1, "the first instance");
  const first = hmi.page(indicators).children[0];
  check(first.tag === "use" && first.component === "Indicator" && first.props.w === String(indicator.width), "the instance is not a Indicator at its size");
  await page.keyboard.press("Escape");
  await place();
  await eventually(() => hmi.page(indicators).children.length === 2, "the second instance");

  const inner = d.el(first.id).locator(".instance .el");
  check((await inner.count()) === 2, `the instance draws ${await inner.count()} of the Indicator's 2 parts`);
  const before = await inner.first().boundingBox();
  await d.el(first.id).click({ position: { x: 5, y: 5 } });
  await d.setField("w", String(Number(first.props.w) * 2));
  await d.setField("h", String(Number(first.props.h) * 2));
  await eventually(async () => {
    const after = await inner.first().boundingBox();
    return Math.abs(after.width / before.width - 2) < 0.05;
  }, "the instance to draw its Indicator twice as big");
  check((await side("right").locator(".tag").textContent()) === "instance", "a press on the instance picked a part of it");

  await d.openPage("Indicator");
  await d.setField("Name", "Light");
  await eventually(() => hmi.page(indicators).children.every((e) => e.component === "Light"), "the instances to follow the rename");

  await d.menu(page.locator(".screen:not([hidden]) .pages :is(.list-row, .card)", { has: page.getByText("Light", { exact: true }) }), "Delete component");
  await page.locator(".notice.fault", { hasText: "Light is placed on Indicators, so it stays" }).waitFor();

  await d.openPage("Indicators");
  await d.el(first.id).click({ position: { x: 5, y: 5 } });
  await side("right").locator("button", { hasText: "Open it" }).click();
  await eventually(async () => (await page.locator(".pages :is(.list-row, .card).selected").first().textContent()).includes("Light"), "Open it to open the component");
  const light = hmi.state.pages.find((p) => p.name === "Light");
  check(light.id === "light" && props(hmi, light.id, light.children[0].id) !== undefined, `the component is ${light.id} and holds ${light.children.length} parts`);
}
