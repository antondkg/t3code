import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, type HostResourcesSnapshot } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { SidebarHostMemory } from "./SidebarHostMemory";

const state = vi.hoisted(() => ({
  phase: undefined as Atom.Writable<string> | undefined,
  query: undefined as Atom.Atom<AsyncResult.AsyncResult<HostResourcesSnapshot, never>> | undefined,
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: () => ({}),
}));
vi.mock("../../state/environments", async () => {
  const { useAtomValue } = await import("@effect/atom-react");
  return {
    useEnvironments: () => {
      if (!state.phase) throw new Error("Host connection not configured");
      const phase = useAtomValue(state.phase);
      return {
        environments: [
          {
            environmentId: "remote",
            label: "Remote workspace",
            serverConfig: { hostname: "vallor-dev" },
            connection: { phase },
          },
        ],
      };
    },
  };
});
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    hostResources: ({ environmentId }: { environmentId: EnvironmentId }) => {
      if (environmentId !== "remote" || !state.query) throw new Error("Unexpected host query");
      return state.query;
    },
  },
}));

function setup() {
  const phase = Atom.make("connected");
  state.phase = phase;
  state.query = Atom.make(
    AsyncResult.success<HostResourcesSnapshot>({
      sampledAt: 1_000,
      cpuCount: 8,
      cpuUtilization: null,
      totalMemoryBytes: 48 * 1024 ** 3,
      availableMemoryBytes: 24 * 1024 ** 3,
      memoryHighBytes: 40 * 1024 ** 3,
      memoryPressure: { someAvg10: 6, fullAvg10: 2 },
    }),
  );
  return { phase };
}

it("opens the remote host's memory details and drops live readings after disconnect", async () => {
  const { phase } = setup();
  using _now = vi.spyOn(Date, "now").mockReturnValue(1_000);
  const registry = AtomRegistry.make();
  const view = () => (
    <RegistryContext value={registry}>
      <ul>
        <SidebarHostMemory />
      </ul>
    </RegistryContext>
  );
  try {
    await using screen = await render(view());
    await userEvent.click(
      screen.getByRole("button", { name: "vallor-dev memory 50%, pressure elevated" }),
    );
    await expect.element(page.getByText("24.0 GB / 48.0 GB")).toBeVisible();
    await expect.element(page.getByText("Throttling starts at 40.0 GB.")).toBeVisible();
    await expect.element(page.getByText(/6.00% some tasks, 2.00% all tasks/)).toBeVisible();

    await act(() => registry.set(phase, "offline"));
    await expect
      .element(screen.getByRole("button", { name: "vallor-dev memory unavailable" }))
      .toHaveTextContent("N/A");
    await userEvent.click(screen.getByRole("button", { name: "vallor-dev memory unavailable" }));
    await expect
      .element(page.getByText("No fresh memory sample. Check the connection."))
      .toBeVisible();
  } finally {
    registry.dispose();
  }
});
