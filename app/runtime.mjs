// Builds this host's runtime for apps: Electron with the window, the backend addon and the client inside, archived
// beside the launcher that unpacks it, into target/app/<platform>. It goes where this host's HMI server builds apps
// from too, ~/.rant/hmi/runtimes/<version>/<platform>, so the editor offers this platform.

import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { built, builtIn, cargoArgs, platform, program } from "./addon.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const target = join(root, "target");
const out = join(target, "app", platform);
const stage = join(out, "runtime");
const release = builtIn(target, "release");

/** Runs a command with its output shown. npm is a script on Windows, which only a shell runs. */
const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" && command === "npm" });

run("npm", ["run", "build"], join(root, "client"));
run("cargo", cargoArgs("release", ["rant-hmi-addon", "rant-hmi-launcher", "rant-hmi-pack"]), root);

// Electron as it ships, the window in resources/app and the client beside it, where the window looks for it
rmSync(stage, { recursive: true, force: true });
cpSync(dirname(createRequire(join(here, "package.json"))("electron")), stage, { recursive: true });
rmSync(join(stage, "resources", "default_app.asar"), { force: true });
const app = join(stage, "resources", "app");
mkdirSync(app, { recursive: true });
for (const file of ["main.mjs", "preload.cjs", "package.json", "icon.ico", "icon.png"]) copyFileSync(join(here, file), join(app, file));
copyFileSync(built(target, "release"), join(app, "rant-hmi.node"));
cpSync(join(root, "client", "dist"), join(stage, "resources", "client", "dist"), { recursive: true });

run(join(release, program("rant-hmi-pack")), [stage, out], root);
copyFileSync(join(release, program("rant-hmi-app")), join(out, program("launcher")));
rmSync(stage, { recursive: true, force: true });

// where this host's server finds it, under the version the server is, by the folder the addon says it keeps
const version = /^version = "(.+)"/m.exec(readFileSync(join(root, "server", "Cargo.toml"), "utf8"))[1];
const addon = { exports: {} };
process.dlopen(addon, built(target, "release"));
const kept = addon.exports.kept();
if (kept) {
  const into = join(kept, "runtimes", version, platform);
  mkdirSync(into, { recursive: true });
  for (const file of ["runtime.tar.gz", "runtime.id", program("launcher")]) copyFileSync(join(out, file), join(into, file));
  console.log(`the ${platform} runtime is in ${out} and ${into}`);
}
