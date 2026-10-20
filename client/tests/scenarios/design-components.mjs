// A new user makes a Lamp component and places it twice: instances draw it scaled and pick as
// one piece, a rename reaches them, a placed component stays, and Open it goes to it.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, check, eventually }) {
  await d.tab("Design");
  const side = (sel) => page.locator(`.screen:not([hidden]) .sidebar.${sel}`);
  await side("left").locator('button[title="Add a component"]').click();
  await side("right").locator(".head-title", { hasText: "Component" }).waitFor();
  const name = d.field("Name");
  await name.fill("Lamp");
  await name.press("Enter");
  await eventually(() => hmi.state.pages.some((p) => p.name === "Lamp" && p.interface), "the component named Lamp");
  const lamp = hmi.state.pages.find((p) => p.name === "Lamp");

  await side("left").locator('button[title="Add a frame"]').click();
  await eventually(() => hmi.page(lamp.id).children.length === 1, "a frame in the component");
  await side("right").locator(".tag", { hasText: "frame" }).waitFor();
  await page.keyboard.press("Escape");
  await side("left").locator('button[title="Add a text"]').click();
  await eventually(() => hmi.page(lamp.id).children.length === 2, "a text in the component");

  const lamps = await hmi.addPage("Lamps");
  await d.openPage("Lamps");
  const place = async () => {
    await side("left").locator('button[title="Place a component"]').click();
    await page.locator(".add-menu .list-row", { hasText: "Lamp" }).click();
  };
  await place();
  await eventually(() => hmi.page(lamps).children.length === 1, "the first instance");
  const first = hmi.page(lamps).children[0];
  check(first.tag === "use" && first.component === "Lamp" && first.props.w === String(lamp.width), "the instance is not a Lamp at its size");
  await page.keyboard.press("Escape");
  await place();
  await eventually(() => hmi.page(lamps).children.length === 2, "the second instance");

  const inner = d.el(first.id).locator(".instance .el");
  check((await inner.count()) === 2, `the instance draws ${await inner.count()} of the Lamp's 2 parts`);
  const before = await inner.first().boundingBox();
  await d.el(first.id).click({ position: { x: 5, y: 5 } });
  await d.setField("w", String(Number(first.props.w) * 2));
  await d.setField("h", String(Number(first.props.h) * 2));
  await eventually(async () => {
    const after = await inner.first().boundingBox();
    return Math.abs(after.width / before.width - 2) < 0.05;
  }, "the instance to draw its Lamp twice as big");
  check((await side("right").locator(".tag").textContent()) === "instance", "a press on the instance picked a part of it");

  await d.openPage("Lamp");
  await d.setField("Name", "Light");
  await eventually(() => hmi.page(lamps).children.every((e) => e.component === "Light"), "the instances to follow the rename");

  await page.locator(".screen:not([hidden]) .sidebar.right button", { hasText: "Delete component" }).click();
  await page.locator(".notice.fault", { hasText: "Light is placed on Lamps, so it stays" }).waitFor();

  await d.openPage("Lamps");
  await d.el(first.id).click({ position: { x: 5, y: 5 } });
  await side("right").locator("button", { hasText: "Open it" }).click();
  await eventually(async () => (await page.locator(".pages .list-row.selected").first().textContent()).includes("Light"), "Open it to open the component");
  check(props(hmi, lamp.id, hmi.page(lamp.id).children[0].id) !== undefined, "the component lost its parts");
}
