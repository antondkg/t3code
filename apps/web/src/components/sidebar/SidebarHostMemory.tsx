import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, HostResourcesSnapshot } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { MemoryStickIcon } from "lucide-react";
import { memo } from "react";

import { formatBytes } from "../../lib/formatBytes";
import { cn } from "../../lib/utils";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { hostMemoryView } from "./SidebarHostMemory.logic";

const memoryAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const result = get(serverEnvironment.hostResources({ environmentId, input: {} }));
    return result._tag === "Success"
      ? { resources: result.value, view: hostMemoryView(result.value, Date.now()) }
      : null;
  }),
);

function ConnectedHostMemory({ environmentId }: { environmentId: EnvironmentId }) {
  const sample = useAtomValue(memoryAtom(environmentId));
  return <HostMemory sample={sample} />;
}

function HostMemory({
  sample,
}: {
  sample: {
    resources: HostResourcesSnapshot;
    view: ReturnType<typeof hostMemoryView>;
  } | null;
}) {
  const view = sample?.view;
  const resources = sample?.resources;
  return (
    <SidebarMenuItem className="min-w-0 shrink-0">
      <Popover>
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <button
                    type="button"
                    aria-label={`vallor-dev memory${view ? ` ${view.percent}%, pressure ${view.pressureLevel.toLowerCase()}` : " unavailable"}`}
                    className="flex h-8 items-center gap-1 rounded-md px-1.5 text-xs text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  />
                }
              />
            }
          >
            <MemoryStickIcon
              className={cn(
                "size-3.5",
                view?.tone === "error" && "text-destructive",
                view?.tone === "warning" && "text-warning",
              )}
            />
            <span className="tabular-nums">{view ? `${view.percent}%` : "N/A"}</span>
          </TooltipTrigger>
          <TooltipPopup side="top">
            vallor-dev:{" "}
            {view
              ? `${view.percent}% memory, ${view.pressureLevel.toLowerCase()} pressure`
              : "memory unavailable"}
          </TooltipPopup>
        </Tooltip>
        <PopoverPopup side="top" align="start" width="sm">
          <div className="space-y-3 px-4 text-xs">
            <div className="font-medium">vallor-dev memory</div>
            {view && resources ? (
              <>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-muted-foreground">In use</span>
                  <span className="tabular-nums">
                    {formatBytes(view.used)} / {formatBytes(resources.totalMemoryBytes)}
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Pressure</span>
                  <span>{view.pressureLevel}</span>
                </div>
                {resources.memoryPressure ? (
                  <p className="text-muted-foreground">
                    Memory stalls over 10 seconds: {resources.memoryPressure.someAvg10.toFixed(2)}%{" "}
                    some tasks, {resources.memoryPressure.fullAvg10.toFixed(2)}% all tasks.
                  </p>
                ) : null}
                {resources.memoryHighBytes != null ? (
                  <p className="text-muted-foreground">
                    Throttling starts at {formatBytes(resources.memoryHighBytes)}.
                  </p>
                ) : null}
                <p className="text-muted-foreground">
                  Includes other workloads sharing this server's memory budget. Reclaimable cache
                  counts as available.
                </p>
              </>
            ) : (
              <p className="text-muted-foreground">No fresh memory sample. Check the connection.</p>
            )}
          </div>
        </PopoverPopup>
      </Popover>
    </SidebarMenuItem>
  );
}

export const SidebarHostMemory = memo(function SidebarHostMemory() {
  const { environments } = useEnvironments();
  const environment = environments.find(
    ({ label, serverConfig }) =>
      serverConfig?.hostname?.split(".")[0] === "vallor-dev" ||
      label.toLowerCase().replace(/[\s_]+/g, "-") === "vallor-dev",
  );
  if (!environment) return null;
  return environment.connection.phase === "connected" ? (
    <ConnectedHostMemory
      key={environment.environmentId}
      environmentId={environment.environmentId}
    />
  ) : (
    <HostMemory sample={null} />
  );
});
