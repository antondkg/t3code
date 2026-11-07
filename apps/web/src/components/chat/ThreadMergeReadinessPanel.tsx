import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { visibleThreadPullRequests } from "@t3tools/client-runtime/thread-pull-requests";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  CircleCheckIcon,
  CircleDashedIcon,
  ClipboardCheckIcon,
  CircleXIcon,
  UserRoundCheckIcon,
  UserRoundIcon,
  UserRoundPlusIcon,
  UserRoundXIcon,
  type LucideIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { useProjects, useQuietThreadShell } from "~/state/entities";

import { useStackPendingNumbers } from "../pullRequest/linkedPullRequestDetails";
import { resolveMergeReadiness } from "../pullRequest/pullRequestDeploy.logic";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

const list = (numbers: ReadonlyArray<number>) => numbers.map((number) => `#${number}`).join(" ");

/** Whether every open linked pull request passes its checks and is approved, and which do not. */
export function ThreadMergeReadinessPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const thread = useQuietThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  const projects = useProjects().filter((project) => project.environmentId === props.environmentId);
  const links = visibleThreadPullRequests(thread?.pullRequests ?? []);
  const readinessSignals = useStackPendingNumbers(
    props.environmentId,
    links,
    projects,
    thread?.projectId ?? null,
  );
  const readiness = resolveMergeReadiness(links, readinessSignals);
  if (readiness === null) return null;
  const {
    open,
    failing,
    pending,
    stackPending,
    changesRequested,
    unapproved,
    noReviewer,
    signoff,
  } = readiness;
  const plural = open === 1 ? "" : "s";
  const checksPass = failing.length === 0 && pending.length === 0;
  const approved =
    changesRequested.length === 0 && unapproved.length === 0 && noReviewer.length === 0;
  return (
    <ThreadDetailsSection
      headingId="thread-details-merge-readiness-heading"
      title="Merge readiness"
    >
      <div className="flex flex-col gap-1 px-2.5">
        {checksPass && approved ? (
          <ReadinessLine
            tone="success"
            icon={CircleCheckIcon}
            strong
            text={`Ready: ${open === 1 ? "the PR passes" : `all ${open} PRs pass`} checks and ${open === 1 ? "is" : "are"} approved`}
          />
        ) : (
          <>
            {checksPass ? (
              <ReadinessLine
                tone="success"
                icon={CircleCheckIcon}
                text={
                  stackPending.length > 0
                    ? `CI passed (${open} PR${plural}), ${stackPending.length} waiting on Graphite's stack check`
                    : `All checks passing (${open} PR${plural})`
                }
              />
            ) : null}
            {failing.length > 0 ? (
              <ReadinessLine
                tone="destructive"
                icon={CircleXIcon}
                text={`Checks failing: ${list(failing)}`}
              />
            ) : null}
            {pending.length > 0 ? (
              <ReadinessLine
                tone="muted"
                icon={CircleDashedIcon}
                text={`Checks running: ${list(pending)}`}
              />
            ) : null}
            {approved ? (
              <ReadinessLine
                tone="success"
                icon={UserRoundCheckIcon}
                text={`All approved (${open} PR${plural})`}
              />
            ) : null}
            {changesRequested.length > 0 ? (
              <ReadinessLine
                tone="destructive"
                icon={UserRoundXIcon}
                text={`Changes requested: ${list(changesRequested)}`}
              />
            ) : null}
            {noReviewer.length > 0 ? (
              <ReadinessLine
                tone="destructive"
                icon={UserRoundPlusIcon}
                text={`No reviewer assigned: ${list(noReviewer)}`}
              />
            ) : null}
            {unapproved.length > 0 ? (
              <ReadinessLine
                tone="muted"
                icon={UserRoundIcon}
                text={`Waiting on review: ${list(unapproved)}`}
              />
            ) : null}
          </>
        )}
        {signoff.length > 0 ? (
          <ReadinessLine
            tone="muted"
            icon={ClipboardCheckIcon}
            text={`Reviewer sign-off pending: ${list(signoff)}`}
          />
        ) : null}
      </div>
    </ThreadDetailsSection>
  );
}

function ReadinessLine({
  tone,
  icon: Icon,
  text,
  strong = false,
}: {
  tone: "success" | "destructive" | "muted";
  icon: LucideIcon;
  text: string;
  strong?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-h-6 min-w-0 items-start gap-1.5 text-xs leading-5",
        tone === "success" && "text-success-foreground",
        tone === "destructive" && "text-destructive",
        tone === "muted" && "text-muted-foreground",
        strong && "rounded-md bg-success/10 px-2 py-1 font-medium",
      )}
    >
      <Icon aria-hidden className="mt-0.75 size-3.5 shrink-0" />
      <span className="min-w-0">{text}</span>
    </div>
  );
}
