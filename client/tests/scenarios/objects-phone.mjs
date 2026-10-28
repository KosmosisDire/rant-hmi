// The Objects tab on a phone. An object picked from the drawer opens its sheet and puts the
// drawer away. A member tapped raises the inspector sheet with it, its row in sight above, and
// a member picked from the drawer's mesh tree opens its object with it the same way. Another tab
// lowers the sheet, and a rule tapped shows there too. Nothing runs off the side.

export default async function ({ page, hmi, sys, check, eventually }) {
  // enough state before it that its row sits where the risen sheet would cover it
  const before = Array.from({ length: 12 }, (_, n) => `Hmi.phoneFill${n}`);
  for (const k of before) hmi.setVariable(k, 0);
  hmi.setVariable("Hmi.phoneCount", 0);
  await hmi.setRule("Hmi", "", { id: "", name: "Phone rule", when: { kind: "every", ms: 1000 }, code: "" });

  const phone = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const screen = await phone.newPage();
  await screen.goto(sys.url);
  await screen.locator(".statusbar", { hasText: "System" }).waitFor();
  await screen.locator(".tab", { hasText: "Objects" }).tap();
  const on = (selector) => screen.locator(`.screen:not([hidden]) ${selector}`);
  const [drawer, sheet, toggle] = [on(".sidebar.left"), on(".sheet.dock"), screen.locator(".topbar .bar-btn")];
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
    const [r, top, s] = [await settled(row, "the row to come to rest"), await on(".objects-detail").boundingBox(), await settled(sheet, "the sheet to rest")];
    return r.y >= top.y && r.y + r.height <= s.y + 1;
  };
  const object = async (name) => {
    await toggle.first().tap();
    await drawer.locator(`.list-row[data-object="${name}"]`).tap();
    await eventually(async () => !(await drawer.isVisible()), "the drawer to go once an object is picked");
    await on(".object-sheet .hero", { hasText: new RegExp(`^${name}$`) }).waitFor();
  };

  await object("Hmi");
  check((await on(".objects-detail").evaluate((e) => e.scrollWidth - e.clientWidth)) === 0, "the sheet runs off the side");
  await on('.object-sheet [data-member="phoneCount"]').tap();
  await eventually(async () => (await sheet.boundingBox()).height > 300, "a tapped member to raise the sheet");
  await sheet.locator(".head-title", { hasText: "Hmi.phoneCount" }).waitFor();
  check(await inSight(on(".object-sheet .member-row.selected")), "the tapped member is under the sheet");
  await toggle.last().tap();
  await settled(sheet, "the sheet to lower");

  // a member picked from the drawer's mesh tree opens its object, its row in sight above the risen sheet
  await toggle.first().tap();
  await drawer.locator(".filter input").fill("Line1/Speed");
  await drawer.locator('.list-row[title="Line1/Speed"]').tap();
  await eventually(async () => !(await drawer.isVisible()), "the drawer to go once a member is picked");
  await on(".object-sheet .hero", { hasText: /^Line$/ }).waitFor();
  await sheet.locator(".head-title", { hasText: "Line.Speed" }).waitFor();
  check((await sheet.boundingBox()).height > 300, "the picked member left the sheet down");
  check(await inSight(on(".object-sheet .member-row.selected")), "the picked member's row is under the sheet");
  check((await on(".object-sheet .member-row.selected").getAttribute("data-member")) === "Speed", "another row than the picked member's is selected");

  // another tab lowers the sheet, and a rule tapped shows in it
  await screen.locator(".tab", { hasText: "Design" }).tap();
  await eventually(async () => (await sheet.boundingBox()).height < 40, "another tab to lower the sheet");
  await screen.locator(".tab", { hasText: "Objects" }).tap();
  await object("Hmi");
  await on('.object-sheet [data-rule="Phone rule"]').tap();
  await eventually(async () => (await sheet.boundingBox()).height > 300, "a tapped rule to raise the sheet");
  await sheet.locator(".head-title", { hasText: "Phone rule" }).waitFor();
  await phone.close();
  await hmi.setRule("Hmi", hmi.state.rules.find((r) => r.name === "Phone rule").id, null);
  for (const k of before) hmi.setVariable(k);
}
