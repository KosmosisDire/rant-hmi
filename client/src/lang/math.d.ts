// Types for math.js, which stays plain JS so the system's script engine runs it as well.

export type MathKind = "vec2" | "vec3" | "quat" | "pose" | "colour";

export declare function kind(v: unknown): MathKind | null;
export declare const METHOD_NAMES: string[];
export declare const METHODS_OF: Record<MathKind, string[]>;
export declare const LIBRARY: Record<string, unknown>;
