import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  backgroundChatPaneThreadRefs,
  CHAT_PANE_MIN_HEIGHT,
  CHAT_PANE_MIN_WIDTH,
  chatPaneGeometry,
  chatPaneList,
  chatPanesMinSize,
  closeChatPane,
  commitChatPanes,
  dockChatPane,
  dropThreadOnChatPane,
  MAX_CHAT_PANES,
  openChatSplit,
  removeThreadFromWorkspaces,
  resizeChatSplit,
  resolveChatPanes,
  restoreChatWorkspaces,
  type ChatPaneEdge,
  type ChatWorkspace,
} from "./chatPanesStore";
import { DraftId } from "./composerDraftStore";
import type { ThreadRouteTarget } from "./threadRoutes";

const threadRef = (id: string) => scopeThreadRef(EnvironmentId.make("env"), ThreadId.make(id));
const thread = (id: string): ThreadRouteTarget => ({ kind: "server", threadRef: threadRef(id) });
const draft = (id: string): ThreadRouteTarget => ({ kind: "draft", draftId: DraftId.make(id) });

function ids(prefix = "id") {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

function open(
  workspaces: ReadonlyArray<ChatWorkspace>,
  route: ThreadRouteTarget,
  target: ThreadRouteTarget,
  createId = ids(),
  edge: ChatPaneEdge = "right",
) {
  return openChatSplit(workspaces, { routeTarget: route, target, edge, createId });
}

const label = (target: ThreadRouteTarget) =>
  target.kind === "server" ? target.threadRef.threadId : target.draftId;

const shown = (workspaces: ReadonlyArray<ChatWorkspace>, route: ThreadRouteTarget) =>
  resolveChatPanes(workspaces, route).map((pane) => ({
    id: pane.id,
    target: label(pane.target),
    active: pane.active,
  }));

describe("chat workspaces", () => {
  it("opening a split from a lone thread makes a workspace that keeps its pane id", () => {
    const workspaces = open([], thread("a"), thread("b"));
    expect(workspaces).toHaveLength(1);
    expect(shown(workspaces, thread("a"))).toEqual([
      { id: "primary", target: "a", active: true },
      { id: "id-1", target: "b", active: false },
    ]);
    expect(shown(workspaces, thread("b"))).toEqual([
      { id: "primary", target: "a", active: false },
      { id: "id-1", target: "b", active: true },
    ]);
  });

  it("shows a thread outside every workspace alone and leaves the workspaces as they were", () => {
    const workspaces = open([], thread("a"), thread("b"));
    expect(shown(workspaces, thread("c"))).toEqual([{ id: "primary", target: "c", active: true }]);
    expect(commitChatPanes(workspaces, thread("c"))).toBe(workspaces);
    expect(shown(workspaces, thread("a")).map((pane) => pane.target)).toEqual(["a", "b"]);
  });

  it("counts other panes' threads as visible only inside their workspace and while it fits", () => {
    const workspaces = open([], thread("a"), thread("b"));
    expect(backgroundChatPaneThreadRefs(workspaces, thread("a"), true)).toEqual([threadRef("b")]);
    expect(backgroundChatPaneThreadRefs(workspaces, thread("a"), false)).toEqual([]);
    expect(backgroundChatPaneThreadRefs(workspaces, thread("c"), true)).toEqual([]);
  });

  it("remembers the focused pane so the workspace reopens there", () => {
    const workspaces = open([], thread("a"), thread("b"));
    const focusedB = commitChatPanes(workspaces, thread("b"));
    expect(focusedB[0]!.activePaneId).toBe("id-1");
    expect(commitChatPanes(focusedB, thread("b"))).toBe(focusedB);
  });

  it("keeps a draft pane addressable by its draft id", () => {
    const workspaces = open([], thread("a"), draft("d"));
    expect(shown(workspaces, draft("d"))).toEqual([
      { id: "primary", target: "a", active: false },
      { id: "id-1", target: "d", active: true },
    ]);
  });

  it("never shows one thread in two panes or two workspaces", () => {
    expect(open([], thread("a"), thread("a"))).toEqual([]);
    const first = open([], thread("a"), thread("b"));
    expect(open(first, thread("a"), thread("b"))).toBe(first);
    // b moves from the a+b workspace to a new one with c; a alone is no longer a workspace.
    const moved = open(first, thread("c"), thread("b"), ids("second"));
    expect(moved).toHaveLength(1);
    expect(chatPaneList(moved[0]!).map((pane) => label(pane.target))).toEqual(["c", "b"]);
  });

  it("adds panes beside the focused one up to the limit", () => {
    const createId = ids();
    let workspaces: ReadonlyArray<ChatWorkspace> = [];
    for (const id of ["b", "c", "d", "e", "f", "g"]) {
      workspaces = open(workspaces, thread("a"), thread(id), createId);
    }
    expect(chatPaneList(workspaces[0]!)).toHaveLength(MAX_CHAT_PANES);
    // The focused pane splits each time, so the newest pane sits right beside it.
    expect(shown(workspaces, thread("a")).map((pane) => pane.target)).toEqual([
      "a",
      "f",
      "e",
      "d",
      "c",
      "b",
    ]);
  });

  it("stacks a pane below the focused one and sizes the area for both", () => {
    const [workspace] = open([], thread("a"), thread("b"), ids(), "bottom");
    const { panes } = chatPaneGeometry(workspace!);
    expect(panes.get("primary")).toEqual({ x: 0, y: 0, width: 1, height: 0.5 });
    expect(panes.get("id-1")).toEqual({ x: 0, y: 0.5, width: 1, height: 0.5 });
    expect(chatPanesMinSize(workspace!.root)).toEqual({
      width: CHAT_PANE_MIN_WIDTH,
      height: CHAT_PANE_MIN_HEIGHT * 2,
    });
  });

  it("moves a pane to another pane's edge without changing either pane's id", () => {
    const createId = ids();
    const three = open(
      open([], thread("a"), thread("b"), createId),
      thread("a"),
      thread("c"),
      createId,
    );
    const workspaceId = three[0]!.id;
    const moved = dockChatPane(three, {
      workspaceId,
      paneId: "id-1",
      targetPaneId: "primary",
      edge: "top",
      createSplitId: () => "split-moved",
    });
    const { panes } = chatPaneGeometry(moved[0]!);
    expect(panes.get("id-1")).toMatchObject({ y: 0, height: 0.5 });
    expect(panes.get("primary")).toMatchObject({ y: 0.5, height: 0.5 });
    expect(
      chatPaneList(moved[0]!)
        .map((pane) => pane.id)
        .sort(),
    ).toEqual(
      chatPaneList(three[0]!)
        .map((pane) => pane.id)
        .sort(),
    );
  });

  it("drops a sidebar thread beside the pane it lands on, or moves its pane there", () => {
    const createId = ids();
    const pair = open([], thread("a"), thread("b"), createId);
    const drop = (
      workspaces: ReadonlyArray<ChatWorkspace>,
      paneTarget: ThreadRouteTarget,
      target: ThreadRouteTarget,
      edge: ChatPaneEdge,
    ) => dropThreadOnChatPane(workspaces, { paneTarget, target, edge, createId });

    // Onto the unfocused pane b: c opens to b's left, not beside the focused a.
    const three = drop(pair, thread("b"), thread("c"), "left");
    const opened = chatPaneGeometry(three[0]!).panes;
    const c = chatPaneList(three[0]!).find((pane) => label(pane.target) === "c")!;
    expect(opened.get(c.id)).toMatchObject({ x: 0.5, width: 0.25 });
    expect(opened.get("id-1")).toMatchObject({ x: 0.75, width: 0.25 });

    // A thread already in the workspace keeps its pane id and moves below b.
    const moved = drop(three, thread("b"), thread("a"), "bottom");
    expect(chatPaneGeometry(moved[0]!).panes.get("primary")).toMatchObject({ y: 0.5 });
    expect(chatPaneList(moved[0]!)).toHaveLength(3);

    expect(drop(moved, thread("b"), thread("b"), "left")).toBe(moved);
  });

  it("closing a focused pane focuses its neighbour, and the last two dissolve the workspace", () => {
    const createId = ids();
    const three = commitChatPanes(
      open(
        open([], thread("a"), thread("b"), createId),
        thread("b"),
        thread("c"),
        createId,
        "bottom",
      ),
      thread("c"),
    );
    const workspaceId = three[0]!.id;
    const cPane = shown(three, thread("c")).find((pane) => pane.active)!;
    const closed = closeChatPane(three, { workspaceId, paneId: cPane.id });
    expect(closed.focusTarget).toEqual(thread("b"));
    expect(chatPaneList(closed.workspaces[0]!).map((pane) => label(pane.target))).toEqual([
      "a",
      "b",
    ]);
    expect(removeThreadFromWorkspaces(closed.workspaces, thread("a"))).toEqual([]);
  });

  it("resizes one split and restores only well-formed, non-overlapping workspaces", () => {
    const workspaces = open([], thread("a"), thread("b"));
    const [workspace] = workspaces;
    const resized = resizeChatSplit(workspaces, {
      workspaceId: workspace!.id,
      splitId: workspace!.root.id,
      ratio: 0.7,
    });
    expect(chatPaneGeometry(resized[0]!).panes.get("primary")?.width).toBeCloseTo(0.7);
    const saved = JSON.parse(JSON.stringify(resized)) as unknown[];
    expect(restoreChatWorkspaces(saved)).toEqual(resized);
    const overlapping = open([], thread("c"), thread("a"), ids("other"));
    expect(restoreChatWorkspaces([...saved, ...overlapping])).toEqual(resized);
    expect(restoreChatWorkspaces([{ id: "x", root: { kind: "split", id: "s" } }])).toEqual([]);
  });
});
