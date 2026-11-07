import { findProjectOnChangeRequestHost } from "@t3tools/client-runtime/change-request-links";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { selectEnvironmentQueryData } from "@t3tools/client-runtime/state/runtime";
import {
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/client-runtime/thread-pull-requests";
import type {
  EnvironmentId,
  ProjectId,
  PullRequestDeployment,
  ScopedThreadRef,
  ThreadId,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import { GlobeIcon, ScrollTextIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { cn, isMacPlatform } from "~/lib/utils";
import { useProjects, useQuietThreadShell } from "~/state/entities";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQueryRefresh, useEnvironmentQuerySelector } from "~/state/query";

import { resolvePullRequestDeployStatus } from "../pullRequest/pullRequestDeploy.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";

// Each row reads its pull request's detail, which the pull request rows above usually hold.
const MAX_PREVIEW_ROWS = 8;

/** Preview deploys of the thread's open linked pull requests. Hidden while none has one. */
export function ThreadPreviewsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const thread = useQuietThreadShell(threadRef);
  const links = visibleThreadPullRequests(thread?.pullRequests ?? [])
    .filter((link) => link.snapshot?.state === "open")
    .slice(0, MAX_PREVIEW_ROWS);
  if (links.length === 0) return null;
  return (
    <ThreadDetailsSection headingId="thread-details-previews-heading" title="Previews">
      {/* Every row can render nothing, which empties this and hides the section. */}
      <div>
        {links.map((link) => (
          <ThreadPreviewRow key={threadPullRequestKeyOf(link)} threadRef={threadRef} link={link} />
        ))}
      </div>
    </ThreadDetailsSection>
  );
}

function ThreadPreviewRow({
  threadRef,
  link,
}: {
  threadRef: ScopedThreadRef;
  link: ThreadPullRequestLink;
}) {
  const projects = useProjects();
  const parsed = sourceControlClients.parseChangeRequestUrl(link.url)?.link;
  const project =
    parsed === undefined
      ? null
      : (findProjectOnChangeRequestHost(
          projects.filter((candidate) => candidate.environmentId === threadRef.environmentId),
          parsed,
        ) ?? null);
  const detailAtom =
    project === null
      ? null
      : pullRequestEnvironment.detail({
          environmentId: threadRef.environmentId,
          input: {
            projectId: project.id as ProjectId,
            host: link.host,
            repository: link.repository,
            number: link.number,
            allowStale: false,
          },
        });
  const detail = useEnvironmentQuerySelector(detailAtom, selectEnvironmentQueryData);
  const detailQuery = useEnvironmentQueryRefresh(detailAtom);
  const deploy = detail === null ? null : resolvePullRequestDeployStatus(detail);
  useLiveRefresh(
    () => {
      if (!detailQuery.isPending()) detailQuery.refresh();
    },
    {
      enabled: deploy?.kind === "deploying",
      key: `thread-preview:${threadPullRequestKeyOf(link)}`,
      intervalMs: 30_000,
    },
  );
  const openLink = useOpenLink(threadRef);
  if (detail === null || deploy === null || deploy.kind === "skipped") return null;
  // A preview keeps serving its last good deploy while a newer one runs or fails.
  const live =
    (detail.deployments ?? []).find(
      (deployment) => deployment.state === "success" && deployment.url !== null,
    ) ?? null;
  const url = live?.url ?? (deploy.kind === "deployed" ? deploy.url : null);
  const target =
    url ?? (deploy.kind === "deploying" || deploy.kind === "failed" ? deploy.detailsUrl : null);
  // The newest run for this preview, which a failed or running redeploy is.
  const newest = (detail.deployments ?? [])
    .filter((deployment) => deployment.url !== null && deployment.environment === live?.environment)
    .reduce<PullRequestDeployment | null>(
      (latest, deployment) =>
        latest === null || deployment.updatedAt > latest.updatedAt ? deployment : latest,
      null,
    );
  const runUrl =
    newest?.logUrl ??
    (deploy.kind === "deploying" || deploy.kind === "failed" ? deploy.detailsUrl : null);
  const failed = deploy.kind === "failed" || (deploy.kind === "deployed" && deploy.latestFailed);
  const state =
    deploy.kind === "deploying"
      ? "Deploying"
      : deploy.kind === "failed"
        ? "Deploy failed"
        : deploy.kind === "deployed" && deploy.latestFailed
          ? "Live, latest deploy failed"
          : "Live";
  const externalClickLabel = isMacPlatform(navigator.platform) ? "⌘-click" : "Ctrl-click";
  const openRun = (event: ReactMouseEvent<HTMLElement>) => {
    if (runUrl === null) return;
    void openLink(runUrl, { event }).catch((error: unknown) => console.error(error));
  };
  return (
    <div className="group relative flex items-center rounded-lg">
      <Tooltip>
        <TooltipTrigger
          delay={200}
          render={
            <ThreadDetailsControl
              size="sm"
              variant="ghost"
              part="row"
              multiline
              aria-disabled={target === null || undefined}
              onClick={(event) => {
                if (target === null) return;
                void openLink(target, { event, preferApp: url !== null }).catch((error: unknown) =>
                  console.error(error),
                );
              }}
            />
          }
        >
          <GlobeIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          {/* The end padding keeps text clear of the deploy run button. */}
          <span className={cn("flex min-w-0 flex-1 flex-col gap-0.5", runUrl !== null && "pe-6")}>
            <span className="truncate text-sm font-medium leading-4 text-foreground/85">
              {url === null ? `#${link.number}` : new URL(url).host}
            </span>
            <span className="truncate text-2xs font-normal leading-4 text-muted-foreground">
              #{link.number} · {state}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipPopup side="left">
          {url === null
            ? "Open the deploy run."
            : `Open in the browser panel. ${externalClickLabel} for your browser.`}
        </TooltipPopup>
      </Tooltip>
      {runUrl === null ? null : (
        <div
          className={cn(
            "absolute right-1 top-1/2 -translate-y-1/2",
            !failed &&
              "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100",
          )}
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <ThreadDetailsControl
                  size="icon-xs"
                  variant="ghost"
                  part="icon"
                  {...(failed ? { tone: "destructive" as const } : {})}
                  aria-label={`Open the latest deploy run for #${link.number}`}
                  onClick={(event) => openRun(event)}
                />
              }
            >
              <ScrollTextIcon aria-hidden className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="left">
              {failed ? "The latest deploy failed. Open its run." : "Open the latest deploy run"}
            </TooltipPopup>
          </Tooltip>
        </div>
      )}
    </div>
  );
}
