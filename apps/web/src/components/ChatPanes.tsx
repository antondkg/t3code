import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";
import {
  type CSSProperties,
  type DragEvent,
  type FocusEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  chatPaneGeometry,
  chatPanesMinSize,
  isChatSplitOpen,
  resolveChatPanes,
  useChatPanesStore,
  type ChatPaneDivider,
  type ChatPaneEdge,
  type ChatPaneRect,
  type ResolvedChatPane,
} from "../chatPanesStore";
import { useComposerDraftStore } from "../composerDraftStore";
import { ComposerHandleContext, useComposerHandleContext } from "../composerHandleContext";
import { useStableCallback } from "../hooks/useStableCallback";
import { observeResize } from "../lib/observeResize";
import { cn } from "../lib/utils";
import {
  buildDraftThreadRouteParams,
  buildThreadRouteParams,
  isThreadRoutePathname,
  type ThreadRouteTarget,
} from "../threadRoutes";
import { CHAT_PANE_DRAG_TYPE, ChatPaneContext, type ChatPaneContextValue } from "./chat/chatPane";
import { ThreadRouteContent } from "./ThreadRouteView";
import { Button } from "./ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";

/** Room for the chat column and the right panel beside it at their 360px minimums. */
const CHAT_PANE_INLINE_RIGHT_PANEL_MIN_WIDTH = 720;
const KEYBOARD_FOCUS = "keyboard";

const FULL_RECT: ChatPaneRect = { x: 0, y: 0, width: 1, height: 1 };
const EDGE_EPSILON = 0.0001;

/**
 * One thread, or several tiled. The route shows the focused pane, so focusing a pane navigates to
 * it; with one pane this is the plain thread view. Panes sit in one container, positioned from the
 * layout tree, so splitting or moving them never remounts a thread.
 */
export function ChatPanes({
  routeTarget,
  background,
}: {
  routeTarget: ThreadRouteTarget;
  background: boolean;
}) {
  const router = useRouter();
  const navigate = useNavigate();
  const layout = useChatPanesStore((state) => state.layout);
  const panes = resolveChatPanes(layout, routeTarget);
  const paneThreadKeys = useComposerDraftStore(
    useShallow((store) => panes.map((pane) => paneThreadKey(pane.target, store))),
  );
  const splitOpen = isChatSplitOpen(layout);
  // Too small for every pane: only the focused one renders, and the split returns with room.
  // The store holds it so notifications treat hidden panes' threads as not visible.
  const fitsSplit = useChatPanesStore((state) => state.splitFits);
  const geometry = chatPaneGeometry(layout);
  const minSize = chatPanesMinSize(layout.root);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const observeContainer = (container: HTMLDivElement) => {
    containerRef.current = container;
    const measure = () =>
      useChatPanesStore
        .getState()
        .setSplitFits(
          container.clientWidth >= minSize.width && container.clientHeight >= minSize.height,
        );
    measure();
    return observeResize(container, measure);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records the routed thread into the pane layout
  useEffect(() => {
    if (!background) useChatPanesStore.getState().commit(routeTarget);
  }, [background, routeTarget]);
  const activePaneId = panes.find((pane) => pane.active)?.id ?? null;
  // Which pane the user is moving into: the one pressed last, or any pane after Tab or F6.
  const focusIntentRef = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window listeners that record whether the user, not code, is moving focus
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      focusIntentRef.current = event.key === "Tab" || event.key === "F6" ? KEYBOARD_FOCUS : null;
    };
    const onPointerDown = (event: PointerEvent) => {
      focusIntentRef.current =
        event.target instanceof Element
          ? (event.target.closest<HTMLElement>("[data-chat-pane]")?.dataset.chatPane ?? null)
          : null;
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases DOM focus left in a pane that the route just unfocused
  useEffect(() => {
    // Focus moved by the sidebar or palette can leave a terminal or composer in the other pane
    // focused, where keystrokes would keep landing.
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement)) return;
    const focusedPane = focused.closest<HTMLElement>("[data-chat-pane]");
    if (focusedPane && focusedPane.dataset.chatPane !== activePaneId) focused.blur();
  }, [activePaneId]);

  const focusPane = (target: ThreadRouteTarget) => {
    // A pointerdown and the focus it causes both land here before the route re-renders.
    if (isRouteFor(router.latestLocation.pathname, target)) return;
    void (target.kind === "server"
      ? navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(target.threadRef),
        })
      : navigate({ to: "/draft/$draftId", params: buildDraftThreadRouteParams(target.draftId) }));
  };
  const closePane = (paneId: string) => {
    const focusTarget = useChatPanesStore.getState().closePane(paneId);
    if (focusTarget) focusPane(focusTarget);
  };
  const dockPane = (paneId: string, targetPaneId: string, edge: ChatPaneEdge) =>
    useChatPanesStore.getState().dock({ routeTarget, paneId, targetPaneId, edge });
  const alone = !splitOpen || !fitsSplit;

  return (
    <SidebarInset
      className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh"
      inert={background}
      data-background-thread-view={background || undefined}
    >
      <div ref={observeContainer} className="relative min-h-0 min-w-0 flex-1">
        {panes.map((pane, index) => {
          if (!fitsSplit && !pane.active) return null;
          const rect = alone ? FULL_RECT : (geometry.panes.get(pane.id) ?? FULL_RECT);
          const top = rect.y < EDGE_EPSILON;
          return (
            <ChatPane
              key={pane.id}
              pane={pane}
              rect={rect}
              inSplit={splitOpen}
              alone={alone}
              first={top && rect.x < EDGE_EPSILON}
              last={top && rect.x + rect.width > 1 - EDGE_EPSILON}
              top={top}
              background={background}
              onFocus={() => focusPane(pane.target)}
              focusIntentRef={focusIntentRef}
              threadKey={paneThreadKeys[index] ?? null}
              hostsHiddenTerminals={alone || index === 0}
              otherPaneThreadKeys={
                alone
                  ? ""
                  : paneThreadKeys
                      .filter((key, keyIndex) => keyIndex !== index && key !== null)
                      .join("\n")
              }
              onClose={() => closePane(pane.id)}
              onDock={(paneId, edge) => dockPane(paneId, pane.id, edge)}
            />
          );
        })}
        {alone
          ? null
          : geometry.dividers.map((divider) => (
              <ChatPaneDividerHandle
                key={divider.splitId}
                divider={divider}
                containerRef={containerRef}
              />
            ))}
      </div>
    </SidebarInset>
  );
}

function paneThreadKey(
  target: ThreadRouteTarget,
  drafts: Pick<ReturnType<typeof useComposerDraftStore.getState>, "getDraftSession">,
): string | null {
  if (target.kind === "server") return scopedThreadKey(target.threadRef);
  const session = drafts.getDraftSession(target.draftId);
  return session ? scopedThreadKey(scopeThreadRef(session.environmentId, session.threadId)) : null;
}

/**
 * Window chrome (traffic lights, native title bar controls) sits only at the window's outer edges,
 * so the inner side of each pane drops the inset that edge reserves.
 */
function windowEdgeStyle(first: boolean, last: boolean): CSSProperties {
  return {
    ...(last
      ? {}
      : { "--workspace-controls-right": "0.75rem", "--workspace-native-controls-inset": "0px" }),
    ...(first ? {} : { "--workspace-titlebar-content-left": "var(--workspace-gutter)" }),
  } as CSSProperties;
}

function isRouteFor(pathname: string, target: ThreadRouteTarget): boolean {
  return target.kind === "server"
    ? isThreadRoutePathname(pathname, target.threadRef)
    : pathname.replace(/\/$/, "") === `/draft/${target.draftId}`;
}

function percent(value: number): string {
  return `${value * 100}%`;
}

/** Drags the boundary of one split, keeping each side at its panes' minimum size. */
function ChatPaneDividerHandle({
  divider,
  containerRef,
}: {
  divider: ChatPaneDivider;
  containerRef: RefObject<HTMLDivElement | null>;
}) {
  const row = divider.direction === "row";
  const { area, ratio } = divider;
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (container === null || event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    // Capture keeps moves coming while the pointer crosses a pane's embedded browser.
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {}
    const bounds = container.getBoundingClientRect();
    const start = row ? bounds.left + area.x * bounds.width : bounds.top + area.y * bounds.height;
    const size = row ? area.width * bounds.width : area.height * bounds.height;
    const minFirst = (row ? divider.minFirst.width : divider.minFirst.height) / size;
    const maxFirst = 1 - (row ? divider.minSecond.width : divider.minSecond.height) / size;
    let frame = 0;
    const move = (moveEvent: PointerEvent) => {
      const next = ((row ? moveEvent.clientX : moveEvent.clientY) - start) / size;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() =>
        useChatPanesStore
          .getState()
          .resize(
            divider.splitId,
            Math.min(Math.max(next, minFirst), Math.max(minFirst, maxFirst)),
          ),
      );
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
  const style: CSSProperties = row
    ? {
        left: percent(area.x + area.width * ratio),
        top: percent(area.y),
        height: percent(area.height),
      }
    : {
        top: percent(area.y + area.height * ratio),
        left: percent(area.x),
        width: percent(area.width),
      };
  return (
    <div
      role="separator"
      aria-orientation={row ? "vertical" : "horizontal"}
      aria-label="Resize panes"
      className={cn(
        "group/divider absolute z-40 flex items-center justify-center",
        row ? "w-2 -translate-x-1/2 cursor-col-resize" : "h-2 -translate-y-1/2 cursor-row-resize",
      )}
      style={style}
      onPointerDown={onPointerDown}
      onDoubleClick={() => useChatPanesStore.getState().resize(divider.splitId, 0.5)}
    >
      <div
        aria-hidden
        className={cn(
          "bg-border group-hover/divider:bg-primary/60",
          row ? "h-full w-px" : "h-px w-full",
        )}
      />
    </div>
  );
}

function dropEdge(event: DragEvent<HTMLElement>): ChatPaneEdge {
  const bounds = event.currentTarget.getBoundingClientRect();
  const x = (event.clientX - bounds.left) / bounds.width;
  const y = (event.clientY - bounds.top) / bounds.height;
  const distances: ReadonlyArray<readonly [ChatPaneEdge, number]> = [
    ["left", x],
    ["right", 1 - x],
    ["top", y],
    ["bottom", 1 - y],
  ];
  return distances.reduce((nearest, entry) => (entry[1] < nearest[1] ? entry : nearest))[0];
}

const DROP_PREVIEW: Record<ChatPaneEdge, string> = {
  left: "inset-y-0 left-0 w-1/2",
  right: "inset-y-0 right-0 w-1/2",
  top: "inset-x-0 top-0 h-1/2",
  bottom: "inset-x-0 bottom-0 h-1/2",
};

function ChatPane({
  pane,
  rect,
  inSplit,
  alone,
  first,
  last,
  top,
  background,
  threadKey,
  hostsHiddenTerminals,
  otherPaneThreadKeys,
  onClose,
  onDock,
  onFocus,
  focusIntentRef,
}: {
  pane: ResolvedChatPane;
  rect: ChatPaneRect;
  /** False for the one pane outside a split, which behaves like a plain thread view. */
  inSplit: boolean;
  /** The only pane rendered, outside a split or because the window cannot fit it. */
  alone: boolean;
  /** Touches the window's left edge. */
  first: boolean;
  /** Touches the window's right edge. */
  last: boolean;
  /** Touches the window's top edge, where the title bar is a window drag region. */
  top: boolean;
  background: boolean;
  threadKey: string | null;
  hostsHiddenTerminals: boolean;
  /** Newline-joined, so an unchanged set keeps the context value and spares ChatView a render. */
  otherPaneThreadKeys: string;
  onClose: () => void;
  /** Moves the dragged pane to an edge of this one. */
  onDock: (paneId: string, edge: ChatPaneEdge) => void;
  onFocus: () => void;
  focusIntentRef: RefObject<string | null>;
}) {
  const [dropPreview, setDropPreview] = useState<ChatPaneEdge | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a drag cancelled or dropped elsewhere fires no dragleave here
  useEffect(() => {
    if (dropPreview === null) return;
    const clear = () => setDropPreview(null);
    window.addEventListener("dragend", clear, true);
    window.addEventListener("drop", clear, true);
    return () => {
      window.removeEventListener("dragend", clear, true);
      window.removeEventListener("drop", clear, true);
    };
  }, [dropPreview]);
  const acceptsDrag = (event: DragEvent<HTMLDivElement>) =>
    !alone && event.dataTransfer.types.includes(CHAT_PANE_DRAG_TYPE);
  const composerHandle = useComposerHandleContext();
  const close = useStableCallback(onClose);
  // Code can focus a pane after it lost focus (an async editor focus, a dialog restoring focus);
  // that is not the user switching panes, so the focused pane's composer takes it instead.
  const onFocusIn = (event: FocusEvent<HTMLDivElement>) => {
    const intent = focusIntentRef.current;
    if (intent === KEYBOARD_FOCUS || intent === pane.id) {
      onFocus();
      return;
    }
    if (event.target instanceof HTMLElement) event.target.blur();
    composerHandle?.current?.focusAtEnd();
  };
  const passive = !pane.active;
  const [narrow, setNarrow] = useState(false);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const observePane = (node: HTMLDivElement) => {
    setElement(node);
    const measure = () => setNarrow(node.clientWidth < CHAT_PANE_INLINE_RIGHT_PANEL_MIN_WIDTH);
    measure();
    return observeResize(node, measure);
  };
  const chatPaneValue: ChatPaneContextValue = {
    element: alone ? null : element,
    narrow: !alone && narrow,
    hostsHiddenTerminals,
    otherPaneThreadKeys: new Set(otherPaneThreadKeys === "" ? [] : otherPaneThreadKeys.split("\n")),
    close,
    paneId: pane.id,
  };
  return (
    <div
      ref={observePane}
      className={cn(
        "absolute flex min-h-0 min-w-0 flex-col",
        // Layout containment anchors the header's fixed title bar controls to this pane.
        !alone && "[contain:layout]",
        !alone &&
          !passive &&
          "before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:z-30 before:h-0.5 before:bg-primary/60",
        !alone && passive && "[&_[data-chat-header]]:opacity-60",
      )}
      style={{
        ...windowEdgeStyle(first, last),
        left: percent(rect.x),
        top: percent(rect.y),
        width: percent(rect.width),
        height: percent(rect.height),
      }}
      data-chat-pane={pane.id}
      data-chat-pane-below-top={(!alone && !top) || undefined}
      data-chat-pane-narrow={(!alone && narrow) || undefined}
      data-chat-pane-thread={threadKey ?? undefined}
      data-background-thread-view={passive || undefined}
      onPointerDownCapture={passive ? onFocus : undefined}
      onFocusCapture={passive ? onFocusIn : undefined}
      onDragOverCapture={(event) => {
        if (!acceptsDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDropPreview(dropEdge(event));
      }}
      onDragLeave={(event) => {
        if (
          !(
            event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)
          )
        )
          setDropPreview(null);
      }}
      onDropCapture={(event) => {
        if (!acceptsDrag(event)) return;
        event.preventDefault();
        setDropPreview(null);
        const paneId = event.dataTransfer.getData(CHAT_PANE_DRAG_TYPE);
        if (paneId !== "" && paneId !== pane.id) onDock(paneId, dropEdge(event));
      }}
    >
      {/* The app-wide composer handle belongs to the focused pane's composer. */}
      <ComposerHandleContext value={passive ? null : composerHandle}>
        <ChatPaneContext value={inSplit ? chatPaneValue : null}>
          <ThreadRouteContent
            target={pane.target}
            background={background}
            passive={passive}
            unavailable={inSplit ? <UnavailablePane onClose={close} /> : null}
            onMissing={inSplit ? close : undefined}
          />
        </ChatPaneContext>
      </ComposerHandleContext>
      {dropPreview === null ? null : (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute z-50 border-2 border-primary bg-primary/10",
            DROP_PREVIEW[dropPreview],
          )}
        />
      )}
    </div>
  );
}

function UnavailablePane({ onClose }: { onClose: () => void }) {
  return (
    <Empty size="compact">
      <EmptyHeader>
        <EmptyTitle>Thread unavailable</EmptyTitle>
        <EmptyDescription>It was deleted, archived, or is hidden by a filter.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" size="sm" onClick={onClose}>
          Close pane
        </Button>
      </EmptyContent>
    </Empty>
  );
}
