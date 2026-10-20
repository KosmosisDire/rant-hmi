// A designer does math on the robot's pose in a page: the standard functions by their plain
// names, arithmetic between vectors and with numbers, vector, quaternion and pose methods, text
// joined with a vector, a clear word on a 2D plus a 3D vector, and where code does not parse.

export default async function ({ page, hmi, d, check, eventually }) {
  if (!hmi.state.imports.some((i) => i.alias === "Pose")) await hmi.import("Pose", "Robot/Pose");
  const pageId = await hmi.addPage("Pose math");
  const shows = {
    // the demo's robot circles at 0.4 m, 0.3 m up, so it is always 0.5 m from the origin
    reach: "Pose.position.length().toFixed(2)",
    doubled: "(Pose.position * 2).length().toFixed(2)",
    apart: "(Pose.position - vec(0, 0, 0.3)).length().toFixed(2)",
    turned: "(Pose.orientation * vec(1, 0, 0)).equals(vec(1, 0, 0))",
    placed: "(Pose * vec(0, 0, 1)).z.toFixed(2)",
    yaw: "degrees(fromEuler(0, 0, PI / 2).euler().yaw).toFixed(0)",
    plain: "sqrt(16) + clamp(5, 0, 3) + lerp(0, 10, 0.25) + floor(2.7) + max(1, 4)",
    words: '"at " + vec(1, 2)',
    crossed: "vec(1, 0, 0).cross(vec(0, 1, 0)).z",
  };
  const ids = {};
  let y = 11;
  for (const [name, text] of Object.entries(shows)) {
    ids[name] = await hmi.addElement(pageId, "span", { name, x: "11", y: String(y), w: "440", h: "33", text });
    y += 44;
  }
  const wrong = await hmi.addElement(pageId, "span", { name: "wrong", x: "11", y: String(y), w: "440", h: "33", text: "vec(1, 2) + vec(1, 2, 3)" });
  await d.openPage("Pose math");
  const want = { reach: "0.50", doubled: "1.00", apart: "0.40", turned: "true", placed: "1.30", yaw: "90", plain: "15.5", words: "at (1, 2)", crossed: "1" };
  for (const [name, text] of Object.entries(want)) {
    let seen = "";
    await eventually(async () => (seen = await d.el(ids[name]).textContent()) === text, () => `${name} to show ${text}, not ${seen}`);
  }

  await d.el(wrong).click();
  const note = page.locator(".screen:not([hidden]) .sidebar.right .field-note");
  await eventually(async () => (await note.textContent())?.includes("a 2D vector and a 3D vector cannot be added"), "the sum of a 2D and a 3D vector to say why it fails");
  await d.setField("Text", "Speed +");
  await eventually(async () => /^Unexpected token\b/.test((await note.textContent()) ?? ""), "code that does not parse to say so");
  check(!/\(\d+:\d+\)/.test(await note.textContent()), `the note gives the wrapper's position: ${await note.textContent()}`);
}
