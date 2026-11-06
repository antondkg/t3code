import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
import { randomUUID } from "./lib/utils";
import type { ThreadRouteTarget } from "./threadRoutes";

export interface ChatPane {
  readonly id: string;
  readonly target: ThreadRouteTarget;
}

export type ChatPaneEdge = "left" | "right" | "top" | "bottom";

/** Two subtrees side by side (`row`) or stacked (`column`); `ratio` is the first one's share. */
export interface ChatPaneSplit {
  readonly kind: "split";
  readonly id: string;
  readonly direction: "row" | "column";
  readonly ratio: number;
  readonly children: readonly [ChatPaneNode, ChatPaneNode];
}

export type ChatPaneNode = (ChatPane & { readonly kind: "pane" }) | ChatPaneSplit;

/** One pane tree. Outside a workspace it is the routed thread alone. */
export interface ChatPanesLayout {
  readonly root: ChatPaneNode | null;
  readonly activePaneId: string | null;
}

/**
 * Threads tiled together. The route shows a workspace while it is on one of its threads, focusing
 * that pane; any other route shows its thread alone and leaves every workspace as it was.
 */
export interface ChatWorkspace extends ChatPanesLayout {
  readonly id: string;
  readonly root: ChatPaneNode;
}

export interface ResolvedChatPane extends ChatPane {
  readonly active: boolean;
}

/** Fractions of the pane area. */
export interface ChatPaneRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ChatPaneDivider {
  readonly splitId: string;
  readonly direction: "row" | "column";
  /** The split's area; the divider sits at its ratio. */
  readonly area: ChatPaneRect;
  readonly ratio: number;
  /** Smallest share of the area each side can take, in pixels. */
  readonly minFirst: { readonly width: number; readonly height: number };
  readonly minSecond: { readonly width: number; readonly height: number };
}

export const SINGLE_CHAT_PANE_LAYOUT: ChatPanesLayout = { root: null, activePaneId: null };
export const MAX_CHAT_PANES = 6;
/** Below this, a pane's composer controls overflow; matches the preview panel's sibling column. */
export const CHAT_PANE_MIN_WIDTH = 360;
export const CHAT_PANE_MIN_HEIGHT = 240;
const FULL_RECT: ChatPaneRect = { x: 0, y: 0, width: 1, height: 1 };

/** The lone thread's pane id; a new workspace keeps it for that thread, so its view stays mounted. */
const PRIMARY_CHAT_PANE_ID = "primary";

function chatPaneTargetKey(target: ThreadRouteTarget): string {
  return target.kind === "server" ? scopedThreadKey(target.threadRef) : `draft:${target.draftId}`;
}

function leaves(node: ChatPaneNode | null): ReadonlyArray<ChatPane> {
  if (node === null) return [];
  if (node.kind === "pane") return [{ id: node.id, target: node.target }];
  return [...leaves(node.children[0]), ...leaves(node.children[1])];
}

export function chatPaneList(layout: ChatPanesLayout): ReadonlyArray<ChatPane> {
  return leaves(layout.root);
}

function mapPanes(node: ChatPaneNode, map: (pane: ChatPane) => ChatPaneNode): ChatPaneNode {
  if (node.kind === "pane") return map(node);
  const first = mapPanes(node.children[0], map);
  const second = mapPanes(node.children[1], map);
  return first === node.children[0] && second === node.children[1]
    ? node
    : { ...node, children: [first, second] };
}

/** Removes a pane; its sibling takes the parent split's place. */
function removePane(node: ChatPaneNode, paneId: string): ChatPaneNode | null {
  if (node.kind === "pane") return node.id === paneId ? null : node;
  const first = removePane(node.children[0], paneId);
  const second = removePane(node.children[1], paneId);
  if (first === null) return second;
  if (second === null) return first;
  return first === node.children[0] && second === node.children[1]
    ? node
    : { ...node, children: [first, second] };
}

/** The pane that takes `paneId`'s place when it closes: the nearest one in its sibling subtree. */
function successorPane(node: ChatPaneNode, paneId: string): ChatPane | null {
  if (node.kind === "pane") return null;
  const [first, second] = node.children;
  if (first.kind === "pane" && first.id === paneId) return leaves(second)[0] ?? null;
  if (second.kind === "pane" && second.id === paneId) return leaves(first).at(-1) ?? null;
  return successorPane(first, paneId) ?? successorPane(second, paneId);
}

function splitAt(
  root: ChatPaneNode,
  targetPaneId: string,
  added: ChatPane,
  edge: ChatPaneEdge,
  splitId: string,
): ChatPaneNode {
  const addedNode: ChatPaneNode = { kind: "pane", ...added };
  return mapPanes(root, (pane) => {
    if (pane.id !== targetPaneId) return { kind: "pane", ...pane };
    const existing: ChatPaneNode = { kind: "pane", ...pane };
    const before = edge === "left" || edge === "top";
    return {
      kind: "split",
      id: splitId,
      direction: edge === "left" || edge === "right" ? "row" : "column",
      ratio: 0.5,
      children: before ? [addedNode, existing] : [existing, addedNode],
    };
  });
}

export function chatPaneTargetMatches(pane: ChatPane, target: ThreadRouteTarget): boolean {
  return chatPaneTargetKey(pane.target) === chatPaneTargetKey(target);
}

export function workspaceForTarget(
  workspaces: ReadonlyArray<ChatWorkspace>,
  target: ThreadRouteTarget | null,
): ChatWorkspace | null {
  if (target === null) return null;
  return (
    workspaces.find((workspace) =>
      chatPaneList(workspace).some((pane) => chatPaneTargetMatches(pane, target)),
    ) ?? null
  );
}

/** What each pane shows for the current route: its workspace, or the routed thread alone. */
export function resolveChatPanes(
  workspaces: ReadonlyArray<ChatWorkspace>,
  routeTarget: ThreadRouteTarget,
): ReadonlyArray<ResolvedChatPane> {
  const workspace = workspaceForTarget(workspaces, routeTarget);
  if (workspace === null) {
    return [{ id: PRIMARY_CHAT_PANE_ID, target: routeTarget, active: true }];
  }
  return chatPaneList(workspace).map((pane) => ({
    ...pane,
    active: chatPaneTargetMatches(pane, routeTarget),
  }));
}

/**
 * Threads the unfocused panes show for this route; a draft pane has no thread until it sends.
 * None while the area is too small for the split, since only the focused pane renders then.
 */
export function backgroundChatPaneThreadRefs(
  workspaces: ReadonlyArray<ChatWorkspace>,
  routeTarget: ThreadRouteTarget | null,
  splitFits: boolean,
): ReadonlyArray<ScopedThreadRef> {
  if (routeTarget === null || !splitFits) return [];
  return resolveChatPanes(workspaces, routeTarget).flatMap((pane) =>
    !pane.active && pane.target.kind === "server" ? [pane.target.threadRef] : [],
  );
}

/** Remembers the routed pane, which a workspace reopens to from the sidebar. */
export function commitChatPanes(
  workspaces: ReadonlyArray<ChatWorkspace>,
  routeTarget: ThreadRouteTarget,
): ReadonlyArray<ChatWorkspace> {
  const workspace = workspaceForTarget(workspaces, routeTarget);
  const routed =
    workspace && chatPaneList(workspace).find((pane) => chatPaneTargetMatches(pane, routeTarget));
  if (!workspace || !routed || workspace.activePaneId === routed.id) return workspaces;
  return workspaces.map((candidate) =>
    candidate === workspace ? { ...candidate, activePaneId: routed.id } : candidate,
  );
}

function replaceWorkspace(
  workspaces: ReadonlyArray<ChatWorkspace>,
  id: string,
  next: ChatPanesLayout,
): ReadonlyArray<ChatWorkspace> {
  // One pane left is no longer a workspace; its thread returns to the sidebar list.
  if (next.root === null || next.root.kind === "pane") {
    return workspaces.filter((workspace) => workspace.id !== id);
  }
  const root = next.root;
  return workspaces.map((workspace) =>
    workspace.id === id ? { id, root, activePaneId: next.activePaneId } : workspace,
  );
}

/** Takes a thread out of whichever workspace holds it. */
export function removeThreadFromWorkspaces(
  workspaces: ReadonlyArray<ChatWorkspace>,
  target: ThreadRouteTarget,
): ReadonlyArray<ChatWorkspace> {
  const workspace = workspaceForTarget(workspaces, target);
  const pane =
    workspace &&
    chatPaneList(workspace).find((candidate) => chatPaneTargetMatches(candidate, target));
  if (!workspace || !pane) return workspaces;
  return closeChatPane(workspaces, { workspaceId: workspace.id, paneId: pane.id }).workspaces;
}

/**
 * Shows `target` on `edge` of the routed pane: in its workspace, or in a new one with the routed
 * thread. A thread joins one workspace at most, so it leaves any other; a full workspace stays as it is.
 */
export function openChatSplit(
  workspaces: ReadonlyArray<ChatWorkspace>,
  input: {
    readonly routeTarget: ThreadRouteTarget;
    readonly target: ThreadRouteTarget;
    readonly edge?: ChatPaneEdge;
    readonly createId: () => string;
  },
): ReadonlyArray<ChatWorkspace> {
  if (chatPaneTargetKey(input.routeTarget) === chatPaneTargetKey(input.target)) return workspaces;
  const current = workspaceForTarget(workspaces, input.routeTarget);
  if (current && chatPaneList(current).some((pane) => chatPaneTargetMatches(pane, input.target))) {
    return workspaces;
  }
  if (current && chatPaneList(current).length >= MAX_CHAT_PANES) return workspaces;
  const others = removeThreadFromWorkspaces(workspaces, input.target);
  const base = current
    ? (others.find((workspace) => workspace.id === current.id) ?? current)
    : null;
  const routedPane = base
    ? chatPaneList(base).find((pane) => chatPaneTargetMatches(pane, input.routeTarget))!
    : { id: PRIMARY_CHAT_PANE_ID, target: input.routeTarget };
  const root: ChatPaneNode = base?.root ?? { kind: "pane", ...routedPane };
  const added = { id: input.createId(), target: input.target };
  const workspace: ChatWorkspace = {
    id: base?.id ?? input.createId(),
    root: splitAt(
      root,
      routedPane.id,
      added,
      input.edge ?? "right",
      input.createId(),
    ) as ChatPaneSplit,
    activePaneId: routedPane.id,
  };
  return base
    ? others.map((candidate) => (candidate.id === base.id ? workspace : candidate))
    : [...others, workspace];
}

/** Moves a pane to `edge` of another pane. Both keep their ids, so neither remounts. */
export function dockChatPane(
  workspaces: ReadonlyArray<ChatWorkspace>,
  input: {
    readonly workspaceId: string;
    readonly paneId: string;
    readonly targetPaneId: string;
    readonly edge: ChatPaneEdge;
    readonly createSplitId: () => string;
  },
): ReadonlyArray<ChatWorkspace> {
  const workspace = workspaces.find((candidate) => candidate.id === input.workspaceId);
  if (!workspace || input.paneId === input.targetPaneId) return workspaces;
  const panes = chatPaneList(workspace);
  const moving = panes.find((pane) => pane.id === input.paneId);
  if (!moving || !panes.some((pane) => pane.id === input.targetPaneId)) return workspaces;
  const remaining = removePane(workspace.root, input.paneId);
  if (remaining === null) return workspaces;
  return replaceWorkspace(workspaces, workspace.id, {
    root: splitAt(remaining, input.targetPaneId, moving, input.edge, input.createSplitId()),
    activePaneId: workspace.activePaneId,
  });
}

/**
 * Puts a thread dragged in from the sidebar on `edge` of the pane showing `paneTarget`: its own
 * pane moves there when both share a workspace, otherwise it opens there as a split does.
 */
export function dropThreadOnChatPane(
  workspaces: ReadonlyArray<ChatWorkspace>,
  input: {
    readonly paneTarget: ThreadRouteTarget;
    readonly target: ThreadRouteTarget;
    readonly edge: ChatPaneEdge;
    readonly createId: () => string;
  },
): ReadonlyArray<ChatWorkspace> {
  const workspace = workspaceForTarget(workspaces, input.paneTarget);
  const panes = workspace ? chatPaneList(workspace) : [];
  const moving = panes.find((pane) => chatPaneTargetMatches(pane, input.target));
  const anchor = panes.find((pane) => chatPaneTargetMatches(pane, input.paneTarget));
  if (workspace && moving && anchor) {
    return dockChatPane(workspaces, {
      workspaceId: workspace.id,
      paneId: moving.id,
      targetPaneId: anchor.id,
      edge: input.edge,
      createSplitId: input.createId,
    });
  }
  return openChatSplit(workspaces, {
    routeTarget: input.paneTarget,
    target: input.target,
    edge: input.edge,
    createId: input.createId,
  });
}

/**
 * Removes a pane. Closing the focused pane focuses the one taking its place; `focusTarget` is
 * the thread the route should move to then, and null when the route needs no change.
 */
export function closeChatPane(
  workspaces: ReadonlyArray<ChatWorkspace>,
  input: { readonly workspaceId: string; readonly paneId: string },
): {
  readonly workspaces: ReadonlyArray<ChatWorkspace>;
  readonly focusTarget: ThreadRouteTarget | null;
} {
  const workspace = workspaces.find((candidate) => candidate.id === input.workspaceId);
  if (!workspace || !chatPaneList(workspace).some((pane) => pane.id === input.paneId)) {
    return { workspaces, focusTarget: null };
  }
  const successor = successorPane(workspace.root, input.paneId);
  const closedActive = workspace.activePaneId === input.paneId;
  return {
    // The remaining panes keep their ids, so they stay mounted.
    workspaces: replaceWorkspace(workspaces, workspace.id, {
      root: removePane(workspace.root, input.paneId),
      activePaneId: closedActive ? (successor?.id ?? null) : workspace.activePaneId,
    }),
    focusTarget: closedActive ? (successor?.target ?? null) : null,
  };
}

export function resizeChatSplit(
  workspaces: ReadonlyArray<ChatWorkspace>,
  input: { readonly workspaceId: string; readonly splitId: string; readonly ratio: number },
): ReadonlyArray<ChatWorkspace> {
  const resize = (node: ChatPaneNode): ChatPaneNode => {
    if (node.kind === "pane") return node;
    if (node.id === input.splitId) {
      return node.ratio === input.ratio ? node : { ...node, ratio: input.ratio };
    }
    const first = resize(node.children[0]);
    const second = resize(node.children[1]);
    return first === node.children[0] && second === node.children[1]
      ? node
      : { ...node, children: [first, second] };
  };
  let changed = false;
  const next = workspaces.map((workspace) => {
    if (workspace.id !== input.workspaceId) return workspace;
    const root = resize(workspace.root);
    changed = root !== workspace.root;
    return changed ? { ...workspace, root } : workspace;
  });
  return changed ? next : workspaces;
}

/** Smallest pixel size at which every pane of `node` keeps its minimum. */
export function chatPanesMinSize(node: ChatPaneNode | null): {
  readonly width: number;
  readonly height: number;
} {
  if (node === null || node.kind === "pane") {
    return { width: CHAT_PANE_MIN_WIDTH, height: CHAT_PANE_MIN_HEIGHT };
  }
  const first = chatPanesMinSize(node.children[0]);
  const second = chatPanesMinSize(node.children[1]);
  return node.direction === "row"
    ? { width: first.width + second.width, height: Math.max(first.height, second.height) }
    : { width: Math.max(first.width, second.width), height: first.height + second.height };
}

/** Where each pane and divider sits, as fractions of the pane area. */
export function chatPaneGeometry(layout: ChatPanesLayout): {
  readonly panes: ReadonlyMap<string, ChatPaneRect>;
  readonly dividers: ReadonlyArray<ChatPaneDivider>;
} {
  const panes = new Map<string, ChatPaneRect>();
  const dividers: ChatPaneDivider[] = [];
  const place = (node: ChatPaneNode, area: ChatPaneRect) => {
    if (node.kind === "pane") {
      panes.set(node.id, area);
      return;
    }
    const [first, second] = node.children;
    const row = node.direction === "row";
    const firstArea = row
      ? { ...area, width: area.width * node.ratio }
      : { ...area, height: area.height * node.ratio };
    const secondArea = row
      ? { ...area, x: area.x + firstArea.width, width: area.width - firstArea.width }
      : { ...area, y: area.y + firstArea.height, height: area.height - firstArea.height };
    dividers.push({
      splitId: node.id,
      direction: node.direction,
      area,
      ratio: node.ratio,
      minFirst: chatPanesMinSize(first),
      minSecond: chatPanesMinSize(second),
    });
    place(first, firstArea);
    place(second, secondArea);
  };
  if (layout.root !== null) place(layout.root, FULL_RECT);
  return { panes, dividers };
}

function isTarget(value: unknown): value is ThreadRouteTarget {
  if (typeof value !== "object" || value === null) return false;
  const target = value as Record<string, unknown>;
  if (target.kind === "draft") return typeof target.draftId === "string";
  if (target.kind !== "server") return false;
  const ref = target.threadRef as Record<string, unknown> | null | undefined;
  return typeof ref?.environmentId === "string" && typeof ref.threadId === "string";
}

function isNode(value: unknown): value is ChatPaneNode {
  if (typeof value !== "object" || value === null) return false;
  const node = value as Record<string, unknown>;
  if (typeof node.id !== "string") return false;
  if (node.kind === "pane") return isTarget(node.target);
  return (
    node.kind === "split" &&
    (node.direction === "row" || node.direction === "column") &&
    typeof node.ratio === "number" &&
    node.ratio > 0 &&
    node.ratio < 1 &&
    Array.isArray(node.children) &&
    node.children.length === 2 &&
    node.children.every(isNode)
  );
}

function restoreWorkspace(value: unknown): ChatWorkspace | null {
  if (typeof value !== "object" || value === null) return null;
  const { id, root, activePaneId } = value as Record<string, unknown>;
  if (typeof id !== "string" || !isNode(root) || root.kind !== "split") return null;
  const panes = chatPaneList({ root, activePaneId: null });
  if (panes.length > MAX_CHAT_PANES) return null;
  return {
    id,
    root,
    activePaneId: panes.some((pane) => pane.id === activePaneId)
      ? (activePaneId as string)
      : panes[0]!.id,
  };
}

/** Keeps well-formed workspaces; a thread already in an earlier one drops the later one. */
export function restoreChatWorkspaces(value: unknown): ReadonlyArray<ChatWorkspace> {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const restored: ChatWorkspace[] = [];
  for (const candidate of value) {
    const workspace = restoreWorkspace(candidate);
    if (workspace === null) continue;
    const keys = chatPaneList(workspace).map((pane) => chatPaneTargetKey(pane.target));
    if (keys.some((key) => seen.has(key))) continue;
    for (const key of keys) seen.add(key);
    restored.push(workspace);
  }
  return restored;
}

interface ChatPanesStoreState {
  readonly workspaces: ReadonlyArray<ChatWorkspace>;
  /** Whether the chat area is large enough to render every pane of the shown workspace. */
  readonly splitFits: boolean;
  readonly setSplitFits: (splitFits: boolean) => void;
  readonly commit: (routeTarget: ThreadRouteTarget) => void;
  readonly openSplit: (input: {
    readonly routeTarget: ThreadRouteTarget;
    readonly target: ThreadRouteTarget;
    readonly edge?: ChatPaneEdge;
  }) => void;
  /** False when nothing changed, such as a drop on a full workspace. */
  readonly dropThread: (input: {
    readonly paneTarget: ThreadRouteTarget;
    readonly target: ThreadRouteTarget;
    readonly edge: ChatPaneEdge;
  }) => boolean;
  readonly dock: (input: {
    readonly workspaceId: string;
    readonly paneId: string;
    readonly targetPaneId: string;
    readonly edge: ChatPaneEdge;
  }) => void;
  readonly resize: (input: {
    readonly workspaceId: string;
    readonly splitId: string;
    readonly ratio: number;
  }) => void;
  /** Returns the thread to navigate to when the focused pane closed. */
  readonly closePane: (input: {
    readonly workspaceId: string;
    readonly paneId: string;
  }) => ThreadRouteTarget | null;
  readonly removeThread: (target: ThreadRouteTarget) => void;
  /** Ungroups a workspace; its threads return to the sidebar list. */
  readonly dissolve: (workspaceId: string) => void;
}

export const useChatPanesStore = create<ChatPanesStoreState>()(
  persist(
    (set, get) => ({
      workspaces: [],
      splitFits: true,
      setSplitFits: (splitFits) =>
        set((state) => (state.splitFits === splitFits ? state : { splitFits })),
      commit: (routeTarget) =>
        set((state) => {
          const workspaces = commitChatPanes(state.workspaces, routeTarget);
          return workspaces === state.workspaces ? state : { workspaces };
        }),
      openSplit: (input) =>
        set((state) => ({
          workspaces: openChatSplit(state.workspaces, { ...input, createId: randomUUID }),
        })),
      dropThread: (input) => {
        const current = get().workspaces;
        const workspaces = dropThreadOnChatPane(current, { ...input, createId: randomUUID });
        if (workspaces === current) return false;
        set({ workspaces });
        return true;
      },
      dock: (input) =>
        set((state) => ({
          workspaces: dockChatPane(state.workspaces, { ...input, createSplitId: randomUUID }),
        })),
      resize: (input) =>
        set((state) => {
          const workspaces = resizeChatSplit(state.workspaces, input);
          return workspaces === state.workspaces ? state : { workspaces };
        }),
      closePane: (input) => {
        const result = closeChatPane(get().workspaces, input);
        set({ workspaces: result.workspaces });
        return result.focusTarget;
      },
      removeThread: (target) =>
        set((state) => {
          const workspaces = removeThreadFromWorkspaces(state.workspaces, target);
          return workspaces === state.workspaces ? state : { workspaces };
        }),
      dissolve: (workspaceId) =>
        set((state) => ({
          workspaces: state.workspaces.filter((workspace) => workspace.id !== workspaceId),
        })),
    }),
    {
      name: "t3code:chat-workspaces:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      version: 1,
      partialize: (state) => ({ workspaces: state.workspaces }),
      merge: (persisted, current) => ({
        ...current,
        workspaces: restoreChatWorkspaces(
          (persisted as { workspaces?: unknown } | null)?.workspaces,
        ),
      }),
    },
  ),
);
