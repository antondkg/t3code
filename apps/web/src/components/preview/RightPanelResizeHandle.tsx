import type { ComponentProps } from "react";
import type { ResizableWidthHandlers } from "~/hooks/useResizableWidth";
import { cn } from "~/lib/utils";

interface Props extends Pick<
  ComponentProps<"div">,
  "tabIndex" | "onKeyDown" | "aria-valuenow" | "aria-valuemin" | "aria-valuemax"
> {
  handlers: ResizableWidthHandlers;
  className?: string;
  label?: string;
  /** "horizontal" sits on the top edge of a panel docked below the chat. */
  orientation?: "vertical" | "horizontal";
}

export function RightPanelResizeHandle({
  handlers,
  className,
  label,
  orientation = "vertical",
  ...separatorProps
}: Props) {
  const horizontal = orientation === "horizontal";
  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      {...separatorProps}
      className={cn(
        "group absolute z-40 touch-none select-none",
        horizontal
          ? "inset-x-0 top-0 h-1 cursor-row-resize any-pointer-coarse:-top-2 any-pointer-coarse:h-4"
          : "inset-y-0 left-0 w-1 cursor-col-resize any-pointer-coarse:-left-2 any-pointer-coarse:w-4",
        className,
      )}
      {...handlers}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute bg-transparent transition-colors duration-150 group-hover:bg-border group-focus-visible:bg-primary/60 group-active:bg-primary/60",
          horizontal
            ? "inset-x-0 top-0 h-px -translate-y-1/2 any-pointer-coarse:top-2"
            : "inset-y-0 left-0 w-px -translate-x-1/2 any-pointer-coarse:left-2",
        )}
      />
    </div>
  );
}
