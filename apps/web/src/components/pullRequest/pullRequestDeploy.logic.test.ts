import type {
  PullRequestCheck,
  PullRequestDeployment,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deployAwaitsPreviewUrl,
  resolveMergeReadiness,
  resolvePullRequestDeployStatus,
  signoffLabel,
  summarizeChecks,
  resolveEndToEnd,
  resolveStackApproval,
  resolveStackBaseLayer,
  resolveStackTops,
} from "./pullRequestDeploy.logic";

const check = (name: string, status: PullRequestCheck["status"], url: string | null = null) => ({
  name,
  status,
  description: null,
  url,
});
const deployment = (
  state: PullRequestDeployment["state"],
  url: string | null,
  environment = "pr8735",
): PullRequestDeployment => ({
  environment,
  state,
  url,
  logUrl: null,
  commitSha: "ceea101",
  updatedAt: "2026-11-06T00:00:00.000Z",
});
const label = (name: string) => ({ name, color: null });

describe("resolvePullRequestDeployStatus", () => {
  it.each([
    {
      name: "a running deploy step",
      checks: [
        check("deploy-sandbox", "pending", "https://ci/1"),
        check("require-deploy-tag", "success"),
      ],
      expected: { kind: "deploying", environment: null, detailsUrl: "https://ci/1" },
    },
    {
      name: "a failed deploy step",
      checks: [check("deploy-sandbox", "failure", "https://ci/2")],
      expected: { kind: "failed", step: "deploy-sandbox", detailsUrl: "https://ci/2" },
    },
    {
      name: "a published preview with its end-to-end run",
      checks: [
        check("deploy-sandbox", "success"),
        check("run-e2e-tests", "pending"),
        check("E2E requirement", "failure"),
      ],
      deployments: [deployment("success", "https://pr8735.sandbox.vallor.ai")],
      expected: {
        kind: "deployed",
        environment: "pr8735",
        url: "https://pr8735.sandbox.vallor.ai",
        commitSha: "ceea101",
        tests: "pending",
        latestFailed: false,
      },
    },
    {
      name: "a live preview whose redeploy failed",
      checks: [{ ...check("deploy-sandbox", "success"), description: "Deploy check skipped" }],
      deployments: [
        {
          ...deployment("failure", "https://pr8888.sandbox.vallor.ai", "pr8888"),
          updatedAt: "2026-11-06T21:17:44Z",
        },
        {
          ...deployment("success", "https://pr8888.sandbox.vallor.ai", "pr8888"),
          updatedAt: "2026-11-06T19:33:18Z",
        },
      ],
      expected: {
        kind: "deployed",
        environment: "pr8888",
        url: "https://pr8888.sandbox.vallor.ai",
        commitSha: "ceea101",
        tests: null,
        latestFailed: true,
      },
    },
    {
      name: "a skip label with no deploy",
      checks: [check("require-deploy-tag", "success")],
      labels: [label("Deploy Skipped")],
      expected: { kind: "skipped", label: "Deploy Skipped" },
    },
    {
      name: "a shared environment's failure without a URL",
      checks: [check("unit-tests", "success")],
      deployments: [
        deployment("failure", null, "sandbox"),
        deployment("pending", null, "production"),
      ],
      expected: null,
    },
    {
      name: "a deploy check passed by a skip, without its label",
      checks: [{ ...check("deploy-sandbox", "success"), description: "Deploy check skipped" }],
      expected: { kind: "skipped", label: "Deploy check skipped" },
    },
    {
      name: "a stale Deploying label with no deploy check",
      checks: [check("require-deploy-tag", "success"), check("E2E requirement", "failure")],
      labels: [label("Deploying"), label("E2E Tests Failed")],
      expected: null,
    },
    {
      name: "a deploy job skipped on pull requests",
      checks: [check("deploy", "skipped"), check("unit-tests", "success")],
      expected: null,
    },
    { name: "nothing that deploys", checks: [check("unit-tests", "success")], expected: null },
  ])("reads $name", ({ checks, deployments, labels, expected }) => {
    expect(resolvePullRequestDeployStatus({ checks, labels: labels ?? [], deployments })).toEqual(
      expected,
    );
  });

  it("waits for the preview URL once every deploy step passed", () => {
    expect(deployAwaitsPreviewUrl({ checks: [check("deploy-sandbox", "success")] })).toBe(true);
    expect(
      deployAwaitsPreviewUrl({
        checks: [check("deploy-sandbox", "success")],
        deployments: [deployment("success", "https://pr1.sandbox.vallor.ai")],
      }),
    ).toBe(false);
    expect(deployAwaitsPreviewUrl({ checks: [check("unit-tests", "success")] })).toBe(false);
    expect(
      deployAwaitsPreviewUrl({
        checks: [{ ...check("deploy-sandbox", "success"), description: "Deploy check skipped" }],
      }),
    ).toBe(false);
  });
});

describe("resolveStackApproval", () => {
  const layer = (number: number, state: "open" | "merged", approved: boolean) =>
    ({
      host: "github.com",
      repository: "boardai/vallor",
      number,
      snapshot: { state, reviewDecision: approved ? "approved" : "review-required" },
    }) as unknown as ThreadPullRequestLink;

  it("counts approved open layers and finds the bottom one an upper layer waits on", () => {
    const chains = [
      {
        kind: "derived" as const,
        layers: [layer(1, "merged", false), layer(2, "open", true), layer(3, "open", true)],
        depths: [0, 1, 2],
      },
    ];
    expect(resolveStackApproval(chains, layer(3, "open", true))).toEqual({ open: 2, approved: 2 });
    expect(resolveStackApproval(chains, layer(9, "open", true))).toBeNull();
    // The merged layer is gone, so #2 is the bottom; #3 waits on it.
    expect(resolveStackBaseLayer(chains, layer(3, "open", true))?.number).toBe(2);
    expect(resolveStackBaseLayer(chains, layer(2, "open", true))).toBeNull();
    expect(resolveStackBaseLayer(chains, layer(9, "open", true))).toBeNull();
    expect(
      resolveStackApproval(
        [{ kind: "derived", layers: [layer(4, "open", true)], depths: [0] }],
        layer(4, "open", true),
      ),
    ).toBeNull();
  });
});

describe("resolveEndToEnd", () => {
  const verdict = (status: PullRequestCheck["status"], description: string) => ({
    ...check("E2E requirement", status, "https://ci/verdict"),
    description,
  });
  it.each([
    { name: "no E2E checks", checks: [check("lint", "success")], expected: null },
    {
      name: "a module run still going, before the verdict updates",
      checks: [
        check("Grids / E2E", "pending", "https://ci/grids"),
        verdict("failure", "Optional: no E2E run for the current commit"),
      ],
      expected: { state: "running", url: "https://ci/grids", detail: "Grids / E2E" },
    },
    {
      name: "a failed module run",
      checks: [check("Chat / E2E", "failure", "https://ci/chat"), check("Smoke / E2E", "success")],
      expected: { state: "failed", url: "https://ci/chat", detail: "Chat / E2E failed" },
    },
    {
      name: "the verdict saying the head was not run",
      checks: [verdict("failure", "Optional: no E2E run for the current commit")],
      expected: {
        state: "not-run",
        url: "https://ci/verdict",
        detail: "Optional: no E2E run for the current commit",
      },
    },
    {
      name: "the verdict passing the head, ignoring the merge-queue gate",
      checks: [
        verdict("success", "Required E2E passed for the current commit"),
        check("E2E merge gate", "skipped"),
      ],
      expected: {
        state: "passed",
        url: "https://ci/verdict",
        detail: "Required E2E passed for the current commit",
      },
    },
    {
      name: "the verdict finding no E2E needed",
      checks: [verdict("success", "No additional E2E suite required")],
      expected: {
        state: "not-needed",
        url: "https://ci/verdict",
        detail: "No additional E2E suite required",
      },
    },
  ])("reads $name", ({ checks, expected }) => {
    expect(resolveEndToEnd(checks)).toEqual(expected);
  });

  it("picks each stack's open tops, branches included", () => {
    const layer = (number: number, state = "open") =>
      ({
        host: "github.com",
        repository: "boardai/vallor",
        number,
        snapshot: { state },
      }) as unknown as ThreadPullRequestLink;
    const tops = resolveStackTops([
      {
        kind: "derived",
        layers: [layer(1), layer(2), layer(3), layer(4), layer(5, "merged")],
        depths: [0, 1, 2, 1, 2],
      },
      { kind: "derived", layers: [layer(9)], depths: [0] },
    ]);
    expect(tops.map(({ link, stacked }) => [link.number, stacked])).toEqual([
      [3, true],
      [4, true],
      [9, false],
    ]);
  });
});

describe("resolveMergeReadiness", () => {
  const link = (
    number: number,
    snapshot: { state?: string; checksState?: string | null; reviewDecision?: string | null },
  ) =>
    ({
      host: "github.com",
      repository: "boardai/vallor",
      number,
      snapshot: { state: "open", ...snapshot },
    }) as unknown as ThreadPullRequestLink;

  it("names the open pull requests missing passing checks or an approval", () => {
    expect(
      resolveMergeReadiness([
        link(1, { checksState: "passing", reviewDecision: "approved" }),
        link(2, { checksState: "failing", reviewDecision: "changes-requested" }),
        link(3, { checksState: "pending", reviewDecision: null }),
        link(4, { checksState: null, reviewDecision: "review-required" }),
        link(5, { state: "merged", checksState: "failing" }),
      ]),
    ).toEqual({
      open: 4,
      failing: [2],
      pending: [3, 4],
      stackPending: [],
      changesRequested: [2],
      unapproved: [3, 4],
      noReviewer: [],
      signoff: [],
    });
    expect(
      resolveMergeReadiness([link(3, { checksState: "pending" })], {
        ci: new Map([[3, "stack-pending"]]),
      })?.stackPending,
    ).toEqual([3]);
    // Details judge by required checks, so a rollup failed by an optional one is not failing.
    expect(
      resolveMergeReadiness([link(7, { checksState: "failing" })], {
        ci: new Map([[7, "passing"]]),
      }),
    ).toMatchObject({ failing: [], pending: [] });
    // A reviewer still to ask is its own blocker, apart from a review that is only waiting.
    expect(
      resolveMergeReadiness(
        [link(3, { reviewDecision: null }), link(4, { reviewDecision: "review-required" })],
        { noReviewer: new Set([3]) },
      ),
    ).toMatchObject({ unapproved: [4], noReviewer: [3] });
    expect(
      resolveMergeReadiness([link(1, { checksState: "passing", reviewDecision: "approved" })]),
    ).toEqual({
      open: 1,
      failing: [],
      pending: [],
      stackPending: [],
      changesRequested: [],
      unapproved: [],
      noReviewer: [],
      signoff: [],
    });
    // CI passed under a host rollup that only a reviewer's sign-off holds pending.
    expect(
      resolveMergeReadiness([link(6, { checksState: "pending" })], {
        ci: new Map([[6, "passing"]]),
        signoff: new Set([6]),
      }),
    ).toMatchObject({ pending: [], signoff: [6] });
    expect(resolveMergeReadiness([link(5, { state: "merged" })])).toBeNull();
  });
});

describe("summarizeChecks", () => {
  const demo = {
    ...check("PR demo", "pending"),
    description: "Demo required: a reviewer must add demo-verified",
  };
  it("names the label a sign-off check asks for", () => {
    expect(signoffLabel(demo)).toBe("demo-verified");
  });
  it.each([
    {
      name: "no checks",
      checks: [],
      expected: { kind: "none", signoffs: [], optionalFailing: [] },
    },
    {
      name: "a failure",
      checks: [check("unit-tests", "failure"), check("lint", "success")],
      expected: {
        kind: "failing",
        failing: [check("unit-tests", "failure")],
        signoffs: [],
        optionalFailing: [],
      },
    },
    {
      name: "only Graphite's stack check waiting",
      checks: [check("lint", "success"), check("Graphite / mergeability_check", "pending")],
      expected: { kind: "stack-pending", passed: 1, total: 2, signoffs: [], optionalFailing: [] },
    },
    {
      name: "real CI still running",
      checks: [check("lint", "pending"), check("Graphite / mergeability_check", "pending")],
      expected: { kind: "running", passed: 0, total: 2, signoffs: [], optionalFailing: [] },
    },
    {
      name: "everything passed, skipped jobs left out",
      checks: [check("lint", "success"), check("deploy", "skipped")],
      expected: { kind: "passing", passed: 1, total: 1, signoffs: [], optionalFailing: [] },
    },
    {
      name: "a status that waits on a reviewer, apart from CI",
      checks: [check("lint", "success"), demo],
      expected: { kind: "passing", passed: 1, total: 1, signoffs: [demo], optionalFailing: [] },
    },
    {
      name: "only required checks deciding, when the host marks them",
      checks: [
        { ...check("unit-tests", "success"), required: true },
        { ...check("E2E merge gate", "skipped"), required: true },
        { ...check("E2E requirement", "failure"), required: false },
      ],
      expected: {
        kind: "passing",
        passed: 1,
        total: 1,
        signoffs: [],
        // E2E reads apart, on the stack's top.
        optionalFailing: [],
      },
    },
    {
      name: "required checks a workflow skipped as passed",
      checks: [
        { ...check("E2E merge gate", "skipped"), required: true },
        { ...check("local-qa", "failure"), required: false },
      ],
      expected: {
        kind: "passing",
        passed: 0,
        total: 0,
        signoffs: [],
        optionalFailing: [{ ...check("local-qa", "failure"), required: false }],
      },
    },
  ])("reads $name", ({ checks, expected }) => {
    expect(summarizeChecks(checks)).toEqual(expected);
  });
});
