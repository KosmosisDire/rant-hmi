// A designer picks something inside a frame or a drawing and sees the bounds of what holds
// it, faintly, so placing inside it is easy. Picking the holder itself shows only its ring.

export default async function ({ page, d, check }) {
  await d.addPage("Holders");
  const card = await d.add("frame", { Name: "card", x: "44", y: "44", w: "352", h: "220" });
  await d.add("frame", { Name: "badge", x: "22", y: "22", w: "88", h: "44" });
  const outline = page.locator(".screen:not([hidden]) .ring.parent");
  const near = async (id) => {
    const [a, b] = [await outline.boundingBox(), await page.locator(`.screen:not([hidden]) .page-layer [data-id="${id}"]`).boundingBox()];
    return Math.abs(a.x - b.x) <= 1.5 && Math.abs(a.y - b.y) <= 1.5 && Math.abs(a.width - b.width) <= 1.5 && Math.abs(a.height - b.height) <= 1.5;
  };
  check((await outline.count()) === 1 && (await near(card)), "the card's bounds do not show around the badge");
  await d.select("card");
  check((await outline.count()) === 0, "the card outlines itself as its own holder");

  await d.deselect();
  const dial = await d.add("drawing", { Name: "dial", x: "440", y: "44", w: "176", h: "176" });
  await d.addShape("circle", { Name: "face", "Centre x": "88", "Centre y": "88", Radius: "40" });
  check((await outline.count()) === 1 && (await near(dial)), "the drawing's bounds do not show around its shape");
}
