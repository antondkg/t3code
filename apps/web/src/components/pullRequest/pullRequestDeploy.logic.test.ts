import type {
  PullRequestCheck,
  PullRequestDeployment,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deployAwaitsPreviewUrl,
  resolvePullRequestDeployStatus,
  resolveStackApproval,
  resolveStackBaseLayer,
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
      expected: { kind: "deploying", detailsUrl: "https://ci/1" },
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
