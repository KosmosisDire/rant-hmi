import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A designer shows a glTF model from the project's files in a scene, stood z up as its y up file
// means, and turns one of its named nodes by joints. A node it lacks or a file that cannot load
// says why on the scene.

// a file holding a red square on its floor, from x 0.5 to 1.5, in the node Arm
function square() {
  const bytes = new Uint8Array(60);
  const view = new DataView(bytes.buffer);
  [0.5, 0, -0.5, 1.5, 0, -0.5, 1.5, 0, 0.5, 0.5, 0, 0.5].forEach((v, i) => view.setFloat32(i * 4, v, true));
  [0, 1, 2, 0, 2, 3].forEach((v, i) => view.setUint16(48 + i * 2, v, true));
  const gltf = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: "Base", children: [1] }, { name: "Arm", mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1], metallicFactor: 0 }, doubleSided: true }],
    buffers: [{ byteLength: 60, uri: `data:application/octet-stream;base64,${Buffer.from(bytes).toString("base64")}` }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 48 },
      { buffer: 0, byteOffset: 48, byteLength: 12 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: "VEC3", min: [0.5, 0, -0.5], max: [1.5, 0, 0.5] },
      { bufferView: 1, componentType: 5123, count: 6, type: "SCALAR" },
    ],
  };
  return JSON.stringify(gltf);
}

export default async function ({ hmi, sys, d, eventually }) {
  mkdirSync(join(sys.project, "files", "cell"), { recursive: true });
  writeFileSync(join(sys.project, "files", "cell", "square.gltf"), square());
  await d.addPage("Model");
  // seen from above, x to the right
  const scene = await d.add("scene", { Name: "cell", x: "4", y: "4", w: "40", h: "30", Yaw: "-PI / 2", Pitch: "1.5", Distance: "6" });
  await d.addPart("model", { Source: '"files/cell/square.gltf"' });
  const red = ([r, g, b]) => r > 120 && g < 60 && b < 60;
  await d.shows(d.el(scene), 0.65, 0.5, red, "the square right of the middle, lying on the floor");
  await d.shows(d.el(scene), 0.35, 0.5, (c) => !red(c), "nothing left of the middle");

  // a half turn of Arm about its own z swings the square to the other side, a value driving it
  await d.setField("Joints", "{ Arm: Speed * PI }");
  hmi.set("Speed", 1);
  await d.shows(d.el(scene), 0.35, 0.5, red, "the square left of the middle with Arm turned half round");
  await d.shows(d.el(scene), 0.65, 0.5, (c) => !red(c), "nothing right of the middle with Arm turned");

  const says = (words) => eventually(async () => (await d.el(scene).getAttribute("title"))?.includes(words), `the scene to say ${words}`);
  await d.setField("Joints", "{ Wrist: 1 }");
  await says("Model: joints: the model has no node Wrist");
  await d.setField("Source", '"files/missing.glb"');
  await says("Model: src: files/missing.glb cannot be loaded");
  // the project's own files are not the page's to load
  await d.setField("Source", '"files/../hmi.toml"');
  await says("Model: src: files/../hmi.toml cannot be loaded");
}
