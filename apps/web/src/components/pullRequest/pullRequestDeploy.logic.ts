import type {
  PullRequestCheck,
  PullRequestDeployment,
  PullRequestLabel,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import {
  threadPullRequestKeyOf,
  type ThreadPullRequestChain,
} from "@t3tools/client-runtime/thread-pull-requests";

export type PullRequestDeployStatus =
  | {
      readonly kind: "deploying";
      readonly detailsUrl: string | null;
    }
  | {
      readonly kind: "failed";
      readonly step: string;
      readonly detailsUrl: string | null;
    }
  | {
      readonly kind: "deployed";
      readonly environment: string;
      readonly url: string;
      readonly commitSha: string | null;
      readonly tests: "passing" | "failing" | "pending" | null;
      /** A later deploy failed; this one still serves the preview. */
      readonly latestFailed: boolean;
    }
  | { readonly kind: "skipped"; readonly label: string };

// Deploy steps lead their check name (`deploy-sandbox`) or name a preview (`deploy-preview`);
// gates that only mention deploys, such as `require-deploy-tag`, are not steps.
const DEPLOY_STEP = /^deploy\b|deploy[-_ ]preview/iu;
// A test run such as `run-e2e-tests`; gates such as `E2E requirement` only say one is owed.
const END_TO_END = /\be2e[-_ ]tests?\b|end[-_ ]to[-_ ]end[-_ ]tests?\b/iu;
// A workflow can pass its deploy check without deploying; its title then says it skipped.
const SKIPPED_STEP = /\bskip(?:ped)?\b/iu;
const SKIPPED_LABEL = /^deploy(?:ment)?[-_ ]skipped$/iu;
const PENDING = new Set<PullRequestCheck["status"]>(["pending", "action-required"]);
const FAILED = new Set<PullRequestCheck["status"]>(["failure", "cancelled"]);

function rollup(checks: ReadonlyArray<PullRequestCheck>): "passing" | "failing" | "pending" | null {
  if (checks.length === 0) return null;
  if (checks.some((check) => FAILED.has(check.status))) return "failing";
  if (checks.some((check) => PENDING.has(check.status))) return "pending";
  return "passing";
}

// A deploy job a workflow skips, as many do on pull requests, says nothing about a preview.
const isSkippedStep = (check: PullRequestCheck) =>
  check.status === "success" && SKIPPED_STEP.test(check.description ?? "");

/**
 * A pull request's preview deploy, from its deploy checks, the deployments recorded on it and a
 * workflow's skip label. Null when nothing deploys it. A `Deploying` label alone is not trusted:
 * workflows leave it behind when a later push, such as a restack, never deploys.
 */
export function resolvePullRequestDeployStatus(detail: {
  readonly checks: ReadonlyArray<PullRequestCheck>;
  readonly labels: ReadonlyArray<PullRequestLabel>;
  readonly deployments?: ReadonlyArray<PullRequestDeployment> | undefined;
}): PullRequestDeployStatus | null {
  const steps = detail.checks.filter((check) => DEPLOY_STEP.test(check.name));
  const failedStep = steps.find((check) => FAILED.has(check.status));
  const runningStep = steps.find((check) => PENDING.has(check.status));
  // Shared environments such as `production` record deploys from a pull request's workflows
  // without a URL; only an environment serving this pull request names one.
  const deployments = (detail.deployments ?? []).filter((deployment) => deployment.url !== null);
  const pendingDeployment = deployments.find((deployment) => deployment.state === "pending");
  // A failed redeploy leaves the last good one serving, so the preview outranks the failure.
  const preview = deployments.find((deployment) => deployment.state === "success");
  if (failedStep && !preview) {
    return { kind: "failed", step: failedStep.name, detailsUrl: failedStep.url };
  }
  if (runningStep || pendingDeployment) {
    return {
      kind: "deploying",
      detailsUrl: runningStep?.url ?? pendingDeployment?.logUrl ?? null,
    };
  }
  if (preview?.url) {
    const newerFailure = deployments.find(
      (deployment) =>
        deployment.state === "failure" &&
        deployment.environment === preview.environment &&
        deployment.updatedAt > preview.updatedAt,
    );
    return {
      kind: "deployed",
      environment: preview.environment,
      url: preview.url,
      commitSha: preview.commitSha,
      tests: rollup(detail.checks.filter((check) => END_TO_END.test(check.name))),
      latestFailed: failedStep !== undefined || newerFailure !== undefined,
    };
  }
  const failedDeployment = deployments.find((deployment) => deployment.state === "failure");
  if (failedDeployment) {
    return {
      kind: "failed",
      step: failedDeployment.environment,
      detailsUrl: failedDeployment.logUrl,
    };
  }
  const skippedStep = steps.find(isSkippedStep);
  if (skippedStep) {
    return { kind: "skipped", label: skippedStep.description ?? skippedStep.name };
  }
  const skipped = detail.labels.find((label) => SKIPPED_LABEL.test(label.name));
  return skipped ? { kind: "skipped", label: skipped.name } : null;
}

/** A finished deploy whose deployment has not been read yet, so its URL is still to come. */
export function deployAwaitsPreviewUrl(detail: {
  readonly checks: ReadonlyArray<PullRequestCheck>;
  readonly deployments?: ReadonlyArray<PullRequestDeployment> | undefined;
}): boolean {
  const steps = detail.checks.filter((check) => DEPLOY_STEP.test(check.name));
  return (
    steps.length > 0 &&
    steps.every((check) => check.status === "success" && !isSkippedStep(check)) &&
    !(detail.deployments ?? []).some(
      (deployment) => deployment.state === "success" && deployment.url !== null,
    )
  );
}

export interface PullRequestStackApproval {
  readonly open: number;
  readonly approved: number;
}

/** How many open layers of the stack holding `current` are approved; null outside a stack. */
export function resolveStackApproval(
  chains: ReadonlyArray<ThreadPullRequestChain>,
  current: Pick<ThreadPullRequestLink, "host" | "repository" | "number">,
): PullRequestStackApproval | null {
  const key = threadPullRequestKeyOf(current);
  const chain = chains.find((candidate) =>
    candidate.layers.some((layer) => threadPullRequestKeyOf(layer) === key),
  );
  if (!chain || chain.layers.length < 2) return null;
  const open = chain.layers.filter((layer) => layer.snapshot?.state === "open");
  if (open.length === 0) return null;
  return {
    open: open.length,
    approved: open.filter((layer) => layer.snapshot?.reviewDecision === "approved").length,
  };
}

/**
 * The bottom open layer of the stack holding `current`, when `current` sits above it. Hosts deploy
 * previews for pull requests into the default branch, so an upper layer waits for that one.
 */
export function resolveStackBaseLayer(
  chains: ReadonlyArray<ThreadPullRequestChain>,
  current: Pick<ThreadPullRequestLink, "host" | "repository" | "number">,
): ThreadPullRequestLink | null {
  const key = threadPullRequestKeyOf(current);
  for (const chain of chains) {
    const index = chain.layers.findIndex((layer) => threadPullRequestKeyOf(layer) === key);
    if (index === -1) continue;
    const open = chain.layers.flatMap((layer, at) =>
      layer.snapshot?.state === "open" ? [{ layer, depth: chain.depths[at] ?? 0 }] : [],
    );
    const bottom = open.reduce<(typeof open)[number] | null>(
      (lowest, entry) => (lowest === null || entry.depth < lowest.depth ? entry : lowest),
      null,
    );
    if (bottom === null || (chain.depths[index] ?? 0) <= bottom.depth) return null;
    return bottom.layer;
  }
  return null;
}

/** A deploy status, or an upper stack layer that can deploy once `base` merges. */
export type PullRequestDeployView =
  | PullRequestDeployStatus
  | { readonly kind: "awaiting-base"; readonly base: number };

export interface PullRequestDeployPresentation {
  readonly label: string;
  readonly tooltip: string;
  readonly url: string | null;
  readonly tone: "default" | "muted" | "destructive";
  readonly icon: "pending" | "failed" | "preview";
  /** Too little to say for a narrow row to spend room on its label. */
  readonly quiet?: boolean;
}

const DEPLOY_TESTS_LABEL = {
  passing: "end-to-end tests pass",
  failing: "end-to-end tests fail",
  pending: "end-to-end tests are running",
} as const;

export function describePullRequestDeploy(
  deploy: PullRequestDeployView,
  headSha: string | null,
): PullRequestDeployPresentation {
  switch (deploy.kind) {
    case "deploying":
      return {
        label: "Deploying",
        tooltip: "The preview is deploying",
        url: deploy.detailsUrl,
        tone: "muted",
        icon: "pending",
      };
    case "failed":
      return {
        label: "Deploy failed",
        tooltip: `${deploy.step} failed`,
        url: deploy.detailsUrl,
        tone: "destructive",
        icon: "failed",
      };
    case "deployed": {
      const older =
        deploy.commitSha !== null && headSha !== null && deploy.commitSha !== headSha
          ? `, deployed from older commit ${deploy.commitSha.slice(0, 7)}`
          : "";
      const tests = deploy.tests === null ? "" : `, ${DEPLOY_TESTS_LABEL[deploy.tests]}`;
      const failed = deploy.latestFailed ? ", the latest deploy failed" : "";
      return {
        label: "Preview",
        tooltip: `${deploy.environment}: ${deploy.url}${older}${failed}${tests}`,
        url: deploy.url,
        tone: deploy.tests === "failing" || deploy.latestFailed ? "destructive" : "default",
        icon: "preview",
      };
    }
    case "skipped":
      return {
        label: "No deploy",
        tooltip: `The deploy was skipped (${deploy.label})`,
        url: null,
        tone: "muted",
        icon: "pending",
        quiet: true,
      };
    case "awaiting-base":
      return {
        label: `Preview after #${deploy.base}`,
        tooltip: `Previews deploy automatically only for pull requests into the default branch. This one can once #${deploy.base}, the bottom of its stack, merges.`,
        url: null,
        tone: "muted",
        icon: "pending",
      };
  }
}
