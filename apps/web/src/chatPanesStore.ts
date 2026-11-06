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

/**
 * More than one pane means split. The route always shows the focused pane's thread, so a pane's
 * stored target is what it shows while unfocused and what focusing it navigates to.
 */
export interface ChatPanesLayout {
  readonly root: ChatPaneNode | null;
  readonly activePaneId: string | null;
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

/** The one pane's id before any split; a split keeps it for the routed pane, so it stays mounted. */
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

export function isChatSplitOpen(layout: ChatPanesLayout): boolean {
  return layout.root?.kind === "split";
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

/**
 * What each pane shows for the current route. A route that lands on another pane's thread
 * focuses that pane; any other route retargets the focused pane.
 */
export function resolveChatPanes(
  layout: ChatPanesLayout,
  routeTarget: ThreadRouteTarget,
): ReadonlyArray<ResolvedChatPane> {
  const panes = chatPaneList(layout);
  if (!isChatSplitOpen(layout)) {
    return [{ id: panes[0]?.id ?? PRIMARY_CHAT_PANE_ID, target: routeTarget, active: true }];
  }
  const routeKey = chatPaneTargetKey(routeTarget);
  const routedPane = panes.find((pane) => chatPaneTargetKey(pane.target) === routeKey);
  const activePaneId =
    routedPane?.id ?? panes.find((pane) => pane.id === layout.activePaneId)?.id ?? panes[0]!.id;
  return panes.map((pane) =>
    pane.id === activePaneId
      ? { id: pane.id, target: routeTarget, active: true }
      : { ...pane, active: false },
  );
}

/**
 * Threads the unfocused panes show for this route; a draft pane has no thread until it sends.
 * None while the area is too small for the split, since only the focused pane renders then.
 */
export function backgroundChatPaneThreadRefs(
  layout: ChatPanesLayout,
  routeTarget: ThreadRouteTarget | null,
  splitFits: boolean,
): ReadonlyArray<ScopedThreadRef> {
  if (routeTarget === null || !splitFits) return [];
  return resolveChatPanes(layout, routeTarget).flatMap((pane) =>
    !pane.active && pane.target.kind === "server" ? [pane.target.threadRef] : [],
  );
}

/** Records what `resolveChatPanes` showed, so unfocused panes keep their threads. */
export function commitChatPanes(
  layout: ChatPanesLayout,
  routeTarget: ThreadRouteTarget,
): ChatPanesLayout {
  if (!isChatSplitOpen(layout) || layout.root === null) return layout;
  const resolved = resolveChatPanes(layout, routeTarget);
  const active = resolved.find((pane) => pane.active);
  if (!active) return layout;
  const targets = new Map(resolved.map((pane) => [pane.id, pane.target]));
  const root = mapPanes(layout.root, (pane) => {
    const target = targets.get(pane.id) ?? pane.target;
    return chatPaneTargetKey(target) === chatPaneTargetKey(pane.target)
      ? { kind: "pane", ...pane }
      : { kind: "pane", id: pane.id, target };
  });
  const unchanged =
    active.id === layout.activePaneId &&
    chatPaneList({ root, activePaneId: null }).every(
      (pane, index) =>
        chatPaneTargetKey(pane.target) === chatPaneTargetKey(chatPaneList(layout)[index]!.target),
    );
  return unchanged ? layout : { root, activePaneId: active.id };
}

/** The routed pane as a one-pane tree, for opening the first split. */
function withRoutedRoot(layout: ChatPanesLayout, routeTarget: ThreadRouteTarget) {
  if (isChatSplitOpen(layout) && layout.root !== null) {
    return { root: layout.root, activePaneId: layout.activePaneId ?? chatPaneList(layout)[0]!.id };
  }
  const id = chatPaneList(layout)[0]?.id ?? PRIMARY_CHAT_PANE_ID;
  return { root: { kind: "pane", id, target: routeTarget } as ChatPaneNode, activePaneId: id };
}

/**
 * Shows `target` on `edge` of the focused pane. A thread is shown in one pane at most, so one
 * already visible, or a full layout, leaves the layout as it is; navigating then focuses or
 * retargets as usual.
 */
export function openChatSplit(
  layout: ChatPanesLayout,
  input: {
    readonly routeTarget: ThreadRouteTarget;
    readonly target: ThreadRouteTarget;
    readonly edge?: ChatPaneEdge;
    readonly createPaneId: () => string;
  },
): ChatPanesLayout {
  const targetKey = chatPaneTargetKey(input.target);
  const current = commitChatPanes(layout, input.routeTarget);
  if (chatPaneTargetKey(input.routeTarget) === targetKey) return current;
  // A single pane's stored target can be stale; only a split shows its panes' targets.
  if (
    isChatSplitOpen(current) &&
    chatPaneList(current).some((pane) => chatPaneTargetKey(pane.target) === targetKey)
  ) {
    return current;
  }
  if (chatPaneList(current).length >= MAX_CHAT_PANES) return current;
  const base = withRoutedRoot(current, input.routeTarget);
  const added = { id: input.createPaneId(), target: input.target };
  return {
    root: splitAt(base.root, base.activePaneId, added, input.edge ?? "right", input.createPaneId()),
    activePaneId: base.activePaneId,
  };
}

/** Moves a pane to `edge` of another pane. Both keep their ids, so neither remounts. */
export function dockChatPane(
  layout: ChatPanesLayout,
  input: {
    readonly routeTarget: ThreadRouteTarget;
    readonly paneId: string;
    readonly targetPaneId: string;
    readonly edge: ChatPaneEdge;
    readonly createSplitId: () => string;
  },
): ChatPanesLayout {
  const current = commitChatPanes(layout, input.routeTarget);
  if (input.paneId === input.targetPaneId || current.root === null) return current;
  const panes = chatPaneList(current);
  const moving = panes.find((pane) => pane.id === input.paneId);
  if (!moving || !panes.some((pane) => pane.id === input.targetPaneId)) return current;
  const remaining = removePane(current.root, input.paneId);
  if (remaining === null) return current;
  return {
    ...current,
    root: splitAt(remaining, input.targetPaneId, moving, input.edge, input.createSplitId()),
  };
}

/**
 * Removes a pane. Closing the focused pane focuses the one taking its place; `focusTarget` is
 * the thread the route should move to then, and null when the route needs no change.
 */
export function closeChatPane(
  layout: ChatPanesLayout,
  paneId: string,
): { readonly layout: ChatPanesLayout; readonly focusTarget: ThreadRouteTarget | null } {
  if (layout.root === null || !chatPaneList(layout).some((pane) => pane.id === paneId)) {
    return { layout, focusTarget: null };
  }
  const successor = successorPane(layout.root, paneId);
  const root = removePane(layout.root, paneId);
  const closedActive = layout.activePaneId === paneId;
  const activePaneId = closedActive ? (successor?.id ?? null) : layout.activePaneId;
  // The remaining panes keep their ids, so they stay mounted.
  return {
    layout: { root, activePaneId },
    focusTarget: closedActive ? (successor?.target ?? null) : null,
  };
}

export function resizeChatSplit(
  layout: ChatPanesLayout,
  splitId: string,
  ratio: number,
): ChatPanesLayout {
  const resize = (node: ChatPaneNode): ChatPaneNode => {
    if (node.kind === "pane") return node;
    if (node.id === splitId) return node.ratio === ratio ? node : { ...node, ratio };
    const first = resize(node.children[0]);
    const second = resize(node.children[1]);
    return first === node.children[0] && second === node.children[1]
      ? node
      : { ...node, children: [first, second] };
  };
  if (layout.root === null) return layout;
  const root = resize(layout.root);
  return root === layout.root ? layout : { ...layout, root };
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

export function restoreChatPanesLayout(value: unknown): ChatPanesLayout {
  if (typeof value !== "object" || value === null) return SINGLE_CHAT_PANE_LAYOUT;
  const { root, activePaneId } = value as Record<string, unknown>;
  if (!isNode(root) || root.kind !== "split") return SINGLE_CHAT_PANE_LAYOUT;
  const layout: ChatPanesLayout = { root, activePaneId: null };
  const panes = chatPaneList(layout);
  if (panes.length > MAX_CHAT_PANES) return SINGLE_CHAT_PANE_LAYOUT;
  return {
    root,
    activePaneId: panes.some((pane) => pane.id === activePaneId)
      ? (activePaneId as string)
      : panes[0]!.id,
  };
}

interface ChatPanesStoreState {
  readonly layout: ChatPanesLayout;
  /** Whether the chat area is large enough to render every pane of the split. */
  readonly splitFits: boolean;
  readonly setSplitFits: (splitFits: boolean) => void;
  readonly commit: (routeTarget: ThreadRouteTarget) => void;
  readonly openSplit: (input: {
    readonly routeTarget: ThreadRouteTarget;
    readonly target: ThreadRouteTarget;
    readonly edge?: ChatPaneEdge;
  }) => void;
  readonly dock: (input: {
    readonly routeTarget: ThreadRouteTarget;
    readonly paneId: string;
    readonly targetPaneId: string;
    readonly edge: ChatPaneEdge;
  }) => void;
  readonly resize: (splitId: string, ratio: number) => void;
  /** Returns the thread to navigate to when the focused pane closed. */
  readonly closePane: (paneId: string) => ThreadRouteTarget | null;
}

export const useChatPanesStore = create<ChatPanesStoreState>()(
  persist(
    (set, get) => ({
      layout: SINGLE_CHAT_PANE_LAYOUT,
      splitFits: true,
      setSplitFits: (splitFits) =>
        set((state) => (state.splitFits === splitFits ? state : { splitFits })),
      commit: (routeTarget) =>
        set((state) => {
          const layout = commitChatPanes(state.layout, routeTarget);
          return layout === state.layout ? state : { layout };
        }),
      openSplit: (input) =>
        set((state) => ({
          layout: openChatSplit(state.layout, { ...input, createPaneId: randomUUID }),
        })),
      dock: (input) =>
        set((state) => ({
          layout: dockChatPane(state.layout, { ...input, createSplitId: randomUUID }),
        })),
      resize: (splitId, ratio) =>
        set((state) => {
          const layout = resizeChatSplit(state.layout, splitId, ratio);
          return layout === state.layout ? state : { layout };
        }),
      closePane: (paneId) => {
        const result = closeChatPane(get().layout, paneId);
        set({ layout: result.layout });
        return result.focusTarget;
      },
    }),
    {
      name: "t3code:chat-panes:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      version: 1,
      partialize: (state) => ({ layout: state.layout }),
      merge: (persisted, current) => ({
        ...current,
        layout: restoreChatPanesLayout((persisted as { layout?: unknown } | null)?.layout),
      }),
    },
  ),
);
