/* The frame's workspaces: what the topbar tabs switch between. Every workspace's DOM is
 * built ONCE and kept alive; switching hides the others instead of tearing them down, so
 * the content workspace's viewport transform, selection overlay and reconciled sidebars
 * survive a round trip through Data or Style. Nothing here touches the connection or the
 * document: a tab is pure view routing. */

export type WorkspaceId = "content" | "design" | "data" | "style";

export interface Workspace {
  id: WorkspaceId;
  label: string;
  root: HTMLElement;
}

/* content is the three-column editor the shell builds — page composition, where a
 * component instance is a leaf. design (workspaces/design.ts) is the other hierarchy:
 * what is INSIDE a component, which belongs to the type rather than to any page. data is
 * the network/variable explorer and style the theme token editor; all three of the
 * others are reconciled by the shell like sidebars. */
export function buildWorkspaces(content: HTMLElement, design: HTMLElement,
                                data: HTMLElement, style: HTMLElement): Workspace[] {
  return [
    { id: "content", label: "Content", root: content },
    { id: "design", label: "Design", root: design },
    { id: "data", label: "Data", root: data },
    { id: "style", label: "Style", root: style },
  ];
}
