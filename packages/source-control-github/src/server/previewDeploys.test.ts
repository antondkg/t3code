import { describe, expect, it } from "vite-plus/test";

import { previewDeploymentsFromRuns } from "./previewDeploys.ts";

const run = (title: string, status: string, conclusion: string | null, updatedAt: string) => ({
  display_title: title,
  status,
  conclusion,
  html_url: `https://github.com/run/${updatedAt}`,
  head_sha: "3e38d25",
  updated_at: updatedAt,
});
const URL = "https://pr8888.sandbox.vallor.ai";

describe("previewDeploymentsFromRuns", () => {
  it("keeps a stage's newest deploy and the successful one still serving it", () => {
    const runs = [
      run(
        "Deploy Sandbox Stage pr8888 on feature/search",
        "completed",
        "failure",
        "2026-11-06T21:17:44Z",
      ),
      run(
        "Deploy Sandbox Stage pr88880 on feature/other",
        "completed",
        "success",
        "2026-11-06T21:00:00Z",
      ),
      run(
        "Deploy Sandbox Stage pr8888 on feature/search",
        "completed",
        "success",
        "2026-11-06T19:33:18Z",
      ),
      run(
        "Deploy Sandbox Stage pr8888 on feature/rollout",
        "completed",
        "cancelled",
        "2026-11-06T19:00:00Z",
      ),
    ];
    expect(
      previewDeploymentsFromRuns(runs, "pr8888", URL).map(({ state, updatedAt }) => [
        state,
        updatedAt,
      ]),
    ).toEqual([
      ["failure", "2026-11-06T21:17:44Z"],
      ["success", "2026-11-06T19:33:18Z"],
    ]);
  });

  it("reads a running deploy as pending and a stage never deployed as none", () => {
    const running = [
      run(
        "Deploy Sandbox Stage pr8888 on feature/search",
        "in_progress",
        null,
        "2026-11-06T22:00:00Z",
      ),
    ];
    expect(previewDeploymentsFromRuns(running, "pr8888", URL)).toEqual([
      expect.objectContaining({ environment: "pr8888", state: "pending", url: URL }),
    ]);
    expect(previewDeploymentsFromRuns(running, "pr9000", URL)).toEqual([]);
  });
});
