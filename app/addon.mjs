// Where cargo builds the app's parts, and the platform this host builds them for. On Windows they
// build for the MSVC target, as napi needs and the launcher's icon is made for.
import { join } from "node:path";

const windows = process.platform === "win32";
const lib = windows ? "rant_hmi_addon.dll" : process.platform === "darwin" ? "librant_hmi_addon.dylib" : "librant_hmi_addon.so";

/** This host's platform as apps name it: windows-x64, linux-x64, linux-arm64 or macos-arm64. */
export const platform = `${windows ? "windows" : process.platform === "darwin" ? "macos" : "linux"}-${process.arch}`;

/** What `cargo` takes to build `packages` in `profile`, "debug" or "release". */
export const cargoArgs = (profile, packages = ["rant-hmi-addon"]) => ["build", ...packages.flatMap((p) => ["-p", p]), ...(profile === "release" ? ["--release"] : []), ...(windows ? ["--target", "x86_64-pc-windows-msvc"] : [])];

/** The folder in `target` cargo builds into in `profile`. */
export const builtIn = (target, profile) => join(target, ...(windows ? ["x86_64-pc-windows-msvc"] : []), profile);

/** The addon cargo built in `profile`, in the folder `target`. */
export const built = (target, profile) => join(builtIn(target, profile), lib);

/** A program cargo built, named as this host names programs. */
export const program = (name) => (windows ? `${name}.exe` : name);
