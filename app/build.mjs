// Builds the backend addon and puts it beside main.mjs as rant-hmi.node, where the window loads it.
import { execFileSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { built, cargoArgs } from "./addon.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
execFileSync("cargo", cargoArgs("release"), { cwd: root, stdio: "inherit" });
copyFileSync(built(join(root, "target"), "release"), join(here, "rant-hmi.node"));
