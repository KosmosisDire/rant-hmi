// Where cargo builds the backend addon. On Windows it builds for the MSVC target, as napi needs.
import { join } from "node:path";

const windows = process.platform === "win32";
const file = windows ? "rant_hmi_addon.dll" : process.platform === "darwin" ? "librant_hmi_addon.dylib" : "librant_hmi_addon.so";

/** What `cargo` takes to build the addon in `profile`, "debug" or "release". */
export const cargoArgs = (profile) => ["build", "-p", "rant-hmi-addon", ...(profile === "release" ? ["--release"] : []), ...(windows ? ["--target", "x86_64-pc-windows-msvc"] : [])];

/** The addon cargo built in `profile`, in the folder `target`. */
export const built = (target, profile) => join(target, ...(windows ? ["x86_64-pc-windows-msvc"] : []), profile, file);
