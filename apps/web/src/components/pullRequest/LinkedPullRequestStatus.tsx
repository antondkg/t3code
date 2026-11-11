import type {
  PullRequestActor,
  PullRequestCheck,
  PullRequestDetail,
  ScopedThreadRef,
  ThreadPullRequestSnapshot,
} from "@t3tools/contracts";
import {
  ArrowUpRightIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  ClipboardCheckIcon,
  FilmIcon,
  GlobeIcon,
  LayersIcon,
  UserRoundCheckIcon,
  UserRoundIcon,
  UserRoundPlusIcon,
  UserRoundXIcon,
  type LucideIcon,
} from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { cn } from "~/lib/utils";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PullRequestActorAvatar } from "./pullRequestPresentation";
import {
  resolvePullRequestDeployStatus,
  signoffLabel,
  summarizeChecks,
} from "./pullRequestDeploy.logic";

type Tone = "success" | "destructive" | "muted" | "attention";

const TONE: Record<Tone, string> = {
  success: "text-success-foreground",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
  attention: "text-warning-foreground",
};

const firstName = (actor: PullRequestActor) => actor.name?.trim().split(/\s+/u)[0] || actor.login;

function Status({
  tone,
  icon: Icon,
  tooltip,
  children,
}: {
  tone: Tone;
  icon: LucideIcon;
  tooltip?: string | undefined;
  children: ReactNode;
}) {
  const body = (
    <span className={cn("inline-flex shrink-0 items-center gap-1", TONE[tone])}>
      <Icon aria-hidden className="size-3 shrink-0" />
      {children}
    </span>
  );
  if (tooltip === undefined) return body;
  return (
    <Tooltip>
      <TooltipTrigger render={body} />
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

const Dot = () => <span className="shrink-0 text-muted-foreground/50">·</span>;

/** Opens a link from inside the row's own link without opening the pull request. */
function useRowLink(threadRef: ScopedThreadRef) {
  const openLink = useOpenLink(threadRef);
  return (url: string, preferApp: boolean) => (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    void openLink(url, { event, preferApp }).catch((error: unknown) => console.error(error));
  };
}

function RowLink({
  onClick,
  tooltip,
  children,
}: {
  onClick: (event: ReactMouseEvent<HTMLElement>) => void;
  tooltip?: string;
  children: ReactNode;
}) {
  const link = (
    <span
      role="link"
      tabIndex={0}
      className="inline-flex shrink-0 cursor-pointer items-center gap-0.5 hover:text-foreground"
      onClick={onClick}
    >
      {children}
      <ArrowUpRightIcon aria-hidden className="size-2.5" />
    </span>
  );
  if (tooltip === undefined) return link;
  return (
    <Tooltip>
      <TooltipTrigger render={link} />
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

/** Checks that wait on a reviewer, such as watching a demo video and adding its label. */
function SignoffStatus({
  checks,
  rowLink,
}: {
  checks: ReadonlyArray<PullRequestCheck>;
  rowLink: ReturnType<typeof useRowLink>;
}) {
  return checks.map((check) => {
    const demo = /\bdemo\b/iu.test(check.name);
    const label = signoffLabel(check);
    const tooltip = [
      check.description,
      label ? `A reviewer adds ${label} once they have checked it.` : null,
      check.required === false ? "Does not block merging." : null,
    ]
      .filter(Boolean)
      .join(" ");
    const body = (
      <Status tone="attention" icon={demo ? FilmIcon : ClipboardCheckIcon}>
        {demo ? "demo to watch" : `${check.name} needs sign-off`}
      </Status>
    );
    return (
      <span key={check.name} className="inline-flex shrink-0 items-center gap-1.5">
        <Dot />
        {check.url ? (
          <RowLink onClick={rowLink(check.url, false)} tooltip={tooltip}>
            {body}
          </RowLink>
        ) : (
          <Tooltip>
            <TooltipTrigger render={body} />
            <TooltipPopup side="top">{tooltip}</TooltipPopup>
          </Tooltip>
        )}
      </span>
    );
  });
}

function ChecksStatus({
  detail,
  snapshot,
}: {
  detail: PullRequestDetail | null;
  snapshot: ThreadPullRequestSnapshot | null;
}) {
  if (detail === null) {
    const state = snapshot?.checksState;
    if (state === "passing")
      return (
        <Status tone="success" icon={CircleCheckIcon}>
          CI passed
        </Status>
      );
    if (state === "failing")
      return (
        <Status tone="destructive" icon={CircleXIcon}>
          CI failing
        </Status>
      );
    if (state === "pending")
      return (
        <Status tone="muted" icon={CircleDashedIcon}>
          CI running
        </Status>
      );
    return null;
  }
  const summary = summarizeChecks(detail.checks);
  switch (summary.kind) {
    case "none":
      return null;
    case "failing": {
      const required = summary.failing.every((check) => check.required === true);
      return (
        <Status
          tone="destructive"
          icon={CircleXIcon}
          tooltip={required ? "Required to merge" : undefined}
        >
          {summary.failing.length}
          {required ? " required" : ""} {summary.failing.length === 1 ? "check" : "checks"} failing
        </Status>
      );
    }
    case "running":
      return (
        <Status tone="muted" icon={CircleDashedIcon}>
          CI running {summary.passed}/{summary.total}
        </Status>
      );
    case "stack-pending":
      return (
        <>
          <Status tone="success" icon={CircleCheckIcon}>
            CI passed
          </Status>
          <Dot />
          <Status
            tone="muted"
            icon={LayersIcon}
            tooltip="Graphite's mergeability check waits for the layers below to merge."
          >
            stack check pending
          </Status>
        </>
      );
    case "passing":
      return (
        <Status
          tone="success"
          icon={CircleCheckIcon}
          tooltip={
            summary.optionalFailing.length > 0 || detail.checks.some((check) => check.required)
              ? "Every check required to merge passed"
              : `${summary.passed}/${summary.total} checks passed`
          }
        >
          CI passed
        </Status>
      );
  }
}

/** Failed checks the host does not require, such as an advisory E2E notice. */
function OptionalFailingStatus({ checks }: { checks: ReadonlyArray<PullRequestCheck> }) {
  if (checks.length === 0) return null;
  return (
    <>
      <Dot />
      <Status
        tone="muted"
        icon={CircleXIcon}
        tooltip={`Not required to merge: ${checks.map((check) => check.name).join(", ")}`}
      >
        {checks.length === 1 ? `${checks[0]?.name} failed` : `${checks.length} optional failed`}
      </Status>
    </>
  );
}

function People({ actors }: { actors: ReadonlyArray<PullRequestActor> }) {
  return (
    <>
      <span className="inline-flex shrink-0 -space-x-1">
        {actors.slice(0, 3).map((actor) => (
          <PullRequestActorAvatar
            key={actor.login}
            actor={actor}
            className="size-3.5 ring-1 ring-background"
          />
        ))}
      </span>
      <span className="truncate">{actors.map(firstName).join(", ")}</span>
    </>
  );
}

function ReviewStatus({
  snapshot,
  detail,
}: {
  snapshot: ThreadPullRequestSnapshot | null;
  detail: PullRequestDetail | null;
}) {
  const reviews = snapshot?.latestReviews ?? [];
  const requested = reviews.filter((review) => review.outcome === "changes-requested");
  if (snapshot?.reviewDecision === "changes-requested" || requested.length > 0) {
    return (
      <Status tone="destructive" icon={UserRoundXIcon}>
        {requested.length > 0 ? (
          <People actors={requested.map((review) => review.reviewer)} />
        ) : null}
        changes requested
      </Status>
    );
  }
  const approved = reviews.filter((review) => review.outcome === "approved");
  if (approved.length > 0 || snapshot?.reviewDecision === "approved") {
    return (
      <Status tone="success" icon={UserRoundCheckIcon}>
        {approved.length > 0 ? (
          <People actors={approved.map((review) => review.reviewer)} />
        ) : (
          "approved"
        )}
      </Status>
    );
  }
  if (detail === null) {
    return (
      <Status tone="muted" icon={UserRoundIcon}>
        needs review
      </Status>
    );
  }
  // Requested reviewers drop off the host's list once they review, so these have not yet.
  if (detail.reviewers.length > 0) {
    return (
      <Status tone="muted" icon={UserRoundIcon} tooltip="Asked to review, not reviewed yet">
        waiting on <People actors={detail.reviewers} />
      </Status>
    );
  }
  return (
    <Status
      tone="destructive"
      icon={UserRoundPlusIcon}
      tooltip="Nobody has been asked to review. Request a reviewer from the pull request."
    >
      no reviewer assigned
    </Status>
  );
}

/**
 * A linked pull request's checks, approval, deploy and links on one line, which replaces its
 * branches; the row's tooltip and the pull request itself still name those.
 */
export function LinkedPullRequestStatusLine({
  threadRef,
  url,
  detail,
  snapshot,
}: {
  threadRef: ScopedThreadRef;
  url: string;
  detail: PullRequestDetail | null;
  snapshot: ThreadPullRequestSnapshot | null;
}) {
  const rowLink = useRowLink(threadRef);
  const links = (
    <span className="ml-auto flex shrink-0 items-center gap-2 ps-2">
      <RowLink onClick={rowLink(url, true)}>PR</RowLink>
      {detail?.graphiteUrl ? (
        <RowLink onClick={rowLink(detail.graphiteUrl, true)}>Graphite</RowLink>
      ) : null}
    </span>
  );
  // Checks and approval no longer matter once a pull request merged or closed.
  if (snapshot !== null && snapshot.state !== "open") {
    return (
      <>
        <span className="shrink-0 capitalize">{snapshot.state}</span>
        {links}
      </>
    );
  }
  const deploy = detail === null ? null : resolvePullRequestDeployStatus(detail);
  const withLogs = (url: string | null, body: ReactNode, tooltip: string) =>
    url === null ? (
      body
    ) : (
      <RowLink onClick={rowLink(url, false)} tooltip={tooltip}>
        {body}
      </RowLink>
    );
  const deployStatus =
    deploy === null || deploy.kind === "skipped" ? null : deploy.kind === "deployed" ? (
      <RowLink onClick={rowLink(deploy.url, true)} tooltip={deploy.url}>
        <Status tone={deploy.latestFailed ? "destructive" : "success"} icon={GlobeIcon}>
          {deploy.environment} {deploy.latestFailed ? "live, redeploy failed" : "live"}
        </Status>
      </RowLink>
    ) : deploy.kind === "deploying" ? (
      withLogs(
        deploy.detailsUrl,
        <Status tone="attention" icon={CircleDashedIcon}>
          deploying{deploy.environment ? ` ${deploy.environment}` : " preview"}
        </Status>,
        "This pull request's preview is deploying. Open the deploy run.",
      )
    ) : (
      withLogs(
        deploy.detailsUrl,
        <Status tone="destructive" icon={GlobeIcon}>
          {deploy.step} failed
        </Status>,
        "The preview deploy failed. Open its logs.",
      )
    );
  const summary = detail === null ? null : summarizeChecks(detail.checks);
  return (
    <>
      <ChecksStatus detail={detail} snapshot={snapshot} />
      <OptionalFailingStatus checks={summary?.optionalFailing ?? []} />
      {snapshot !== null ? (
        <>
          <Dot />
          <ReviewStatus snapshot={snapshot} detail={detail} />
        </>
      ) : null}
      <SignoffStatus checks={summary?.signoffs ?? []} rowLink={rowLink} />
      {deployStatus === null ? null : (
        <>
          <Dot />
          {deployStatus}
        </>
      )}
      {links}
    </>
  );
}

/** The failing checks of a pull request by name, with a link to each one's run. */
export function LinkedPullRequestFailingChecks({
  threadRef,
  detail,
}: {
  threadRef: ScopedThreadRef;
  detail: PullRequestDetail | null;
}) {
  const rowLink = useRowLink(threadRef);
  if (detail === null) return null;
  const summary = summarizeChecks(detail.checks);
  if (summary.kind !== "failing") return null;
  return (
    <>
      {summary.failing.slice(0, 2).map((check) => (
        <span
          key={check.name}
          className="flex min-w-0 items-center gap-1 text-2xs text-destructive"
        >
          <CircleXIcon aria-hidden className="size-3 shrink-0" />
          <span className="shrink-0 font-medium">{check.name}</span>
          {check.description ? (
            <span className="min-w-0 truncate text-muted-foreground">{check.description}</span>
          ) : null}
          {check.url ? (
            <span className="ml-auto shrink-0 ps-2 font-medium">
              <RowLink onClick={rowLink(check.url, false)}>Logs</RowLink>
            </span>
          ) : null}
        </span>
      ))}
    </>
  );
}
