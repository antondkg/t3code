import {
  gatingPullRequestChecks,
  type PullRequestCheck,
  type PullRequestDeployment,
  type PullRequestDetail,
  type PullRequestLabel,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import {
  threadPullRequestKeyOf,
  type ThreadPullRequestChain,
} from "@t3tools/client-runtime/thread-pull-requests";

export type PullRequestDeployStatus =
  | {
      readonly kind: "deploying";
      readonly environment: string | null;
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
      environment: pendingDeployment?.environment ?? null,
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

export interface PullRequestMergeReadiness {
  readonly open: number;
  readonly failing: ReadonlyArray<number>;
  /** Running, or not reported by the host yet. */
  readonly pending: ReadonlyArray<number>;
  /** Passed, except for a stacking tool's check that waits for the layers below to merge. */
  readonly stackPending: ReadonlyArray<number>;
  readonly changesRequested: ReadonlyArray<number>;
  /** Neither approved nor blocked by requested changes, with a reviewer asked. */
  readonly unapproved: ReadonlyArray<number>;
  /** Neither approved nor blocked, and nobody has been asked to review. */
  readonly noReviewer: ReadonlyArray<number>;
  /** A check waits on a reviewer, such as watching a demo and adding its label. */
  readonly signoff: ReadonlyArray<number>;
}

/** Whether every open linked pull request passes its checks and is approved. Null with none open. */
export function resolveMergeReadiness(
  links: ReadonlyArray<ThreadPullRequestLink>,
  {
    ci = new Map(),
    noReviewer = new Set(),
    signoff = new Set(),
  }: {
    /**
     * Read from details: CI by the host's required checks, apart from sign-offs and a stacking
     * tool's wait. Outranks the snapshot, whose rollup counts optional checks too.
     */
    readonly ci?: ReadonlyMap<number, PullRequestCiVerdict>;
    /** Read from details: no reviewer requested. */
    readonly noReviewer?: ReadonlySet<number>;
    /** Read from details: a check waits on a reviewer. */
    readonly signoff?: ReadonlySet<number>;
  } = {},
): PullRequestMergeReadiness | null {
  const open = links.filter((link) => link.snapshot?.state === "open");
  if (open.length === 0) return null;
  const numbers = (keep: (link: ThreadPullRequestLink) => boolean) =>
    open.filter(keep).map((link) => link.number);
  const verdict = (link: ThreadPullRequestLink) =>
    ci.get(link.number) ?? link.snapshot?.checksState ?? null;
  return {
    open: open.length,
    failing: numbers((link) => verdict(link) === "failing"),
    pending: numbers(
      (link) => !["failing", "passing", "stack-pending"].includes(verdict(link) ?? ""),
    ),
    stackPending: numbers((link) => verdict(link) === "stack-pending"),
    changesRequested: numbers((link) => link.snapshot?.reviewDecision === "changes-requested"),
    unapproved: numbers(
      (link) =>
        link.snapshot?.reviewDecision !== "approved" &&
        link.snapshot?.reviewDecision !== "changes-requested" &&
        !noReviewer.has(link.number),
    ),
    noReviewer: numbers(
      (link) =>
        link.snapshot?.reviewDecision !== "approved" &&
        link.snapshot?.reviewDecision !== "changes-requested" &&
        noReviewer.has(link.number),
    ),
    signoff: numbers((link) => signoff.has(link.number)),
  };
}

// Regex: Graphite's per-layer check, which stays pending until the layers below it merge.
const STACK_CHECK = /^graphite\s*\/\s*mergeability[_ ]check$/iu;

// A status that waits on a person rather than a job, such as
// `Demo required: a reviewer must add demo-verified`.
const SIGNOFF = /\b(?:reviewer|maintainer|approver)s?\b[^.]*\b(?:must|needs? to|has to)\b/iu;
const SIGNOFF_LABEL = /\badd(?:s|ing)?\s+(?:the\s+)?[`'"]?([\w:./-]+)[`'"]?/iu;

const isSignoffCheck = (check: PullRequestCheck) =>
  PENDING.has(check.status) && SIGNOFF.test(check.description ?? "");

/** The label a sign-off check asks a reviewer to add, when its description names one. */
export const signoffLabel = (check: PullRequestCheck): string | null =>
  SIGNOFF_LABEL.exec(check.description ?? "")?.[1] ?? null;

// Checks that run end-to-end tests (`Dashboard / E2E`, `run-e2e-tests`) or say whether the head's
// E2E is verified (`E2E requirement`). A merge-queue gate only runs once the stack lands.
const E2E_CHECK = /\be2e\b|end[-_ ]to[-_ ]end/iu;
const E2E_VERDICT = /\brequirement\b/iu;
const E2E_GATE = /\bgate\b/iu;
const E2E_NOT_NEEDED = /\bno\b[^.]*\b(?:required|needed)\b/iu;

const isEndToEndCheck = (check: PullRequestCheck) => E2E_CHECK.test(check.name);

export type PullRequestChecksSummary = (
  | { readonly kind: "none" }
  | { readonly kind: "failing"; readonly failing: ReadonlyArray<PullRequestCheck> }
  | { readonly kind: "running"; readonly passed: number; readonly total: number }
  | { readonly kind: "stack-pending"; readonly passed: number; readonly total: number }
  | { readonly kind: "passing"; readonly passed: number; readonly total: number }
) & {
  /** Pending checks a reviewer clears by hand, kept out of the CI verdict. */
  readonly signoffs: ReadonlyArray<PullRequestCheck>;
  /** Failed checks the host does not require to merge, kept out of the CI verdict. */
  readonly optionalFailing: ReadonlyArray<PullRequestCheck>;
};

/**
 * A pull request's checks as one verdict, with a stacking tool's wait and checks that wait on a
 * reviewer apart from real CI.
 */
export function summarizeChecks(checks: ReadonlyArray<PullRequestCheck>): PullRequestChecksSummary {
  const gating = gatingPullRequestChecks(checks);
  const extras = {
    signoffs: checks.filter(isSignoffCheck),
    optionalFailing:
      gating === checks
        ? []
        : // E2E reads apart, on the stack's top; see `resolveEndToEnd`.
          checks.filter(
            (check) =>
              check.required !== true && FAILED.has(check.status) && !isEndToEndCheck(check),
          ),
  };
  const counted = gating.filter(
    (check) => check.status !== "skipped" && check.status !== "neutral" && !isSignoffCheck(check),
  );
  // Required checks a workflow skips, such as a merge-queue gate, count as passed.
  if (counted.length === 0) {
    return gating === checks
      ? { kind: "none", ...extras }
      : { kind: "passing", passed: 0, total: 0, ...extras };
  }
  const failing = counted.filter((check) => FAILED.has(check.status));
  if (failing.length > 0) return { kind: "failing", failing, ...extras };
  const passed = counted.filter((check) => check.status === "success").length;
  const total = counted.length;
  const waiting = counted.filter((check) => PENDING.has(check.status));
  if (waiting.length === 0) return { kind: "passing", passed, total, ...extras };
  return waiting.every((check) => STACK_CHECK.test(check.name))
    ? { kind: "stack-pending", passed, total, ...extras }
    : { kind: "running", passed, total, ...extras };
}

export interface PullRequestEndToEnd {
  readonly state: "passed" | "failed" | "running" | "not-run" | "not-needed";
  readonly url: string | null;
  readonly detail: string | null;
}

/**
 * Whether end-to-end tests passed on a pull request's head. A verdict status such as Vallor's
 * `E2E requirement` decides once its runs settle; without one, the runs themselves do.
 */
export function resolveEndToEnd(
  checks: ReadonlyArray<PullRequestCheck>,
): PullRequestEndToEnd | null {
  const e2e = checks.filter((check) => isEndToEndCheck(check) && !E2E_GATE.test(check.name));
  const verdict = e2e.find((check) => E2E_VERDICT.test(check.name));
  const runs = e2e.filter(
    (check) => check !== verdict && check.status !== "skipped" && check.status !== "neutral",
  );
  const running = runs.find((check) => PENDING.has(check.status));
  if (running) return { state: "running", url: running.url, detail: running.name };
  const failed = runs.find((check) => FAILED.has(check.status));
  if (failed) return { state: "failed", url: failed.url, detail: `${failed.name} failed` };
  if (verdict) {
    const { url, description: detail } = verdict;
    if (PENDING.has(verdict.status)) return { state: "running", url, detail };
    if (verdict.status !== "success") return { state: "not-run", url, detail };
    return { state: E2E_NOT_NEEDED.test(detail ?? "") ? "not-needed" : "passed", url, detail };
  }
  const [first] = runs;
  return first === undefined
    ? null
    : { state: "passed", url: first.url, detail: `${runs.length} E2E checks passed` };
}

/** Red on a stack's top whenever E2E has not passed: its run is the one that covers the stack. */
export const END_TO_END_PRESENTATION = {
  passed: { tone: "success", label: "E2E passed" },
  failed: { tone: "destructive", label: "E2E failed" },
  running: { tone: "muted", label: "E2E running" },
  "not-run": { tone: "destructive", label: "E2E not run" },
  "not-needed": { tone: "muted", label: "no E2E needed" },
} as const satisfies Record<
  PullRequestEndToEnd["state"],
  { tone: "success" | "destructive" | "muted" | "attention"; label: string }
>;

/** The E2E of each stack's top, read from loaded details; null until its detail loads. */
export function resolveTopEndToEnd(
  chains: ReadonlyArray<ThreadPullRequestChain>,
  details: ReadonlyArray<Pick<PullRequestDetail, "number" | "checks"> | null>,
): ReadonlyArray<{ readonly number: number; readonly e2e: PullRequestEndToEnd | null }> {
  return resolveStackTops(chains)
    .filter((top) => top.stacked)
    .map(({ link }) => {
      const detail = details.find((candidate) => candidate?.number === link.number);
      return { number: link.number, e2e: detail ? resolveEndToEnd(detail.checks) : null };
    });
}

/**
 * Each stack's open tops: open layers with no open layer stacked on them. A top carries every
 * change below it, so its E2E run is the one that covers the stack. `stacked` is false for a lone
 * pull request.
 */
export function resolveStackTops(chains: ReadonlyArray<ThreadPullRequestChain>): ReadonlyArray<{
  readonly link: ThreadPullRequestLink;
  readonly stacked: boolean;
}> {
  return chains.flatMap((chain) => {
    const open = chain.layers.flatMap((layer, at) =>
      layer.snapshot?.state === "open" ? [{ layer, depth: chain.depths[at] ?? 0 }] : [],
    );
    // Layers run depth-first, so a layer with a child is followed by a deeper one.
    return open
      .filter((entry, at) => (open[at + 1]?.depth ?? -1) <= entry.depth)
      .map((entry) => ({ link: entry.layer, stacked: open.length > 1 }));
  });
}

/** Whether CI passed, by the same rules as `summarizeChecks`, for the readiness of a stack. */
export type PullRequestCiVerdict = "failing" | "pending" | "stack-pending" | "passing";

export function ciVerdictOf(summary: PullRequestChecksSummary): PullRequestCiVerdict | null {
  switch (summary.kind) {
    case "none":
      return null;
    case "running":
      return "pending";
    default:
      return summary.kind;
  }
}
