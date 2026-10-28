// A designer sees every page side by side on one board, each named above it. The wheel zooms
// about the pointer, a drag on empty space, with Space held or with the middle button pans,
// Fit and Shift 1 show every page, and a page's band in the layers flies to it. A press on
// another page opens it there, picking what it pressed. The percent shows the true size, and
// ? lists the keys.

export default async function ({ page, hmi, d, check, eventually }) {
  const one = await hmi.addPage("Board one");
  const two = await hmi.addPage("Board two");
  const left = await hmi.addElement(one, "div", { name: "Left box", x: "10", y: "10", w: "30", h: "20", background: "#3a6ea5" });
  const right = await hmi.addElement(two, "div", { name: "Right box", x: "20", y: "20", w: "30", h: "20", background: "#a53a6e" });
  await d.openPage("Board one");
  const board = page.locator(".screen:not([hidden]) .artboard");
  const sheet = (id) => board.locator(`.page-layer[data-page="${id}"] > .page`);
  const zoom = () => board.locator(".zoom .mono").textContent();
  const host = await board.boundingBox();
  const inside = (b) => b.x >= host.x + 31 && b.y >= host.y + 31 && b.x + b.width <= host.x + host.width - 31 && b.y + b.height <= host.y + host.height - 31;
  const near = (a, b, what) => check(Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.width - b.width) < 1, `${what}: ${JSON.stringify(a)} against ${JSON.stringify(b)}`);

  // its band flew to Board one, whole in view, and Board two waits to its right, named
  const fitted = await sheet(one).boundingBox();
  check(inside(fitted), `Board one is not fitted: ${JSON.stringify(fitted)} in ${JSON.stringify(host)}`);
  const beside = await sheet(two).boundingBox();
  check(beside.x > fitted.x + fitted.width && Math.abs(beside.y - fitted.y) < 1, "Board two is not beside Board one");
  check((await board.locator(".board-label.open").textContent()).includes("Board one"), "the open page's label is not Board one's");
  check((await board.locator(".board-label", { hasText: "Board two" }).count()) === 1, "Board two has no label");
  // only the pages in sight are drawn
  const drawn = await board.locator(".page-layer").count();
  check(drawn <= 3 || drawn === hmi.state.pages.filter((p) => !p.interface).length, `${drawn} pages are drawn though most are out of sight`);

  // the wheel zooms about the pointer, so the spot under it stays put
  const [cx, cy] = [host.x + host.width / 2, host.y + host.height / 2];
  const before = await sheet(one).boundingBox();
  const [px, py] = [before.x + before.width * 0.3, before.y + before.height * 0.6];
  const start = await zoom();
  await page.mouse.move(px, py);
  await page.mouse.wheel(0, -300);
  await eventually(async () => (await zoom()) !== start, "the wheel to zoom");
  const after = await sheet(one).boundingBox();
  check(after.width > before.width, "the wheel up did not zoom in");
  const [u, v] = [(px - after.x) / after.width, (py - after.y) / after.height];
  check(Math.abs(u - 0.3) < 0.01 && Math.abs(v - 0.6) < 0.01, `the spot under the pointer moved to ${u.toFixed(3)}, ${v.toFixed(3)}`);

  await board.locator('button[title="Show at 100%"]').click();
  check((await zoom()) === "100%", "the percent did not show the page at its true size");
  const width = hmi.state.pages.find((p) => p.id === one).width * 10;
  check(Math.abs((await sheet(one).boundingBox()).width - width) < 1, "the page is not drawn at its true size");

  // Fit shows every page, and Shift 1 does after a zoom
  await board.locator('button[title^="Fit every page"]').click();
  await d.landed();
  check(inside(await sheet(one).boundingBox()) && inside(await sheet(two).boundingBox()), "Fit left a page out of view");
  const all = await sheet(two).boundingBox();
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -400);
  await page.keyboard.press("Shift+Digit1");
  await d.landed();
  near(await sheet(two).boundingBox(), all, "Shift 1 did not fit every page again");

  // a band in the layers flies to its page
  await d.pageRow("Board one").click();
  await d.landed();
  near(await sheet(one).boundingBox(), fitted, "Board one's band did not fly back to it");

  // a drag on the board's empty space pans, as Space held over an element does, which then
  // stays where it is
  const at = await sheet(one).boundingBox();
  await d.gesture(at.x + at.width / 2, at.y + at.height + 15, 80, -40);
  near(await sheet(one).boundingBox(), { ...at, x: at.x + 80, y: at.y - 40 }, "a drag on empty space did not pan");
  const held = await d.box(left);
  await page.keyboard.down("Space");
  await d.gesture(held.x + held.width / 2, held.y + held.height / 2, -50, 30);
  await page.keyboard.up("Space");
  near(await sheet(one).boundingBox(), { ...at, x: at.x + 30, y: at.y - 10 }, "a drag with Space held did not pan");
  check(hmi.page(one).children.find((e) => e.id === left).props.x === "10", "a drag with Space held moved the element");
  const mid = await sheet(one).boundingBox();
  await page.mouse.move(mid.x + 20, mid.y + 20);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(mid.x + 60, mid.y + 20, { steps: 4 });
  await page.mouse.up({ button: "middle" });
  near(await sheet(one).boundingBox(), { ...mid, x: mid.x + 40 }, "a drag with the middle button did not pan");

  // a press on Board two opens it in place and picks what it pressed, which a drag moves. The
  // board zooms out about Board one's left edge until Board two shows beside it.
  await d.pageRow("Board one").click();
  await d.landed();
  await page.mouse.move(fitted.x, cy);
  for (let n = 0; n < 3; n++) await page.mouse.wheel(0, 120);
  const stays = await sheet(two).boundingBox();
  check(stays.x + stays.width / 2 < host.x + host.width, "Board two did not come into view");
  const other = board.locator(`.page-layer[data-page="${two}"] .el[data-id="${right}"]`);
  await other.click();
  await eventually(async () => ((await page.locator(".screen:not([hidden]) .page-row.open .list-label").textContent()) ?? "") === "Board two", "the press to open Board two");
  await page.locator(`.screen:not([hidden]) .page-group.open .list-row.selected[data-id="${right}"]`).waitFor();
  near(await sheet(two).boundingBox(), stays, "opening Board two by a press moved the board");
  check((await board.locator(".board-label.open").textContent()).includes("Board two"), "Board two's label is not the open one");
  const was = await d.box(right);
  await d.gesture(was.x + was.width / 2, was.y + was.height / 2, 60, 0);
  await eventually(() => Number(hmi.page(two).children.find((e) => e.id === right).props.x) > 20, "the element on Board two to move");

  const keys = board.locator(".keys");
  await page.keyboard.press("Shift+Slash");
  await keys.waitFor();
  check((await keys.textContent()).includes("Shift 1"), "the keys list misses Shift 1");
  await page.keyboard.press("Escape");
  await keys.waitFor({ state: "detached" });
  await board.locator('button[title="Keys (?)"]').click();
  await keys.waitFor();
}
