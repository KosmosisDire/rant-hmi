// Where cargo builds the app's parts, and the platform this host builds them for. On Windows they
// build for the MSVC target, as napi needs and the launcher's icon is made for.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const windows = process.platform === "win32";
const lib = windows ? "rant_hmi_addon.dll" : process.platform === "darwin" ? "librant_hmi_addon.dylib" : "librant_hmi_addon.so";

/** This host's platform as apps name it: win-x64, linux-x64, linux-arm64 or osx-arm64. */
export const platform = `${windows ? "win" : process.platform === "darwin" ? "osx" : "linux"}-${process.arch}`;

/** What `cargo` takes to build `packages` in `profile`, "debug" or "release". */
export const cargoArgs = (profile, packages = ["rant-hmi-addon"]) => ["build", ...packages.flatMap((p) => ["-p", p]), ...(profile === "release" ? ["--release"] : []), ...(windows ? ["--target", "x86_64-pc-windows-msvc"] : [])];

/** The folder in `target` cargo builds into in `profile`. */
export const builtIn = (target, profile) => join(target, ...(windows ? ["x86_64-pc-windows-msvc"] : []), profile);

/** The addon cargo built in `profile`, in the folder `target`. */
export const built = (target, profile) => join(builtIn(target, profile), lib);

/** A program cargo built, named as this host names programs. */
export const program = (name) => (windows ? `${name}.exe` : name);

/** The HMI's version, which names the runtimes its servers build apps from. */
export const version = /^version = "(.+)"/m.exec(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "server", "Cargo.toml"), "utf8"))[1];

/** Archives `folder` into `file` as apps carry folders, with the rant-hmi-pack in the folder `built`, answering its id. */
export const pack = (built, folder, file) => execFileSync(join(built, program("rant-hmi-pack")), [folder, file], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
