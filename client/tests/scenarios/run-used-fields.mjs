// A screen tells the backend the fields its page reads of each import: in a text, through a
// component's input, through a repeat's item and as a scene's points. The backend then sends a
// screen each value with only the fields it said, and the page still shows what it read.

import { keepSent, told } from "../links.mjs";

/** The fields a value holds, a list by its first item and records by their columns. */
const shape = (v) => {
  if (v && typeof v === "object" && v.tag === 41000) return shape(v.value);
  if (v === null || typeof v !== "object" || ArrayBuffer.isView(v)) return true;
  if (Array.isArray(v)) return v.length ? shape(v[0]) : true;
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape(v[k])]));
};

export default async function ({ page, hmi, check, eventually, sys }) {
  await hmi.import("Line.Conveyor", "Line1/Conveyor");
  await hmi.import("Cell.Cam", "Cell/Camera");
  await hmi.import("Line.Labels", "Line1/LabelCam/Detections");
  await hmi.import("Cell.Scan", "Cell/Scan");
  const shows = await hmi.addComponent("ShowsSpeed");
  await hmi.edit({ kind: "set_input", page: shows, name: "source", input: { name: "source", default: "null", bindable: false } });
  await hmi.addElement(shows, "span", { name: "speed", x: "0", y: "0", w: "10", h: "4", text: "source.speed.toFixed(2)" });

  const id = await hmi.addPage("Used fields");
  const size = await hmi.addElement(id, "span", { name: "size", x: "2", y: "2", w: "20", h: "4", text: 'Cell.Cam.width + "x" + Cell.Cam.height' });
  const speed = await hmi.addElement(id, "use", { name: "Speed", x: "2", y: "8", w: "10", h: "4", source: "Line.Conveyor" }, null, "ShowsSpeed");
  const box = await hmi.addElement(id, "div", { name: "box", x: "item.min.x / 100", y: "14", w: "(item.max.x - item.min.x) / 100", h: "2", repeat: "Line.Labels.boxes", background: "#4a8fd6" });
  const scene = await hmi.addElement(id, "scene", { name: "cell", x: "30", y: "2", w: "30", h: "20" });
  await hmi.addElement(id, "points", { name: "cloud", points: "Cell.Scan.points" }, scene);

  const started = hmi.next((m) => m.type === "project");
  hmi.send({ type: "set_start", page: id });
  await started;
  const context = await page.context().browser().newContext();
  await context.addInitScript(keepSent);
  try {
    const p = await context.newPage();
    await p.goto(`${sys.url}/run`);
    const el = (eid) => p.locator(`.run-layer .el[data-id="${eid}"]`);
    const reads = ["Cell.Cam.height", "Cell.Cam.width", "Cell.Scan.points.[].x", "Cell.Scan.points.[].y", "Cell.Scan.points.[].z", "Line.Conveyor.speed.toFixed", "Line.Labels.boxes.[].max.x", "Line.Labels.boxes.[].min.x", "Line.Labels.boxes.length"];
    await eventually(async () => JSON.stringify(await told(p)) === JSON.stringify(reads), async () => `the page to read ${reads}, not ${await told(p)}`);
    // the page shows what it reads, from values that hold only that
    await eventually(async () => /^\d+x\d+$/.test(((await el(size).textContent()) ?? "").trim()), "the camera's size shown");
    await eventually(async () => /^\d+\.\d\d$/.test(((await el(speed).textContent()) ?? "").trim()), "the speed shown through the component");
    await eventually(async () => (await el(box).count()) >= 1, "a box for each label found");

    // each path starts with its member's key
    hmi.send({ type: "watch", reads: reads.map((r) => r.split(".")).map(([o, m, ...rest]) => [`${o}.${m}`, ...rest]) });
    const expect = {
      "Line.Conveyor": { speed: true },
      "Cell.Cam": { height: true, width: true },
      "Line.Labels": { boxes: { max: { x: true }, min: { x: true } } },
      "Cell.Scan": { points: { x: true, y: true, z: true } },
    };
    for (const [alias, fields] of Object.entries(expect)) {
      const got = () => JSON.stringify(shape(hmi.state.values[alias]?.value));
      await eventually(() => got() === JSON.stringify(fields), () => `${alias} to bring ${JSON.stringify(fields)}, not ${got()}`);
    }
    // told all again, it brings every field
    hmi.send({ type: "watch", reads: null });
    await eventually(() => "data" in (hmi.state.values["Cell.Cam"]?.value ?? {}), "the camera's picture to come again");
  } finally {
    await context.close();
  }
}
