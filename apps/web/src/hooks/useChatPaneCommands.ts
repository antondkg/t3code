import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { type AnyRouter, useRouter } from "@tanstack/react-router";

import {
  chatPaneList,
  chatPaneTargetMatches,
  useChatPanesStore,
  workspaceForTarget,
  type ChatPaneEdge,
} from "../chatPanesStore";
import {
  buildDraftThreadRouteParams,
  buildThreadRouteParams,
  resolveThreadRouteTarget,
  type ThreadRouteTarget,
} from "../threadRoutes";

/**
 * Split pane actions for code outside the panes, such as the sidebar and thread actions. The
 * route shows the focused pane, so each focus change is a navigation.
 */
export function createChatPaneCommands(router: AnyRouter) {
  const readRouteTarget = () => resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
  const navigateTo = (target: ThreadRouteTarget, replace = false) =>
    void (target.kind === "server"
      ? router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(target.threadRef),
          replace,
        })
      : router.navigate({
          to: "/draft/$draftId",
          params: buildDraftThreadRouteParams(target.draftId),
          replace,
        }));

  /** Opens `threadRef` beside the focused pane and focuses it; false with no thread routed. */
  const openInSplit = (threadRef: ScopedThreadRef, edge: ChatPaneEdge = "right"): boolean => {
    const routeTarget = readRouteTarget();
    if (routeTarget === null) return false;
    useChatPanesStore
      .getState()
      .openSplit({ routeTarget, target: { kind: "server", threadRef }, edge });
    navigateTo({ kind: "server", threadRef });
    return true;
  };

  /**
   * Closes the pane showing a thread that is gone. True when that moved the route to another
   * pane, so the caller skips its own fallback navigation.
   */
  const closePaneShowing = (threadRef: ScopedThreadRef): boolean => {
    const store = useChatPanesStore.getState();
    const target: ThreadRouteTarget = { kind: "server", threadRef };
    const workspace = workspaceForTarget(store.workspaces, target);
    const pane =
      workspace &&
      chatPaneList(workspace).find((candidate) => chatPaneTargetMatches(candidate, target));
    if (!workspace || !pane) return false;
    const focusTarget = store.closePane({ workspaceId: workspace.id, paneId: pane.id });
    // The removal can finish after the user left the thread, for example for Settings.
    const routeTarget = readRouteTarget();
    const key = scopedThreadKey(threadRef);
    const routeShowsRemoved =
      routeTarget?.kind === "server" && scopedThreadKey(routeTarget.threadRef) === key;
    if (focusTarget === null || !routeShowsRemoved) return false;
    // Replaces the removed thread's history entry, as the single-pane fallback does.
    navigateTo(focusTarget, true);
    return true;
  };

  /** Shows the workspace at the pane it last focused. */
  const openWorkspace = (workspaceId: string) => {
    const workspace = useChatPanesStore
      .getState()
      .workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) return;
    const panes = chatPaneList(workspace);
    const pane = panes.find((candidate) => candidate.id === workspace.activePaneId) ?? panes[0];
    if (pane) navigateTo(pane.target);
  };

  /** The thread stays open on its own; the rest of its workspace keeps its layout. */
  const removeFromWorkspace = (threadRef: ScopedThreadRef) =>
    useChatPanesStore.getState().removeThread({ kind: "server", threadRef });

  return { openInSplit, closePaneShowing, openWorkspace, removeFromWorkspace };
}

export function useChatPaneCommands() {
  return createChatPaneCommands(useRouter());
}
