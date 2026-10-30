import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// A designer shows a USD robot from the project's files in a scene, its layers composed as Isaac
// Sim writes them, and moves it by its joints: by name, by a JointState in the order the robot
// lists its moving joints, or in the order names give. A joint it lacks, a count that does not
// match, a file that is no USD and a layer it cannot find each say why.

// a base and one link holding a red block at x 1, joined by joint1 turning about z, the
// geometry a sublayer and the physics a reference
const FILES = {
  "arm.usda": `#usda 1.0
(
    defaultPrim = "arm"
    metersPerUnit = 1
    upAxis = "Z"
    subLayers = [@configuration/arm_base.usda@]
)
over "arm" (prepend references = @configuration/arm_physics.usda@</arm>)
{
}
`,
  "configuration/arm_base.usda": `#usda 1.0
(
    defaultPrim = "arm"
    metersPerUnit = 1
    upAxis = "Z"
)
def Xform "arm"
{
    def Xform "base"
    {
    }
    def Xform "link1"
    {
        def Cube "block"
        {
            double size = 0.5
            double3 xformOp:translate = (1, 0, 0)
            uniform token[] xformOpOrder = ["xformOp:translate"]
            color3f[] primvars:displayColor = [(1, 0, 0)]
        }
    }
}
`,
  "configuration/arm_physics.usda": `#usda 1.0
over "arm"
{
    over "base" (prepend apiSchemas = ["PhysicsRigidBodyAPI"])
    {
    }
    over "link1" (prepend apiSchemas = ["PhysicsRigidBodyAPI"])
    {
    }
    def PhysicsRevoluteJoint "joint1"
    {
        rel physics:body0 = </arm/base>
        rel physics:body1 = </arm/link1>
        uniform token physics:axis = "Z"
    }
}
`,
  // the arm with a gripper from a file that is not there
  "gripped.usda": `#usda 1.0
(
    metersPerUnit = 1
    upAxis = "Z"
    subLayers = [@arm.usda@]
)
over "arm"
{
    def Xform "gripper" (prepend references = @parts/gripper.usda@)
    {
    }
}
`,
  "broken.usda": "not a USD file",
};

export default async function ({ hmi, sys, d, eventually }) {
  for (const [name, text] of Object.entries(FILES)) {
    const file = join(sys.project, "files", "robot", name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  await d.addPage("Robot");
  // seen from above, x to the right
  const scene = await d.add("scene", { Name: "cell", x: "4", y: "4", w: "40", h: "30", Yaw: "-PI / 2", Pitch: "1.5", Distance: "6" });
  await d.addPart("model", { Source: '"files/robot/arm.usda"' });
  // the block shines a little, as a USD surface is half rough
  const red = ([r, g, b]) => r > 120 && r > 2 * g && r > 2 * b;
  const right = (why) => d.shows(d.el(scene), 0.65, 0.5, red, why).then(() => d.shows(d.el(scene), 0.35, 0.5, (c) => !red(c), why));
  const left = (why) => d.shows(d.el(scene), 0.35, 0.5, red, why).then(() => d.shows(d.el(scene), 0.65, 0.5, (c) => !red(c), why));
  await right("the block right of the middle at rest");

  // a half turn of joint1 swings the block to the other side, a value driving it
  await d.setField("Joints", "{ joint1: Line.Speed * PI }");
  hmi.set("Line.Speed", 1);
  await left("the block left of the middle with joint1 turned half round");
  hmi.set("Line.Speed", 0);
  await right("the block back at rest with joint1 at 0");

  // a JointState's positions follow the robot's moving joints in its order
  await d.setField("Joints", "{ position: [Line.Speed * PI], velocity: [], effort: [] }");
  hmi.set("Line.Speed", 1);
  await left("the block turned by the JointState's first position");
  // and with names, the order they give
  await d.setField("Names", '{ name: ["joint1"] }');
  await d.setField("Joints", "[Line.Speed * PI]");
  hmi.set("Line.Speed", 0);
  await right("the block at rest with the named position 0");
  hmi.set("Line.Speed", 1);
  await left("the block turned by the named position");

  const says = (words) => eventually(async () => (await d.el(scene).getAttribute("title"))?.includes(words), `the scene to say ${words}`);
  await d.setField("Names", "[]");
  await d.setField("Joints", "[1, 2]");
  await says("Model: joints: 2 positions for 1 moving joint");
  await d.setField("Joints", "{ wrist: 1 }");
  await says("Model: joints: the model has no joint wrist");
  await d.setField("Joints", "{ joint1: { position: vec(0, 0, 1) } }");
  await says("Model: joints: joint1 takes a number, as it turns");
  await d.setField("Joints", "{}");

  await d.setField("Source", '"files/robot/broken.usda"');
  await says("Model: src: files/robot/broken.usda cannot be loaded: could not read it as USD");

  // a layer it cannot find leaves that part out and warns, and the rest still shows
  await d.setField("Source", '"files/robot/gripped.usda"');
  await right("the arm drawn without the gripper it cannot find");
  const warned = async () => (await (await fetch(`${sys.url}/problems`)).json()).some((p) => p.level === "warn" && p.text.includes("Model: src:") && p.text.includes("parts/gripper.usda"));
  await eventually(warned, "the missing gripper to be a warning");
}
