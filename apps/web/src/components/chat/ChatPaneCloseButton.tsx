import { GripVerticalIcon, XIcon } from "lucide-react";
import { use } from "react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { CHAT_PANE_DRAG_TYPE, ChatPaneContext } from "./chatPane";

/**
 * Moves this split pane by dragging onto another pane's edge, or closes it; renders nothing
 * outside a split. A closed pane's thread keeps running.
 */
export function ChatPaneCloseButton() {
  const chatPane = use(ChatPaneContext);
  if (chatPane === null) return null;
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label="Move pane"
              size="icon-xs"
              variant="ghost-muted"
              className="cursor-grab active:cursor-grabbing"
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(CHAT_PANE_DRAG_TYPE, chatPane.paneId);
                event.dataTransfer.effectAllowed = "move";
              }}
            />
          }
        >
          <GripVerticalIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Drag onto another pane's edge to move it</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label="Close pane"
              size="icon-xs"
              variant="ghost-muted"
              onClick={chatPane.close}
            />
          }
        >
          <XIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Close pane</TooltipPopup>
      </Tooltip>
    </>
  );
}
