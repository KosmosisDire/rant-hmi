// A designer folds a frame in the layers by its caret: what it holds goes from the list, the
// pick stays, and the browser keeps the fold over a reload. Picking a part on the page opens
// the frames around it, and a frame folded after stays folded.

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Layer folds");
  const outer = await hmi.addElement(pageId, "div", { name: "Outer", x: "10", y: "10", w: "60", h: "40", background: "#2a2f35" });
  const inner = await hmi.addElement(pageId, "div", { name: "Inner", x: "10", y: "10", w: "40", h: "20", background: "#3a3f45" }, outer);
  const leaf = await hmi.addElement(pageId, "div", { name: "Leaf", x: "5", y: "5", w: "10", h: "10", background: "#ff4444" }, inner);
  await hmi.addElement(pageId, "div", { name: "Other", x: "80", y: "10", w: "20", h: "20", background: "#2a2f35" });
  await d.openPage("Layer folds");
  const left = page.locator(".screen:not([hidden]) .sidebar.left");
  const row = (id) => left.locator(`.layers .list-row[data-id="${id}"]`);
  const caret = (id) => row(id).locator(".open-caret");
  const rows = () => left.locator(".layers .list-label").allTextContents();
  await row(leaf).waitFor();
  check((await rows()).join() === "Other,Outer,Inner,Leaf", `the layers show ${(await rows()).join()}`);
  const tall = (await row(outer).boundingBox()).height;
  check(tall <= 26, `a layer row is ${tall} px tall`);

  // the caret folds what Outer holds and picks nothing
  await d.pick(outer);
  await caret(outer).click();
  await eventually(async () => (await rows()).join() === "Other,Outer", async () => `Outer to fold, the layers show ${(await rows()).join()}`);
  check((await row(outer).getAttribute("class")).includes("selected"), "folding Outer let it go");
  check((await caret(outer).getAttribute("title")) === "Show what it holds", "the folded caret does not offer to show");

  await page.reload();
  await page.locator(".statusbar", { hasText: "System" }).waitFor();
  await d.openPage("Layer folds");
  await row(outer).waitFor();
  check((await rows()).join() === "Other,Outer", `a reload unfolded Outer, the layers show ${(await rows()).join()}`);

  // a pick on the page opens each frame around it
  await d.pick(leaf);
  await eventually(async () => (await rows()).join() === "Other,Outer,Inner,Leaf", async () => `the frames around Leaf to open, the layers show ${(await rows()).join()}`);
  check((await row(leaf).getAttribute("class")).includes("selected"), "Leaf's row is not the one selected");
  // folded again while Leaf stays picked, Outer keeps it hidden
  await caret(inner).click();
  await eventually(async () => (await rows()).join() === "Other,Outer,Inner", "Inner to fold");
  await caret(outer).click();
  await caret(outer).click();
  check((await rows()).join() === "Other,Outer,Inner", `Inner opened again by itself, the layers show ${(await rows()).join()}`);
  await caret(inner).click();
  await row(leaf).waitFor();
}
