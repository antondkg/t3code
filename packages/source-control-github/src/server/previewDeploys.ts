import type { PullRequestDeployment, PullRequestDeploymentState } from "@t3tools/contracts";
import { trimOptionalString as trimmed } from "@t3tools/source-control-core/server/pullRequestUtils";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/**
 * A repository whose previews a workflow deploys to a stage named for the pull request, without a
 * GitHub deployment record when the workflow is dispatched by hand. Its runs are the only trace.
 */
export interface PreviewConvention {
  /** The workflow file whose runs deploy previews. */
  readonly workflow: string;
  readonly stage: (number: number) => string;
  readonly url: (stage: string) => string;
}

const CONVENTIONS: Readonly<Record<string, PreviewConvention>> = {
  // Wize Old Man and manual dispatches both run deploy-sandbox.yml as "Deploy Sandbox Stage pr<N>".
  "boardai/vallor": {
    workflow: "deploy-sandbox.yml",
    stage: (number) => `pr${number}`,
    url: (stage) => `https://${stage}.sandbox.vallor.ai`,
  },
};

export function previewConventionFor(repository: string): PreviewConvention | undefined {
  return CONVENTIONS[repository.toLowerCase()];
}

const RawRunsSchema = Schema.Struct({
  workflow_runs: Schema.Array(
    Schema.Struct({
      display_title: Schema.optional(Schema.NullOr(Schema.String)),
      status: Schema.optional(Schema.NullOr(Schema.String)),
      conclusion: Schema.optional(Schema.NullOr(Schema.String)),
      html_url: Schema.optional(Schema.NullOr(Schema.String)),
      head_sha: Schema.optional(Schema.NullOr(Schema.String)),
      updated_at: Schema.String,
    }),
  ),
});
type RawRun = (typeof RawRunsSchema.Type)["workflow_runs"][number];

const decodeRuns = decodeJsonResult(RawRunsSchema);

export function decodePreviewRunsJson(raw: string): Result.Result<ReadonlyArray<RawRun>, unknown> {
  const decoded = decodeRuns(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(decoded.success.workflow_runs)
    : Result.fail(decoded.failure);
}

function runState(run: RawRun): PullRequestDeploymentState | undefined {
  if (run.status !== "completed") return "pending";
  if (run.conclusion === "success") return "success";
  if (run.conclusion === "failure" || run.conclusion === "timed_out") return "failure";
  return undefined;
}

/**
 * The newest deploy of `stage`, and its last successful one when the newest has not succeeded,
 * since that one still serves the preview. Newest first.
 */
export function previewDeploymentsFromRuns(
  runs: ReadonlyArray<RawRun>,
  stage: string,
  url: string,
): ReadonlyArray<PullRequestDeployment> {
  const names = new RegExp(`(?:^|\\s)${stage}(?:\\s|$)`, "u");
  const deployments = runs
    .filter((run) => names.test(run.display_title ?? ""))
    .flatMap((run): ReadonlyArray<PullRequestDeployment> => {
      const state = runState(run);
      return state === undefined
        ? []
        : [
            {
              environment: stage,
              state,
              url,
              logUrl: trimmed(run.html_url),
              commitSha: trimmed(run.head_sha),
              updatedAt: run.updated_at,
            },
          ];
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const [newest] = deployments;
  if (newest === undefined || newest.state === "success") return newest ? [newest] : [];
  const live = deployments.find((deployment) => deployment.state === "success");
  return live ? [newest, live] : [newest];
}
