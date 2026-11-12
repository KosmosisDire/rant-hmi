// A name in a field shows what it is: page state is coloured as the HMI's own names are, the
// caret or the pointer on it shows a card with its kind and where it is defined, and Ctrl click
// on it goes there, to the page's state in the Objects tab.

export default async function ({ page, hmi, d, check, eventually }) {
  const id = await hmi.addPage("Named");
  await hmi.edit({ kind: "set_state", page: id, id: null, name: "section", var: { name: "section", start: "overview", per: "screen" } });
  const text = await hmi.addElement(id, "span", { name: "Words", x: "4", y: "4", w: "30", h: "4", text: '"Now " + section' });
  await d.openPage("Named");
  await d.pick(text);

  const field = d.field("Text");
  const box = field.locator("xpath=..");
  const word = box.locator(".hl .hl-local", { hasText: /^section$/ });
  await word.waitFor();
  const card = page.locator(".about-card");

  // the caret in the name shows its card
  await field.click();
  await field.press("End");
  await field.press("ArrowLeft");
  await card.waitFor();
  check((await card.locator(".about-name").textContent()) === "section", `the card names ${await card.locator(".about-name").textContent()}`);
  check((await card.locator(".tag").textContent()) === "state", "the card does not say it is state");
  // the pointer left where the click put it, so only the caret's card shows
  await page.mouse.move(0, 0);
  await field.press("Escape");
  await eventually(async () => (await card.count()) === 0, "the card to go as the field lets go");

  // the pointer on it shows the card too, and Ctrl click goes to where it is defined
  const at = await word.boundingBox();
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await card.waitFor();
  await page.keyboard.down("Control");
  await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
  await page.keyboard.up("Control");
  await page.locator(".tab.on", { hasText: "Objects" }).waitFor();
  const right = page.locator(".screen:not([hidden]) .sidebar.right");
  await right.locator(".head-title", { hasText: "section" }).waitFor();
  await page.locator(`.screen:not([hidden]) .sidebar.left .list-row.selected[data-page="${id}"]`).waitFor();
}
