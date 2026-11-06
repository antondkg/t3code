import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { LayoutGridIcon } from "lucide-react";
import { memo, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from "react";

import { chatPaneList, useChatPanesStore, type ChatWorkspace } from "../../chatPanesStore";
import { cn } from "~/lib/utils";
import { useThreadShell } from "../../state/entities";
import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "../Sidebar.logic";

const STATUS_LABEL: Partial<Record<SidebarThreadStatus, string>> = {
  approval: "Needs approval",
  input: "Needs input",
  request: "Needs you",
  preparing: "Setting up",
  working: "Working",
  failed: "Failed",
};

type Position = { readonly x: number; readonly y: number };

function keyActivates(event: ReactKeyboardEvent, activate: () => void, menu: () => void) {
  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
    event.preventDefault();
    menu();
  } else if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    activate();
  }
}

const WorkspaceThreadRow = memo(function WorkspaceThreadRow(props: {
  threadRef: ScopedThreadRef;
  isActive: boolean;
  onOpen: (threadRef: ScopedThreadRef) => void;
  onContextMenu: (threadRef: ScopedThreadRef, position: Position) => void;
}) {
  const { threadRef, onOpen, onContextMenu } = props;
  const thread = useThreadShell(threadRef);
  const status = thread ? resolveSidebarThreadStatus(thread) : "ready";
  const statusLabel = STATUS_LABEL[status] ?? null;
  const openMenu = (position: Position) => onContextMenu(threadRef, position);
  return (
    <li className="list-none">
      <div
        role="button"
        tabIndex={0}
        aria-current={props.isActive ? "page" : undefined}
        data-sidebar-row={`workspace-thread:${scopedThreadKey(threadRef)}`}
        className={cn(
          "flex h-7 w-full cursor-pointer items-center gap-2 rounded-md pr-2 pl-7 text-left text-sm outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.isActive
            ? "bg-sidebar-row-active text-foreground"
            : "text-foreground/85 hover:bg-sidebar-row-hover",
        )}
        onClick={() => onOpen(threadRef)}
        onContextMenu={(event: MouseEvent) => {
          event.preventDefault();
          openMenu({ x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) =>
          keyActivates(
            event,
            () => onOpen(threadRef),
            () => {
              const rect = event.currentTarget.getBoundingClientRect();
              openMenu({ x: rect.left, y: rect.bottom });
            },
          )
        }
      >
        <span className="min-w-0 flex-1 truncate">{thread?.title ?? "Thread"}</span>
        {statusLabel ? (
          <span
            className={cn(
              "shrink-0 text-2xs font-medium",
              status === "working" || status === "preparing"
                ? "text-info-foreground"
                : status === "failed"
                  ? "text-error-foreground"
                  : "text-warning-foreground",
            )}
          >
            {statusLabel}
          </span>
        ) : null}
      </div>
    </li>
  );
});

/**
 * Tiled chats, under Pinned. A workspace's threads list here instead of in their sections;
 * opening one shows the whole workspace focused on it.
 */
export const SidebarWorkspaceBlock = memo(function SidebarWorkspaceBlock(props: {
  routeThreadKey: string | null;
  onOpenWorkspace: (workspaceId: string) => void;
  onOpenThread: (threadRef: ScopedThreadRef) => void;
  onWorkspaceContextMenu: (workspace: ChatWorkspace, position: Position) => void;
  onThreadContextMenu: (threadRef: ScopedThreadRef, position: Position) => void;
}) {
  const workspaces = useChatPanesStore((state) => state.workspaces);
  if (workspaces.length === 0) return null;
  return (
    <>
      {workspaces.map((workspace, index) => {
        const threadRefs = chatPaneList(workspace).flatMap((pane) =>
          pane.target.kind === "server" ? [pane.target.threadRef] : [],
        );
        const containsRoute = threadRefs.some(
          (threadRef) => scopedThreadKey(threadRef) === props.routeThreadKey,
        );
        const name = workspaces.length === 1 ? "Workspace" : `Workspace ${index + 1}`;
        const openMenu = (position: Position) => props.onWorkspaceContextMenu(workspace, position);
        return (
          <li key={workspace.id} className="list-none py-0.5" data-testid="sidebar-workspace">
            <div
              role="button"
              tabIndex={0}
              data-sidebar-row={`workspace:${workspace.id}`}
              aria-label={`${name}, ${chatPaneList(workspace).length} chats`}
              aria-current={containsRoute ? "page" : undefined}
              className={cn(
                "flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-xs font-medium outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                containsRoute
                  ? "text-foreground"
                  : "text-secondary-label hover:bg-sidebar-row-hover",
              )}
              onClick={() => props.onOpenWorkspace(workspace.id)}
              onContextMenu={(event: MouseEvent) => {
                event.preventDefault();
                openMenu({ x: event.clientX, y: event.clientY });
              }}
              onKeyDown={(event) =>
                keyActivates(
                  event,
                  () => props.onOpenWorkspace(workspace.id),
                  () => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    openMenu({ x: rect.left, y: rect.bottom });
                  },
                )
              }
            >
              <LayoutGridIcon aria-hidden className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{name}</span>
              <span className="shrink-0 text-2xs text-muted-foreground">
                {chatPaneList(workspace).length}
              </span>
            </div>
            <ul>
              {threadRefs.map((threadRef) => (
                <WorkspaceThreadRow
                  key={scopedThreadKey(threadRef)}
                  threadRef={threadRef}
                  isActive={scopedThreadKey(threadRef) === props.routeThreadKey}
                  onOpen={props.onOpenThread}
                  onContextMenu={props.onThreadContextMenu}
                />
              ))}
            </ul>
          </li>
        );
      })}
      <li aria-hidden className="mx-2.5 my-1.5 h-px list-none bg-sidebar-border/60" />
    </>
  );
});
