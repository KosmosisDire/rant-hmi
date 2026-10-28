// A designer finds every page folded in the layers, each a band over its own layers. A band's
// caret shows what its page holds and a frame's caret what the frame holds, and the browser
// keeps the folds over a reload. Picking a part on the page opens its band and the frames around
// it, and a frame folded after stays folded. A row marks what repeats and what handles an event.

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Layer folds");
  const outer = await hmi.addElement(pageId, "div", { name: "Outer", x: "10", y: "10", w: "60", h: "40", background: "#2a2f35" });
  const inner = await hmi.addElement(pageId, "div", { name: "Inner", x: "10", y: "10", w: "40", h: "20", background: "#3a3f45" }, outer);
  const leaf = await hmi.addElement(pageId, "div", { name: "Leaf", x: "5", y: "5", w: "10", h: "10", background: "#ff4444" }, inner);
  const other = await hmi.addElement(pageId, "div", { name: "Other", x: "80", y: "10", w: "20", h: "20", background: "#2a2f35" });
  const each = await hmi.addElement(pageId, "div", { name: "Each", x: "80 + index * 12", y: "40", w: "10", h: "10", repeat: "2", background: "#2a2f35" });
  await hmi.setHandler(pageId, other, "tap", 'log("tapped");');
  await d.openPage("Layer folds");
  const left = page.locator(".screen:not([hidden]) .sidebar.left");
  const group = left.locator(".page-group.open");
  const band = group.locator(".page-row");
  const row = (id) => group.locator(`.list-row[data-id="${id}"]`);
  const caret = (id) => row(id).locator(".open-caret");
  const rows = () => group.locator(".layer-list .list-label").allTextContents();

  // the open page's band is the selected row, and it starts folded as every page does
  check((await band.getAttribute("class")).includes("selected"), "the open page's band is not selected");
  check((await left.locator(".page-group .layer-list").count()) === 0, "a page's layers show before its band is opened");
  check((await band.locator(".mark").count()) === 0, "the band is marked though its page keeps nothing");
  await band.locator(".open-caret").click();
  await eventually(async () => (await rows()).join() === "Each,Other,Outer", async () => `the band to open its top layers, they show ${(await rows()).join()}`);
  const tall = (await row(outer).boundingBox()).height;
  check(tall <= 26, `a layer row is ${tall} px tall`);
  check((await row(each).locator('.mark[title="Repeats over 2"]').textContent()) === "2", "Each is not marked as repeating over 2");
  check((await row(other).locator('.mark[title="On tap"]').count()) === 1, "Other is not marked as handling tap");
  check((await row(outer).locator(".mark").count()) === 0, "Outer is marked though it neither repeats nor handles");

  // a frame's caret shows what it holds and picks nothing
  await caret(outer).click();
  await eventually(async () => (await rows()).join() === "Each,Other,Outer,Inner", "Outer to open");
  check((await left.locator(".list-row.selected[data-id]").count()) === 0, "opening Outer picked it");
  check((await caret(outer).getAttribute("title")) === "Hide what it holds", "the open caret does not offer to hide");

  await page.reload();
  await page.locator(".statusbar", { hasText: "System" }).waitFor();
  await d.openPage("Layer folds");
  await row(inner).waitFor();
  check((await rows()).join() === "Each,Other,Outer,Inner", `a reload changed the folds, the layers show ${(await rows()).join()}`);

  // folded again, a pick on the page opens its band and each frame around it
  await band.locator(".open-caret").click();
  await eventually(async () => (await rows()).length === 0, "the band to fold");
  await d.pick(leaf);
  await eventually(async () => (await rows()).join() === "Each,Other,Outer,Inner,Leaf", async () => `the frames around Leaf to open, the layers show ${(await rows()).join()}`);
  check((await row(leaf).getAttribute("class")).includes("selected"), "Leaf's row is not the one selected");
  check(!(await band.getAttribute("class")).includes("selected"), "the band stays selected with Leaf picked");
  // folded again while Leaf stays picked, Outer keeps it hidden
  await caret(inner).click();
  await eventually(async () => (await rows()).join() === "Each,Other,Outer,Inner", "Inner to fold");
  await caret(outer).click();
  await caret(outer).click();
  check((await rows()).join() === "Each,Other,Outer,Inner", `Inner opened again by itself, the layers show ${(await rows()).join()}`);
  await caret(inner).click();
  await row(leaf).waitFor();
}
