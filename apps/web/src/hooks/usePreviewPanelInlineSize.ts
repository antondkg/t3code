import { useState } from "react";

import { type ResizableWidthHandlers, useResizableWidth } from "./useResizableWidth";
import { observeResize } from "../lib/observeResize";
import type { RightPanelDock } from "../rightPanelDock";

export interface PreviewPanelInlineSize {
  /** A height when the panel is docked below the chat. */
  readonly width: number;
  readonly handlers: ResizableWidthHandlers;
  /** Ref-callback body for the panel host: measures the row the panel shares. */
  readonly observeRow: (host: HTMLElement) => () => void;
}

const PREVIEW_PANEL_WIDTH_STORAGE_KEY = "t3code:preview-panel-width";
const PREVIEW_PANEL_MIN_WIDTH = 360;
const PREVIEW_PANEL_MAX_WIDTH_FRACTION = 0.7;
/** Below this, the sibling chat column's composer overflows. */
const SIBLING_COLUMN_MIN_WIDTH = 360;
const PREVIEW_PANEL_DEFAULT_WIDTH = 540;
const BOTTOM_PANEL_HEIGHT_STORAGE_KEY = "t3code:preview-panel-height";
const BOTTOM_PANEL_MIN_HEIGHT = 200;
/** Leaves the chat column room for its header and composer. */
const SIBLING_COLUMN_MIN_HEIGHT = 240;
const BOTTOM_PANEL_DEFAULT_HEIGHT = 360;

export function usePreviewPanelInlineSize(
  options: {
    readonly enabled?: boolean | undefined;
    readonly widthStorageKey?: string | undefined;
    readonly defaultWidth?: number | undefined;
    readonly container?: HTMLElement | null | undefined;
    readonly dock?: RightPanelDock | undefined;
  } = {},
): PreviewPanelInlineSize {
  const enabled = options.enabled ?? true;
  const container = options.container;
  const bottom = options.dock === "bottom";
  const viewportSize = () => {
    if (typeof window === "undefined") return bottom ? 800 : 1280;
    return bottom ? window.innerHeight : window.innerWidth;
  };
  const capFor = (viewport: number, row?: HTMLElement | null) =>
    bottom
      ? getBottomPanelMaxHeight(viewport, row?.clientHeight)
      : getPreviewPanelMaxWidth(viewport, row?.clientWidth);
  const [maxSize, setMaxSize] = useState(() => ({ bottom, max: capFor(viewportSize()) }));
  if (maxSize.bottom !== bottom) setMaxSize({ bottom, max: capFor(viewportSize()) });
  const maxWidth = maxSize.max;
  const { width, handlers } = useResizableWidth(
    bottom
      ? {
          storageKey: BOTTOM_PANEL_HEIGHT_STORAGE_KEY,
          defaultWidth: BOTTOM_PANEL_DEFAULT_HEIGHT,
          minWidth: BOTTOM_PANEL_MIN_HEIGHT,
          maxWidth,
          edge: "top",
        }
      : {
          storageKey: options.widthStorageKey ?? PREVIEW_PANEL_WIDTH_STORAGE_KEY,
          defaultWidth: options.defaultWidth ?? PREVIEW_PANEL_DEFAULT_WIDTH,
          minWidth: PREVIEW_PANEL_MIN_WIDTH,
          maxWidth,
          edge: "left",
        },
  );
  const observeRow = (host: HTMLElement) => {
    const row = container ?? (enabled ? host.parentElement : null) ?? null;
    // Ref callbacks run before paint, so the width is clamped without an over-wide
    // flash on mount. Only the derived cap is stored: the row resizes every frame
    // of a sidebar drag, but an unchanged cap skips re-rendering the owner.
    const measure = () => {
      setMaxSize({ bottom, max: capFor(viewportSize(), row) });
    };
    measure();
    let frame = 0;
    const onResize = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    window.addEventListener("resize", onResize);
    const stopObserving = row ? observeResize(row, measure) : undefined;
    return () => {
      window.removeEventListener("resize", onResize);
      if (frame !== 0) window.cancelAnimationFrame(frame);
      stopObserving?.();
    };
  };
  return { width, handlers, observeRow };
}

function getPreviewPanelMaxWidth(viewportWidth: number, containerWidth?: number): number {
  const fractionCap = Math.floor(viewportWidth * PREVIEW_PANEL_MAX_WIDTH_FRACTION);
  const containerCap =
    containerWidth === undefined ? Infinity : Math.floor(containerWidth) - SIBLING_COLUMN_MIN_WIDTH;
  // Keep max >= min; an inverted clamp would overwrite the saved width on drag end.
  return Math.max(PREVIEW_PANEL_MIN_WIDTH, Math.min(fractionCap, containerCap));
}

function getBottomPanelMaxHeight(viewportHeight: number, containerHeight?: number): number {
  const fractionCap = Math.floor(viewportHeight * PREVIEW_PANEL_MAX_WIDTH_FRACTION);
  const containerCap =
    containerHeight === undefined
      ? Infinity
      : Math.floor(containerHeight) - SIBLING_COLUMN_MIN_HEIGHT;
  return Math.max(BOTTOM_PANEL_MIN_HEIGHT, Math.min(fractionCap, containerCap));
}
