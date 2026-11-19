import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  CommandId,
  type EnvironmentId,
  type ThreadId,
  type ThreadWidget,
} from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { randomUUID } from "../../lib/utils";
import { useQuietThreadProjection } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { HtmlRenderFrame } from "./HtmlRenderFrame";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

function WidgetCard({
  widget,
  environmentId,
  threadId,
}: {
  widget: ThreadWidget;
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const [expanded, setExpanded] = useState(true);
  const dispatch = useAtomCommand(orchestrationEnvironment.v2.dispatchCommand);
  const canRemove = useAtomValue(
    orchestrationEnvironment.v2.dispatchCommand.permissionAtom(environmentId),
  );
  const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-border/65">
      <div className="flex items-center gap-1 px-2 py-1">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <Chevron className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate">{widget.title}</span>
        </button>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={`Remove ${widget.title} widget`}
                size="icon-xs"
                variant="ghost"
                disabled={!canRemove}
                onClick={() =>
                  void dispatch({
                    environmentId,
                    input: {
                      type: "thread.metadata.update",
                      threadId,
                      commandId: CommandId.make(randomUUID()),
                      widget: { id: widget.id, remove: true },
                    },
                  })
                }
              />
            }
          >
            <XIcon className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="top">Remove widget</TooltipPopup>
        </Tooltip>
      </div>
      {expanded ? (
        <div className="px-2 pb-2">
          <HtmlRenderFrame
            key={widget.attachmentId}
            environmentId={environmentId}
            htmlRender={widget}
            widgetData={widget.data}
            threadRef={scopeThreadRef(environmentId, threadId)}
          />
        </div>
      ) : null}
    </div>
  );
}

export function ThreadWidgetsPanel(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const widgets =
    useQuietThreadProjection(scopeThreadRef(props.environmentId, props.threadId))?.projection.thread
      .widgets ?? [];
  if (widgets.length === 0) return null;
  return (
    <ThreadDetailsSection headingId={`thread-widgets-${props.threadId}`} title="Live widgets">
      <div className="space-y-2">
        {widgets.map((widget) => (
          <WidgetCard key={widget.id} widget={widget} {...props} />
        ))}
      </div>
    </ThreadDetailsSection>
  );
}
