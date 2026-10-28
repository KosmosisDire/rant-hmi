// A designer rebuilds the first HMI made for the cage cell, in the editor alone, from the
// standard components and two of its own, a conveyor and a pusher. Its robot runs a job held
// to confirm, halts, homes and jogs while JOG is held with a second finger, its conveyor carries
// a box on a moving belt and pushes, its alarm blinks, and its safety stops, resets and slows
// the cell. It starts from a new project, which has the standard components, and with
// `--into <folder>` leaves the project there.

export const fresh = true;

/** The chirp the safety relay gives as a command lands. */
const CHIRP = "SafetyCmd.chirp = true;\nawait sleep(100);\nSafetyCmd.chirp = false;";

export default async function ({ page, hmi, d, sys, check, eventually }) {
  // the cell's data, as the Data screen imports it
  const imports = [
    ["ConveyorGo", "Cage/Plc/IO/conveyorGo", "write"],
    ["LoopGo", "Cage/Plc/IO/conveyorLoopGo", "write"],
    ["LoopStop", "Cage/Plc/IO/conveyorLoopStop", "write"],
    ["DistanceA", "Cage/Plc/IO/distanceSensorA", "read"],
    ["DistanceD", "Cage/Plc/IO/distanceSensorD", "read"],
    ["PusherOut", "Cage/Plc/IO/pusherA", "read"],
    ["Vacuum", "Cage/Plc/IO/vacSense", "read"],
    ["Suction", "Cage/Plc/IO/gripperSuction", "write"],
    ["PusherExtend", "Cage/Plc/Pusher1/extend", "write"],
    ["SafetyCmd", "Cage/Plc/gSafetyCmd", "write"],
    ["SafetyStatus", "Cage/Plc/gSafetyStatus", "read"],
    ["Robot", "Cage/Gp12/RobotState", "read"],
    ["JointState", "Cage/Gp12/JointState", "read"],
    ["JogJoint", "Cage/Gp12/Jog/Joint", "write"],
    ["JogCartesian", "Cage/Gp12/Jog/Cartesian", "write"],
    ["SetServo", "Cage/Gp12/SetServo", "write"],
    ["SetHold", "Cage/Gp12/SetHold", "write"],
    ["ResetAlarm", "Cage/Gp12/ResetAlarm", "write"],
    ["RunJob", "Cage/Gp12/RunJob", "write"],
  ];
  for (const [alias, entity, intent] of imports) await hmi.import(alias, entity, intent);
  const variables = [
    ["selectedJob", "Home249", "hmi"],
    ["jogMode", "Joint", "screen"],
    ["jogSpeed", 1, "screen"],
    ["jogVel", [0, 0, 0, 0, 0, 0], "screen"],
    ["jogging", false, "screen"],
    ["servoPending", false, "screen"],
  ];
  for (const [name, start, per] of variables) hmi.send({ type: "set_variable", name, variable: { name, start, per } });
  hmi.send({ type: "set_record", name: "distanceHistory", record: { name: "distanceHistory", source: "DistanceD", every_ms: 50, keep_s: 10 } });
  await eventually(() => hmi.state.variables.some((v) => v.name === "servoPending") && hmi.state.records.some((r) => r.name === "distanceHistory"), "the variables and the record");

  // its conveyor: a belt between two rails, and the box on it placed by the two distance sensors
  await d.addComponent("Conveyor", 35, 15);
  await d.sizing("Fill");
  await d.addInput("leftPos", "0");
  await d.addInput("rightPos", "0");
  await d.addInput("length", "1000");
  await d.addInput("running", "false");
  await d.addInput("speed", "0.25");
  await d.addInput("beltColour", "$surface");
  await d.addInput("railColour", "$gray");
  await d.addInput("boxColour", "#5e4a35");
  await d.add("frame", { Name: "belt", x: "0", y: "10%", w: "100%", h: "80%", Fill: "beltColour", Radius: "", Overflow: '"hidden"' });
  // the slats move along at speed, a share of its length a second, while it runs
  await d.add("frame", { Name: "slat", Repeat: "21", x: "((index - 1) * 5 + (running ? (time.now / 10 * speed % 5 + 5) % 5 : 0))%", y: "0", w: "0.1", h: "100%", Fill: "$panel3", Radius: "" });
  for (const [name, y] of [["topRail", "0"], ["bottomRail", "90%"]]) {
    await d.deselect();
    await d.add("frame", { Name: name, x: "0", y, w: "100%", h: "10%", Fill: "railColour", Radius: "" });
    await d.css('box-shadow: "0 0 8px #000"');
  }
  await d.deselect();
  await d.add("frame", { Name: "box", Origin: '"0% 50%"', x: "(leftPos / length * 100)%", y: "50%", w: "((length - leftPos - rightPos) / length * 100)%", h: "70%", Fill: "boxColour", Radius: "$radius" });
  await d.css('box-shadow: "inset 8px 8px 16px #ffffff22"');

  // its pusher: a bar that sweeps from the bottom of its box to the top as it pushes
  await d.addComponent("Pusher", 13, 13);
  await d.sizing("Fill");
  await d.addInput("push", "0");
  await d.addInput("colour", "$red");
  await d.addInput("sweepMs", "300");
  await d.add("frame", { Name: "bar", Origin: '"0% 100%"', x: "0", y: "((1 - push) * 100)%", w: "100%", h: "0.5", Fill: "colour", Radius: "$radiusPill" });
  await d.css('box-shadow: "0 0 10px #000a"\ntransition: "top " + sweepMs + "ms ease-in-out"');

  // the page a new project starts on
  await d.openPage("Overview");
  const inside = async (holder, kind, fields) => {
    await d.select(holder);
    return kind === "frame" || kind === "text" ? d.add(kind, fields) : d.place(kind, fields);
  };
  const handlers = async (on) => {
    for (const [event, code, ms] of on) await d.handler(event, code, ms);
  };
  const panel = async (name, x, y, w, h) => {
    await d.deselect();
    await d.add("frame", { Name: name, x, y, w, h, Fill: "$panel", Radius: "$radiusLarge" });
    await page.locator('button[title="Edit the border"]').click();
    await d.set({ Width: "0.1", Colour: "$border" });
    await page.keyboard.press("Escape");
  };
  const title = (holder, text, w, h = "4") => inside(holder, "text", { Name: `${holder} title`, x: "0", y: "0", w, h, Text: `"${text}"`, Size: "2.2", Weight: "700", Align: '"center"', Vertical: '"center"' });
  const label = (holder, name, text, x, y, w, h) => inside(holder, "text", { Name: name, x, y, w, h, Text: text, Size: "1.6", Vertical: '"center"' });

  // the robot: how it jogs, the jog pad, the job, its state, and run, halt, servos, alarm, home
  await panel("Robot panel", "80", "1", "47", "49");
  await title("Robot panel", "Robot", "47");
  await label("Robot panel", "Mode label", '"Mode"', "1", "4", "4", "4");
  await inside("Robot panel", "Dropdown", { Name: "Jog mode", x: "5", y: "4", w: "16", h: "4", value: "jogMode", options: '["Joint", "Cartesian"]' });
  await label("Robot panel", "Speed label", '"Speed"', "23", "4", "6", "4");
  await inside("Robot panel", "Slider", { Name: "Jog speed", x: "29", y: "4", w: "13", h: "4", value: "jogSpeed", min: "1", max: "5", step: "1" });
  await label("Robot panel", "Speed value", "jogSpeed", "43", "4", "3", "4");
  // the pad answers only while JOG is held
  await inside("Robot panel", "frame", { Name: "Jog pad", x: "0", y: "8", w: "47", h: "24", Fill: "", Radius: "", Opacity: "jogging ? 1 : 0.4" });
  await d.css('pointer-events: jogging ? "auto" : "none"');
  const column = (at) => `${at} + (index < 3 ? 0 : 25)`;
  const row = "1 + (index % 3) * 8";
  const minus = await inside("Jog pad", "Button", { Name: "Minus", Repeat: "6", x: column(1), y: row, w: "6", h: "6", text: '"-"', textSize: "3" });
  await handlers([["press", "jogVel[index] = -1;"], ["release", "jogVel[index] = 0;"]]);
  await inside("Jog pad", "text", { Name: "Joint angle", Repeat: "6", x: column(7), y: row, w: "8", h: "6", Text: "degrees(JointState.position[index]).toFixed(1)", Size: "1.9", Align: '"center"', Vertical: '"center"' });
  const plus = await inside("Jog pad", "Button", { Name: "Plus", Repeat: "6", x: column(15), y: row, w: "6", h: "6", text: '"+"', textSize: "3" });
  await handlers([["press", "jogVel[index] = 1;"], ["release", "jogVel[index] = 0;"]]);
  await inside("Robot panel", "frame", { Name: "Divider", x: "1", y: "32", w: "45", h: "0.2", Fill: "$border", Radius: "" });
  await inside("Robot panel", "Dropdown", { Name: "Job", x: "1", y: "33", w: "17", h: "4", value: "selectedJob", options: 'JobName.options.filter((j) => j != "None")' });
  await inside("Robot panel", "frame", { Name: "State", x: "19", y: "33", w: "27", h: "4", Fill: "$panel3", Radius: "$radius" });
  await inside("State", "text", {
    Name: "State text",
    x: "0",
    y: "0",
    w: "100%",
    h: "100%",
    Text: 'Robot.start ? "Running " + Robot.cur_job_name + " at " + Robot.job_step : Robot.is_home ? "HOME IDLE" : "IDLE"',
    Size: "1.5",
    Align: '"center"',
    Vertical: '"center"',
  });
  // run and halt share a place, one shown at a time, each in a frame since an instance takes no CSS
  await inside("Robot panel", "frame", { Name: "Run holder", x: "1", y: "38", w: "18", h: "10", Fill: "", Radius: "" });
  await d.css('visibility: Robot.start ? "hidden" : "visible"');
  const run = await inside("Run holder", "Button", { Name: "Run", x: "0", y: "0", w: "100%", h: "100%", text: '"Run"', holdMs: "600", fill: "$green", radius: "$radiusPill" });
  await handlers([
    ["press", CHIRP],
    ["confirm", `await SetServo(true);\nawait RunJob({ job_name: selectedJob });\n${CHIRP}`],
  ]);
  await inside("Robot panel", "frame", { Name: "Halt holder", x: "1", y: "38", w: "18", h: "10", Fill: "", Radius: "" });
  await d.css('visibility: Robot.start ? "visible" : "hidden"');
  const halt = await inside("Halt holder", "Button", { Name: "Halt", x: "0", y: "0", w: "100%", h: "100%", text: '"Halt motion"', fill: "$amber", radius: "$radiusPill" });
  await handlers([["press", "await SetHold(true);\nawait SetHold(false);"]]);
  await label("Robot panel", "Servos label", '"Servos"', "20", "39", "6", "4");
  const servos = await inside("Robot panel", "Toggle", { Name: "Servos", x: "27", y: "39", w: "7", h: "4", value: "Robot.servo_power === true", colour: "$green", trackColour: "servoPending ? $amber : $panel3" });
  await handlers([["change", "await SetServo(p);\nif (p) {\n  servoPending = true;\n  await sleep(800);\n  servoPending = false;\n}"]]);
  await label("Robot panel", "Alarm label", '"Alarm"', "20", "43", "6", "5");
  const alarm = await inside("Robot panel", "Button", { Name: "Alarm", x: "27", y: "44", w: "7", h: "3", text: 'Robot.alarm ? String(Robot.alarm_no[0]) : "OK"', textSize: "1.4", fill: "Robot.alarm && floor(time.now / 500) % 2 ? $red : $panel3" });
  await handlers([["press", "await ResetAlarm(true, false);"]]);
  // home waits while a job runs
  await inside("Robot panel", "frame", { Name: "Home holder", x: "36", y: "38", w: "10", h: "10", Fill: "", Radius: "", Opacity: "Robot.start ? 0.4 : 1" });
  await d.css('pointer-events: Robot.start ? "none" : "auto"');
  await inside("Home holder", "Button", { Name: "Home", x: "0", y: "0", w: "100%", h: "100%", text: '"Home"', holdMs: "600", fill: "$panel2", textColour: "Robot.is_home ? $green : $text" });
  await handlers([
    ["press", CHIRP],
    ["confirm", `await SetServo(true);\nawait RunJob({ job_name: "Home249" });\n${CHIRP}`],
  ]);

  // the conveyor and its pusher, and the buttons that drive them while held
  await panel("Conveyor panel", "80", "51", "47", "20");
  await title("Conveyor panel", "Conveyors", "37");
  const belt = await inside("Conveyor panel", "Conveyor", { Name: "Belt", x: "1", y: "4", w: "35", h: "15", leftPos: "DistanceD - 455", rightPos: "DistanceA - 621", length: "1485", running: "ConveyorGo", speed: "-0.25" });
  await handlers([["press", "ConveyorGo = true;"], ["release", "ConveyorGo = false;"]]);
  const pusher = await inside("Conveyor panel", "Pusher", { Name: "Pusher", x: "1", y: "6", w: "13", h: "13", push: "PusherOut ? 1 : 0", colour: "#804c4c", sweepMs: "900" });
  const held = [
    ["Loop", "1", "LoopGo ? $green : $panel3", "LoopGo = true;\nLoopStop = true;", "LoopGo = false;\nLoopStop = true;"],
    ["Convey", "7", "$panel3", "ConveyorGo = true;", "ConveyorGo = false;"],
    ["Push", "13", "$panel3", "PusherExtend = true;", "PusherExtend = false;"],
  ];
  const buttons = {};
  for (const [name, y, fill, down, up] of held) {
    buttons[name] = await inside("Conveyor panel", "Button", { Name: name, x: "37", y, w: "9", h: "5", text: `"${name}"`, fill, radius: "$radiusPill" });
    await handlers([["press", down], ["release", up]]);
  }

  // the vacuum, which a tap on its gauge turns on and off, and the box's distance over time
  await panel("Vacuum panel", "62", "51", "17", "20");
  await title("Vacuum panel", "Vacuum", "17", "5");
  const gauge = await inside("Vacuum panel", "Gauge", { Name: "Vacuum gauge", x: "0.5", y: "4", w: "16", h: "16", value: "Vacuum * 0.01", max: "15", unit: '"bar"', digits: "2" });
  await handlers([["tap", "Suction = !Suction;"]]);
  await d.deselect();
  await d.place("Plot", { Name: "Distance trend", x: "62", y: "39", w: "17", h: "11", values: "distanceHistory", min: "400", max: "1700", seconds: "5" });
  await d.deselect();
  await d.add("frame", { Name: "Pick zone", x: "81", y: "55", w: "14", h: "14.3", Fill: "$greenBg", Radius: "$radiusLarge" });
  await page.locator('button[title="Edit the border"]').click();
  await d.set({ Width: "0.1", Colour: "$green" });
  await page.keyboard.press("Escape");
  await d.css('pointer-events: "none"');

  // the cell's own buttons
  const big = async (name, x, y, fill, on) => {
    await d.deselect();
    const id = await d.place("Button", { Name: name, x, y, w: "12", h: "12", text: `"${name}"`, textSize: "2.2", fill, radius: "$radiusPill", ...(name === "JOG" ? { holdMs: "500" } : {}) });
    await handlers(on);
    return id;
  };
  const jog = await big("JOG", "1", "46", "$panel3", [
    ["press", 'jogging = true;\nnotify("Turning on servos to start JOG");'],
    [
      "confirm",
      'await SetServo(true);\nawait RunJob({ job_name: "Jog" });\nwhile (jogging) {\n  const v = jogVel.map((s) => s * 0.1 * jogSpeed);\n  if (jogMode == "Joint") JogJoint.send({ velocity: v });\n  else JogCartesian.send({ twist: { linear: vec(v[0], v[1], v[2]), angular: vec(v[3], v[4], v[5]) }, frame: "Robot", tool: 0, user_frame: 0 });\n  await sleep(20);\n}',
    ],
    ["release", "if (jogging) {\n  jogging = false;\n  await SetHold(true);\n  await SetHold(false);\n  await SetServo(false);\n}"],
  ]);
  const slow = await big("SLOW", "14", "46", "SafetyCmd.slow_mode ? $amber : $panel3", [["confirm", "SafetyCmd.slow_mode = !SafetyCmd.slow_mode;"]]);
  const stop = await big("STOP", "1", "59", "SafetyStatus.lamp_red ? $red : $red.darken(0.5)", [
    ["press", "SafetyCmd.stop = true;\nSafetyCmd.chirp = true;\nawait sleep(200);\nSafetyCmd.stop = false;\nSafetyCmd.chirp = false;"],
  ]);
  const reset = await big("RESET", "14", "59", "SafetyStatus.lamp_green || SafetyStatus.lamp_yellow ? $green : $panel3", [
    ["confirm", "SafetyCmd.chirp = true;\nSafetyCmd.reset = true;\nawait sleep(100);\nSafetyCmd.reset = false;\nSafetyCmd.chirp = false;"],
  ]);

  // over everything while the safety circuit is open
  await d.deselect();
  await d.add("frame", { Name: "Estop", x: "23", y: "17", w: "79", h: "39", Fill: "$red.alpha(0.55)", Radius: "6.4" });
  await d.css('visibility: SafetyStatus.estop ? "hidden" : "visible"');
  await d.add("text", { Name: "Estop text", x: "0", y: "0", w: "100%", h: "100%", Text: '"ESTOP ACTIVE"', Colour: "$onFill", Size: "8.4", Weight: "700", Align: '"center"', Vertical: '"center"' });

  // ---------------------------------------------------------------- running it
  await d.tab("Run");
  const el = (id) => page.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
  const value = (alias) => hmi.state.values[alias]?.value;
  const centre = async (id, n = 0) => {
    const b = await el(id).nth(n).boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const hold = async (id, ms, then) => {
    const at = await centre(id);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.waitForTimeout(ms);
    await then?.();
    await page.mouse.up();
  };
  const shown = async (id) => (await el(id).evaluate((e) => getComputedStyle(e).visibility)) === "visible";
  await eventually(async () => (await el(belt).count()) === 1 && value("Robot") !== undefined, "the overview drawn with the robot's state");

  // the conveyor runs only while Convey is held, carrying its box left
  const before = value("DistanceD");
  // a slat's step each frame: it runs left and jumps back one spacing a cycle, too short a cycle
  // for readings taken from here, which can land at the same point of it each time
  const steps = () =>
    el(belt)
      .locator('.el[data-name="slat"]')
      .nth(1)
      .evaluate(
        (e) =>
          new Promise((done) => {
            const xs = [];
            const frame = () => (xs.push(e.getBoundingClientRect().x), xs.length < 24 ? requestAnimationFrame(frame) : done(xs.slice(1).map((x, i) => x - xs[i])));
            requestAnimationFrame(frame);
          }),
      );
  await hold(buttons.Convey, 600, async () => {
    await eventually(() => value("ConveyorGo") === true && value("DistanceD") < before, "the box to move while Convey is held");
    const seen = await steps();
    const [left, right] = [seen.filter((s) => s < 0).length, seen.filter((s) => s > 0).length];
    check(left > 2 * right, `the belt to move left while the conveyor runs, its slat stepped ${seen.map(Math.round).join(" ")} with ConveyorGo ${value("ConveyorGo")}`);
  });
  await eventually(() => value("ConveyorGo") === false, "the conveyor to stop at the release");
  const still = await steps();
  check(still.every((s) => s === 0), `the belt still once the conveyor stops, its slat stepped ${still.map(Math.round).join(" ")}`);
  const box = await el(belt).locator('.el[data-name="box"]').boundingBox();
  const whole = await el(belt).boundingBox();
  check(box.x > whole.x && box.x + box.width <= whole.x + whole.width + 1, `the box sits on the belt: ${JSON.stringify(box)} in ${JSON.stringify(whole)}`);

  // the pusher sweeps up its box while Push is held
  const bar = () => el(pusher).locator('.el[data-name="bar"]').boundingBox();
  const low = (await bar()).y;
  await hold(buttons.Push, 1500, () => eventually(async () => value("PusherOut") === true && (await bar()).y < low - 50, "the pusher to sweep up"));
  await eventually(async () => (await bar()).y > low - 2, "the pusher back down");

  // a tap on the gauge sucks, and the reading rises
  await el(gauge).click();
  await eventually(() => value("Suction") === true && value("Vacuum") > 300, "the vacuum to build");
  await el(gauge).click();
  await eventually(() => value("Suction") === false, "the vacuum off");

  // stop opens the safety circuit, the warning covers the cell, and reset closes it again
  const estop = await page.locator('.run-layer:not([hidden]) .el[data-name="Estop"]');
  check((await estop.evaluate((e) => getComputedStyle(e).visibility)) === "hidden", "the warning shows while the cell is safe");
  await hold(stop, 100);
  await eventually(async () => value("SafetyStatus")?.estop === false && (await estop.evaluate((e) => getComputedStyle(e).visibility)) === "visible", "the warning at a stop");
  // the circuit takes no reset while the stop is still sent
  await eventually(() => value("SafetyCmd")?.stop === false, "the stop let go");
  await el(reset).click();
  await eventually(async () => value("SafetyStatus")?.estop === true && (await estop.evaluate((e) => getComputedStyle(e).visibility)) === "hidden", "the warning gone after a reset");
  await el(slow).click();
  await eventually(() => value("SafetyCmd")?.slow_mode === true && value("SafetyStatus")?.lamp_yellow === true, "slow mode on");
  await el(slow).click();
  await eventually(() => value("SafetyCmd")?.slow_mode === false, "slow mode off");

  // the servos come on from their toggle, its track amber a moment
  await el(servos).click();
  await eventually(() => value("Robot")?.servo_power === true, "the servos on");
  // a job runs once Run is held long enough, Halt takes its place, and halting holds it
  await hold(run, 900);
  await eventually(async () => value("Robot")?.start === true && value("Robot")?.cur_job_name === "HOME249" && (await shown(halt)) && !(await shown(run)), "the job running, Halt shown");
  await el(halt).click();
  await eventually(async () => value("Robot")?.start === false && value("Robot")?.hold === false && (await shown(run)), "the job halted");
  check(/^IDLE|HOME IDLE$/.test((await page.locator('.run-layer:not([hidden]) .el[data-name="State text"]').textContent()) ?? ""), "the state reads idle");

  // jogging takes two fingers: JOG held starts the Jog job, and a + held turns its joint
  const touch = await (await page.context().browser().newContext({ hasTouch: true, viewport: { width: 1600, height: 1000 } })).newPage();
  await touch.goto(sys.url);
  await touch.locator(".statusbar", { hasText: "System" }).waitFor();
  await touch.locator(".tab", { hasText: "Design" }).click();
  await touch.locator(".screen:not([hidden]) .page-row", { hasText: /^Overview/ }).click();
  await touch.locator(".tab", { hasText: "Run" }).click();
  const at = (id, n = 0) => touch.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`).nth(n);
  await at(jog).waitFor();
  const middle = async (l) => {
    const b = await l.boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const [j, p0] = [await middle(at(jog)), await middle(at(plus, 0))];
  const cdp = await touch.context().newCDPSession(touch);
  const fingers = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: i + 1 })) });
  const start = value("JointState")?.position?.[0] ?? 0;
  await fingers("touchStart", [j]);
  await eventually(() => value("Robot")?.cur_job_name === "JOG" && value("Robot")?.start === true, "the Jog job after JOG is held");
  await fingers("touchStart", [j, p0]);
  await eventually(() => (value("JointState")?.position?.[0] ?? 0) > start + 0.02, () => `the first joint to turn, it is at ${value("JointState")?.position?.[0]}`);
  await fingers("touchEnd", [j]);
  await fingers("touchEnd", []);
  await eventually(() => value("Robot")?.servo_power === false && value("Robot")?.start === false, "the servos off once JOG is let go");
  await touch.context().close();

  // a stop with the servos on raises an alarm, which shows its number until a press clears it
  await el(servos).click();
  await eventually(() => value("Robot")?.servo_power === true, "the servos on again");
  await hold(stop, 100);
  await eventually(async () => value("Robot")?.alarm === true && (await el(alarm).textContent()) === "4000", async () => `the alarm, it reads ${await el(alarm).textContent()}`);
  const fills = new Set();
  await eventually(async () => {
    fills.add(await el(alarm).locator('.el[data-name="face"]').evaluate((e) => getComputedStyle(e).backgroundColor));
    return fills.size === 2;
  }, () => `the alarm to blink, its fills ${[...fills]}`);
  await eventually(() => value("SafetyCmd")?.stop === false, "the stop let go");
  await el(reset).click();
  await eventually(() => value("SafetyStatus")?.estop === true, "the cell safe again");
  await el(alarm).click();
  await eventually(async () => value("Robot")?.alarm === false && (await el(alarm).textContent()) === "OK", "the alarm cleared");
}
