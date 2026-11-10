// Values of Rant's standard types name their type under Symbol.for("rant.type"): one from the mesh
// down every field, one made by its type's name, and one a component's typed input takes. A
// maker given too little says what it needs, and a name the browser has stays the browser's.

export default async function ({ hmi, d, eventually }) {
  if (!hmi.state.imports.some((i) => i.alias === "Robot.Pose")) await hmi.import("Robot.Pose", "Robot/Pose");
  const T = 'Symbol.for("rant.type")';
  const point = await hmi.addComponent("Point");
  hmi.send({ type: "edit", edit: { kind: "set_input", page: point, name: "at", input: { name: "at", default: "vec(0, 0, 0)", bindable: false, type: "Double3" } } });
  await eventually(() => hmi.page(point)?.interface?.inputs.length === 1, "the input");
  await hmi.addElement(point, "span", { name: "type", x: "0", y: "0", w: "100%", h: "100%", text: `at[${T}]` });

  const pageId = await hmi.addPage("Types");
  const text = (name, y, source) => hmi.addElement(pageId, "span", { name, x: "4", y: String(y), w: "60", h: "4", text: source });
  const mesh = await text("Mesh", 4, `Robot.Pose[${T}] + " " + Robot.Pose.position[${T}] + " " + Robot.Pose.orientation[${T}]`);
  const made = await text("Made", 10, `Pose({ position: vec(1, 2, 3), orientation: { x: 0, y: 0, z: 0, w: 1 } }).orientation[${T}]`);
  const short = await text("Short", 16, "(() => { try { return Pose({ position: vec(1, 2, 3) }); } catch (e) { return e.message; } })()");
  const browser = await text("Browser", 28, "new Path2D() instanceof Path2D");
  const given = await hmi.addElement(pageId, "use", { name: "Given", x: "4", y: "22", w: "60", h: "4", at: "{ x: 1, y: 2, z: 3 }" }, null, "Point");
  await d.openPage("Types");
  const shows = (id, want) => eventually(async () => (await d.el(id).textContent()).trim() === want, async () => `${want}, not ${await d.el(id).textContent()}`);
  await shows(mesh, "Pose Double3 Quaternion");
  await shows(made, "Quaternion");
  await shows(short, "Pose needs orientation");
  await shows(given, "Double3");
  await shows(browser, "true");
}
