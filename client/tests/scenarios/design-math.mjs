// A designer does math on the robot's pose in a page, the list offering it: the standard functions
// by their plain names, Rant Math's operators and the methods of each standard type with what they
// take, text joined with a vector, a clear word on a 2D plus a 3D vector, and code that does not parse.

export default async function ({ page, hmi, d, check, eventually }) {
  if (!hmi.state.imports.some((i) => i.alias === "Robot.EndPose")) await hmi.import("Robot.EndPose", "Robot/Pose");
  const pageId = await hmi.addPage("Pose math");
  const shows = {
    // the demo's robot circles at 0.4 m, 0.3 m up, so it is always 0.5 m from the origin
    reach: "Robot.EndPose.position.length().toFixed(2)",
    doubled: "(Robot.EndPose.position * 2).length().toFixed(2)",
    apart: "(Robot.EndPose.position - vec(0, 0, 0.3)).length().toFixed(2)",
    turned: "(Robot.EndPose.orientation * vec(1, 0, 0)).isNear(vec(1, 0, 0), 1e-9)",
    placed: "(Robot.EndPose * vec(0, 0, 1)).z.toFixed(2)",
    yaw: 'degrees(math.quaternionFromEuler(0, 0, PI / 2, "FixedXyz").toEuler("FixedXyz")[2]).toFixed(0)',
    fitted: "Cylinder({ axis: { a: vec(0, 0, 0), b: vec(0, 0, 2) }, radius: 1 }).volume().toFixed(2)",
    made: 'Double3({ x: 3, y: 4, z: 0 }).length() + ({ x: 1, y: 0 }).dot(vec(2, 5))',
    plain: "sqrt(16) + clamp(5, 0, 3) + lerp(0, 10, 0.25) + floor(2.7) + max(1, 4)",
    words: '"at " + vec(1, 2)',
    crossed: "vec(1, 0, 0).cross(vec(0, 1, 0)).z",
    lerped: "lerp(vec(0, 0, 0), vec(2, 4, 6), 0.5).z",
    cells: "Int2({ x: 3, y: 4 }).length()",
  };
  const ids = {};
  let y = 11;
  for (const [name, text] of Object.entries(shows)) {
    ids[name] = await hmi.addElement(pageId, "span", { name, x: "11", y: String(y), w: "440", h: "33", text });
    y += 44;
  }
  const wrong = await hmi.addElement(pageId, "span", { name: "wrong", x: "11", y: String(y), w: "440", h: "33", text: "vec(1, 2) + vec(1, 2, 3)" });
  await d.openPage("Pose math");
  const want = { reach: "0.50", doubled: "1.00", apart: "0.40", turned: "true", placed: "1.30", yaw: "90", fitted: "6.28", made: "7", plain: "15.5", words: "at (1, 2)", crossed: "1", lerped: "3", cells: "5" };
  for (const [name, text] of Object.entries(want)) {
    let seen = "";
    await eventually(async () => (seen = await d.el(ids[name]).textContent()) === text, () => `${name} to show ${text}, not ${seen}`);
  }

  await d.el(wrong).click();
  // the list offers the math names, and a vector's methods after its dot
  const names = () => page.locator(".suggest .suggest-name").allTextContents();
  const text = d.field("Text");
  await text.click();
  await text.fill("");
  await page.keyboard.type("sq");
  await eventually(async () => (await names()).includes("sqrt"), "sqrt in the list");
  await text.fill("");
  await page.keyboard.type("Robot.EndPose.position.");
  await eventually(async () => (await names()).join().startsWith("x,y,z,add,subtract"), "a vector's fields and then its methods");
  // a method says what it does in Rant Math's words, and one taking only the value shows its answer once chosen
  await page.keyboard.type("lengt");
  await page.keyboard.press("ArrowDown");
  const row = page.locator(".suggest .suggest-row").filter({ has: page.locator(".suggest-name", { hasText: /^length$/ }) });
  let seen = "";
  await eventually(async () => Math.abs(Number((seen = await row.locator(".suggest-value").textContent())) - 0.5) < 0.01, () => `length to show 0.5, not ${seen}`);
  check((await row.locator(".suggest-type").textContent()).length > 0, "length has no words");
  // inside a method's or a math call's brackets the hint names what it takes, the value left out
  const hint = page.locator(".signature");
  const hints = async (code, want) => {
    await text.fill("");
    await page.keyboard.type(code);
    let head = "";
    await eventually(async () => (await hint.count()) === 1 && (head = (await hint.locator("div").first().textContent()).replace(/: [^,)]+/g, "")) === want, () => `${code} to hint ${want}, not ${head}`);
  };
  await hints("Robot.EndPose.position.distance(", "Robot.EndPose.position.distance(b)");
  await hints("Robot.EndPose.orientation.toEuler(", "Robot.EndPose.orientation.toEuler(order)");
  await hints("math.poseInverse(", "math.poseInverse(p)");
  await hints("$accent.mix(", "$accent.mix(other, t?)");
  await page.keyboard.press("Escape");
  const note = page.locator(".screen:not([hidden]) .sidebar.right .field-note");
  await eventually(async () => (await note.textContent())?.includes("a Double2 and a Double3 cannot be added"), "the sum of a 2D and a 3D vector to say why it fails");
  await d.setField("Text", "Line.Speed +");
  let said = "";
  await eventually(async () => (said = (await note.allTextContents()).join(" | ")).startsWith("Unexpected token"), () => `code that does not parse to say so, not ${said}`);
  check(!/\(\d+:\d+\)/.test(await note.textContent()), `the note gives the wrapper's position: ${await note.textContent()}`);
}
