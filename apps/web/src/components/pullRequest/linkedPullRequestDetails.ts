import { useAtomValue } from "@effect/atom-react";
import { findProjectForChangeRequest } from "@t3tools/client-runtime/change-request-links";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  ProjectId,
  PullRequestDetail,
  PullRequestRef,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { pullRequestEnvironment } from "~/state/pullRequests";

import { ciVerdictOf, summarizeChecks, type PullRequestCiVerdict } from "./pullRequestDeploy.logic";

const MAX_STACK_DETAILS = 20;

type DetailRef = Pick<PullRequestRef, "projectId" | "host" | "repository" | "number">;

// Keyed by the serialized refs, so one stack reads through the same atom on every render.
const detailsAtom = Atom.family((key: string) => {
  const { environmentId, refs } = JSON.parse(key) as {
    environmentId: EnvironmentId;
    refs: ReadonlyArray<DetailRef>;
  };
  return Atom.make((get) =>
    refs.map((ref) =>
      AsyncResult.getOrElse(
        get(pullRequestEnvironment.detail({ environmentId, input: { ...ref, allowStale: false } })),
        () => null,
      ),
    ),
  );
});
const NO_DETAILS = Atom.make((): ReadonlyArray<PullRequestDetail | null> => []);

/** The details of several pull requests, through the same cached reads their rows use. */
function useLinkedPullRequestDetails(
  environmentId: EnvironmentId,
  refs: ReadonlyArray<DetailRef>,
): ReadonlyArray<PullRequestDetail | null> {
  return useAtomValue(
    refs.length === 0
      ? NO_DETAILS
      : detailsAtom(
          JSON.stringify({
            environmentId,
            refs: refs.map(({ projectId, host, repository, number }) => ({
              projectId,
              host,
              repository,
              number,
            })),
          }),
        ),
  );
}

/**
 * What open linked pull requests' details say about merging: CI by required checks, reviewers and
 * sign-offs. Capped, since each one is a detail read.
 */
export function useStackPendingNumbers(
  environmentId: EnvironmentId,
  links: ReadonlyArray<ThreadPullRequestLink>,
  projects: ReadonlyArray<EnvironmentProject>,
  fallbackProjectId: ProjectId | null,
): {
  /** CI by the host's required checks, for those whose details have loaded. */
  readonly ci: ReadonlyMap<number, PullRequestCiVerdict>;
  /** Not yet approved or blocked, and nobody asked to review. */
  readonly noReviewer: ReadonlySet<number>;
  /** A check waits on a reviewer, such as watching a demo. */
  readonly signoff: ReadonlySet<number>;
  readonly details: ReadonlyArray<PullRequestDetail | null>;
} {
  const open = links
    .filter((link) => link.snapshot?.state === "open")
    .slice(0, MAX_STACK_DETAILS)
    .flatMap((link) => {
      const projectId = findProjectForChangeRequest(projects, link)?.id ?? fallbackProjectId;
      return projectId === null
        ? []
        : [
            {
              projectId: projectId as ProjectId,
              host: link.host,
              repository: link.repository,
              number: link.number,
            },
          ];
    });
  const details = useLinkedPullRequestDetails(environmentId, open);
  const summaries = details.flatMap((detail) =>
    detail === null ? [] : [{ detail, summary: summarizeChecks(detail.checks) }],
  );
  const numbersWhere = (
    keep: (entry: (typeof summaries)[number]) => boolean,
  ): ReadonlySet<number> => new Set(summaries.filter(keep).map((entry) => entry.detail.number));
  return {
    details,
    noReviewer: numbersWhere(({ detail }) => detail.reviewers.length === 0),
    ci: new Map(
      summaries.flatMap(({ detail, summary }) => {
        const verdict = ciVerdictOf(summary);
        return verdict === null ? [] : [[detail.number, verdict] as const];
      }),
    ),
    signoff: numbersWhere(({ summary }) => summary.signoffs.length > 0),
  };
}
