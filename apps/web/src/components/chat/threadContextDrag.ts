import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { type RefObject, useEffect, useEffectEvent, useSyncExternalStore } from "react";

export const THREAD_CONTEXT_DROP_EVENT = "t3-thread-context-drop";

export function useThreadContextDrop(
  targetRef: RefObject<EventTarget | null>,
  environmentId: EnvironmentId,
  targetKey: string,
  onDrop: (refs: ReadonlyArray<ScopedThreadRef>, isActive: () => boolean) => void,
) {
  const handleDrop = useEffectEvent(onDrop);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes the target element to thread-context drop events and marks old drops inactive
  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    let active = true;
    const listener = (event: Event) =>
      handleDrop((event as CustomEvent<ReadonlyArray<ScopedThreadRef>>).detail, () => active);
    target.addEventListener(THREAD_CONTEXT_DROP_EVENT, listener);
    return () => {
      active = false;
      target.removeEventListener(THREAD_CONTEXT_DROP_EVENT, listener);
    };
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A new environment or target ends the previous listener, so isActive reports false to drops still in flight for it.
    environmentId,
    targetKey,
    targetRef,
  ]);
}

const DROP_TARGET_ATTRIBUTE = "data-thread-context-drop";
const DROP_OVER_ATTRIBUTE = "data-thread-context-over";
// A chat pane, which opens a dropped thread beside its own. A composer inside it is nearer to the
// pointer, so a drop there still adds the thread as context.
const PANE_TARGET_ATTRIBUTE = "data-thread-pane-drop";
const TARGET_SELECTOR = `[${DROP_TARGET_ATTRIBUTE}],[${PANE_TARGET_ATTRIBUTE}]`;
const THREAD_PANE_OVER_EVENT = "t3-thread-pane-over";
const THREAD_PANE_DROP_EVENT = "t3-thread-pane-drop";

interface DragPoint {
  readonly x: number;
  readonly y: number;
}

interface ThreadPaneDrop {
  readonly threads: ReadonlyArray<ScopedThreadRef>;
  readonly point: DragPoint;
}

const paneTarget = (target: HTMLElement | null) =>
  target?.hasAttribute(PANE_TARGET_ATTRIBUTE) === true ? target : null;

/** A pane that hears a thread dragged over it (null once it leaves) and dropped on it. */
export function useThreadPaneDrop(
  target: HTMLElement | null,
  handlers: {
    readonly onOver: (point: DragPoint | null) => void;
    readonly onDrop: (drop: ThreadPaneDrop) => void;
  },
) {
  const onOver = useEffectEvent(handlers.onOver);
  const onDrop = useEffectEvent(handlers.onDrop);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes the pane element to sidebar thread drags
  useEffect(() => {
    if (!target) return;
    const over = (event: Event) => onOver((event as CustomEvent<DragPoint | null>).detail);
    const drop = (event: Event) => onDrop((event as CustomEvent<ThreadPaneDrop>).detail);
    target.addEventListener(THREAD_PANE_OVER_EVENT, over);
    target.addEventListener(THREAD_PANE_DROP_EVENT, drop);
    return () => {
      target.removeEventListener(THREAD_PANE_OVER_EVENT, over);
      target.removeEventListener(THREAD_PANE_DROP_EVENT, drop);
    };
  }, [target]);
}

export function threadPaneDropTargetProps(enabled: boolean) {
  return enabled ? ({ [PANE_TARGET_ATTRIBUTE]: "true" } as const) : {};
}

export interface ThreadContextDragGhost {
  readonly x: number;
  readonly y: number;
  readonly title: string;
  readonly count: number;
}

let ghost: ThreadContextDragGhost | null = null;
const listeners = new Set<() => void>();

function setGhost(next: ThreadContextDragGhost | null) {
  if (ghost === next) return;
  ghost = next;
  for (const listener of listeners) listener();
}

export function useThreadContextDragGhost(): ThreadContextDragGhost | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => ghost,
    () => null,
  );
}

let overTarget: HTMLElement | null = null;

function findDropTarget(point: { x: number; y: number }): HTMLElement | null {
  return document.elementFromPoint(point.x, point.y)?.closest<HTMLElement>(TARGET_SELECTOR) ?? null;
}

export function moveThreadContextDrag(
  point: { x: number; y: number },
  label: { title: string; count: number },
) {
  const target = findDropTarget(point);
  if (target !== overTarget) {
    leaveOverTarget();
    if (paneTarget(target) === null) target?.setAttribute(DROP_OVER_ATTRIBUTE, "true");
    overTarget = target;
  }
  paneTarget(target)?.dispatchEvent(new CustomEvent(THREAD_PANE_OVER_EVENT, { detail: point }));
  setGhost({ x: point.x, y: point.y, ...label });
}

function leaveOverTarget() {
  const pane = paneTarget(overTarget);
  if (pane) pane.dispatchEvent(new CustomEvent(THREAD_PANE_OVER_EVENT, { detail: null }));
  else overTarget?.removeAttribute(DROP_OVER_ATTRIBUTE);
}

export function endThreadContextDrag() {
  leaveOverTarget();
  overTarget = null;
  setGhost(null);
}

export function dropThreadContext(
  point: { x: number; y: number },
  threads: ReadonlyArray<ScopedThreadRef>,
): boolean {
  const target = findDropTarget(point);
  if (!target || threads.length === 0) return false;
  target.dispatchEvent(
    paneTarget(target)
      ? new CustomEvent<ThreadPaneDrop>(THREAD_PANE_DROP_EVENT, { detail: { threads, point } })
      : new CustomEvent(THREAD_CONTEXT_DROP_EVENT, { detail: threads }),
  );
  return true;
}

export function threadContextDropTargetProps() {
  return { [DROP_TARGET_ATTRIBUTE]: "true" } as const;
}
