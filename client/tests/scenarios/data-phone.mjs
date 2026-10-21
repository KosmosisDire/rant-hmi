// The Data and Logic tabs on a phone. Data shows one table at a time, picked from a strip or
// paged by a sideways swipe, each row wrapped under its name with every other cell labelled by
// its column. A row tapped, or an entity picked from the drawer, shows in the risen sheet with
// the row in sight above it. Another tab lowers the sheet, and a handler picked from Logic's
// drawer puts the drawer away. A desktop keeps every table at once with its heads.

export default async function ({ page, hmi, sys, d, check, eventually }) {
  hmi.send({ type: "set_variable", name: "phoneCount", variable: { name: "phoneCount", start: 0, per: "hmi" } });
  await hmi.setRule("", { id: "", name: "Phone rule", when: { kind: "every", ms: 1000 }, code: "" });
  await eventually(() => hmi.state.imports.length >= 4, "the demo's imports");
  const last = hmi.state.imports.at(-1);

  await d.tab("Data");
  check((await page.locator(".screen:not([hidden]) .data-card:visible").count()) === 5, "a desktop shows its tables one at a time");
  check(!(await page.locator(".screen:not([hidden]) .data-cards").isVisible()), "a desktop shows the phone's table strip");
  check(await page.locator(".screen:not([hidden]) table.grid thead").first().isVisible(), "a desktop's table lost its heads");

  const phone = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const screen = await phone.newPage();
  await screen.goto(sys.url);
  await screen.locator(".statusbar", { hasText: "System" }).waitFor();
  await screen.locator(".tab", { hasText: "Data" }).tap();
  const cdp = await phone.newCDPSession(screen);
  const touch = (type, points = []) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
  const on = (selector) => screen.locator(`.screen:not([hidden]) ${selector}`);
  const [drawer, sheet, toggle] = [on(".sidebar.left"), on(".sheet.dock"), screen.locator(".topbar .bar-btn")];
  const chip = (name) => on(".data-cards button").filter({ hasText: name });
  const shown = async () => (await on(".data-cards button.on").textContent()).trim();
  const settled = async (locator, what) => {
    let last = null;
    await eventually(async () => {
      const b = await locator.boundingBox();
      const same = b && last && b.x === last.x && b.y === last.y && b.height === last.height;
      last = b;
      return same;
    }, what);
    return last;
  };
  // a row is in sight when it sits between the detail's top and the sheet's
  const inSight = async (row) => {
    const [r, top, s] = [await settled(row, "the row to come to rest"), await on(".data-detail").boundingBox(), await settled(sheet, "the sheet to rest")];
    return r.y >= top.y && r.y + r.height <= s.y + 1;
  };

  // one table, its rows wrapped: the name across the row, the rest labelled by their heads
  check((await on(".data-card:visible").count()) === 1, "a phone shows more than one table");
  check((await shown()) === "Imports", "a phone opens on another table than the imports");
  check(!(await on("table.grid thead").first().isVisible()), "a phone shows the table heads");
  const row = on("table.grid tr.row").first();
  const [rowBox, nameBox] = [await row.boundingBox(), await row.locator("td.name").boundingBox()];
  check(nameBox.width > rowBox.width - 24, `the name cell is ${nameBox.width} px of a ${rowBox.width} px row`);
  const label = await row.locator("td").nth(1).evaluate((td) => getComputedStyle(td, "::before").content);
  check(label === '"Entity"', `the entity cell is labelled ${label}`);
  check((await on(".data-detail").evaluate((e) => e.scrollWidth - e.clientWidth)) === 0, "the table runs off the side");

  // a sideways swipe pages, not past either end, and the strip picks a table at once after it
  const swipe = async (dx) => {
    await touch("touchStart", [[195, 500]]);
    for (let i = 1; i <= 6; i++) await touch("touchMove", [[195 + (dx * i) / 6, 500 + i]]);
    await touch("touchEnd");
  };
  await swipe(-150);
  await eventually(async () => (await shown()) === "Variables", "a swipe to the left to show the variables");
  await swipe(150);
  await eventually(async () => (await shown()) === "Imports", "a swipe to the right to show the imports again");
  await swipe(150);
  check((await shown()) === "Imports", "a swipe went past the first table");
  await chip("Records").tap();
  await eventually(async () => (await on(".detail-head .hero:visible").textContent()) === "Records", "the strip to show the records");

  // a tapped row raises the sheet and shows there
  await chip("Variables").tap();
  await on("table.grid tr.row").filter({ hasText: "phoneCount" }).tap();
  await eventually(async () => (await sheet.boundingBox()).height > 300, "a tapped row to raise the sheet");
  await sheet.locator(".head-title", { hasText: "phoneCount" }).waitFor();
  check(await inSight(on("table.grid tr.row.selected")), "the tapped row is under the sheet");
  await toggle.last().tap();
  await settled(sheet, "the sheet to lower");

  // an imported entity picked from the drawer shows its table, its row in sight above the risen sheet
  await chip("Theme").tap();
  await toggle.first().tap();
  await drawer.locator(".filter input").fill(last.entity);
  await drawer.locator(`.list-row[title="${last.entity}"]`).tap();
  await eventually(async () => !(await drawer.isVisible()), "the drawer to go once an entity is picked");
  await eventually(async () => (await shown()) === "Imports", "the picked import to show its table");
  await sheet.locator(".head-title", { hasText: last.alias }).waitFor();
  check((await sheet.boundingBox()).height > 300, "the picked entity left the sheet down");
  check(await inSight(on("table.grid tr.row.selected")), "the picked import's row is under the sheet");
  check((await on("table.grid tr.row.selected td.name").textContent()).includes(last.alias), "another row than the picked import's is selected");

  // another tab lowers the sheet, and a handler picked from Logic's drawer puts it away and opens
  await screen.locator(".tab", { hasText: "Logic" }).tap();
  await eventually(async () => (await sheet.boundingBox()).height < 40, "another tab to lower the sheet");
  await toggle.first().tap();
  await drawer.locator(".list-row", { hasText: "Phone rule" }).tap();
  await eventually(async () => !(await drawer.isVisible()), "the drawer to go once a handler is picked");
  await eventually(async () => (await on(".detail .hero-name").inputValue()) === "Phone rule", "the picked handler to open");
  await phone.close();
  await hmi.setRule(hmi.state.rules.find((r) => r.name === "Phone rule").id, null);
}
