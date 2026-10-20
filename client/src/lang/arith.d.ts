// Types for arith.js, which stays plain JS so the system's script engine runs it as well.

export declare function arith(src: string, before?: number): string;

/** A node of acorn's tree. */
export interface Node {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

export declare function tree(src: string): Node;
export declare function children(node: Node): Node[];
