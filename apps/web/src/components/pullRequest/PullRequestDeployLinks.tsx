import type { PullRequestDetail, ScopedThreadRef } from "@t3tools/contracts";
import { CircleDashedIcon, GlobeIcon, LayersIcon, TriangleAlertIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";

import { useOpenLink } from "~/browser/useOpenLink";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  describePullRequestDeploy,
  resolvePullRequestDeployStatus,
  type PullRequestDeployPresentation,
} from "./pullRequestDeploy.logic";

export function PullRequestDeployIcon({ icon }: { icon: PullRequestDeployPresentation["icon"] }) {
  const Icon =
    icon === "preview" ? GlobeIcon : icon === "failed" ? TriangleAlertIcon : CircleDashedIcon;
  return <Icon aria-hidden className="size-3 shrink-0" />;
}

/** A pull request's preview deploy and Graphite page, for the pull request panel. */
export function PullRequestDeployLinks({
  detail,
  threadRef,
}: {
  detail: PullRequestDetail;
  threadRef: ScopedThreadRef | null;
}) {
  const openLink = useOpenLink(threadRef);
  const deploy = resolvePullRequestDeployStatus(detail);
  const shown = deploy === null ? null : describePullRequestDeploy(deploy, detail.headSha ?? null);
  const graphiteUrl = detail.graphiteUrl ?? null;
  if (shown === null && graphiteUrl === null) return null;
  const open = (url: string, event: ReactMouseEvent<HTMLElement>) =>
    void openLink(url, { event, preferApp: true }).catch((error: unknown) => console.error(error));
  return (
    <>
      {shown === null ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="xs"
                variant={shown.tone === "destructive" ? "ghost-destructive" : "ghost-muted"}
                aria-disabled={shown.url === null || undefined}
                onClick={(event) => {
                  if (shown.url !== null) open(shown.url, event);
                }}
              />
            }
          >
            <PullRequestDeployIcon icon={shown.icon} />
            {shown.label}
          </TooltipTrigger>
          <TooltipPopup side="bottom">{shown.tooltip}</TooltipPopup>
        </Tooltip>
      )}
      {graphiteUrl === null ? null : (
        <Button size="xs" variant="ghost-muted" onClick={(event) => open(graphiteUrl, event)}>
          <LayersIcon aria-hidden className="size-3 shrink-0" />
          Graphite
        </Button>
      )}
    </>
  );
}
