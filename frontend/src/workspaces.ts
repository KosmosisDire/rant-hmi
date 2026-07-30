/* The frame's workspaces: what the topbar tabs switch between. Every workspace's DOM is
 * built ONCE and kept alive; switching hides the others instead of tearing them down, so
 * the content workspace's viewport transform, selection overlay and reconciled sidebars
 * survive a round trip through Data or Style. Nothing here touches the connection or the
 * document: a tab is pure view routing. */

export type WorkspaceId = "content" | "data" | "style";

export interface Workspace {
  id: WorkspaceId;
  label: string;
  root: HTMLElement;
}

/* content is the three-column editor the shell builds; data is the network/variable
 * explorer (workspaces/data.ts) and style the theme token editor (workspaces/style.ts),
 * both reconciled by the shell like sidebars */
export function buildWorkspaces(content: HTMLElement, data: HTMLElement, style: HTMLElement): Workspace[] {
  return [
    { id: "content", label: "Content", root: content },
    { id: "data", label: "Data", root: data },
    { id: "style", label: "Style", root: style },
  ];
}
