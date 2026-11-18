import { describe, expect, it } from "vite-plus/test";
import type { HostResourcesSnapshot } from "@t3tools/contracts";

import { hostMemoryView } from "./SidebarHostMemory.logic";

const snapshot: HostResourcesSnapshot = {
  sampledAt: 1_000,
  cpuCount: 8,
  cpuUtilization: null,
  totalMemoryBytes: 100,
  availableMemoryBytes: 70,
  memoryPressure: { someAvg10: 0, fullAvg10: 0 },
};

describe("hostMemoryView", () => {
  it.each([
    { pressure: { someAvg10: 0, fullAvg10: 0 }, level: "Low", tone: "normal" },
    { pressure: { someAvg10: 5, fullAvg10: 0 }, level: "Elevated", tone: "warning" },
    { pressure: { someAvg10: 2, fullAvg10: 1 }, level: "Elevated", tone: "warning" },
    { pressure: { someAvg10: 20, fullAvg10: 0 }, level: "High", tone: "error" },
    { pressure: { someAvg10: 15, fullAvg10: 10 }, level: "High", tone: "error" },
    { pressure: null, level: "Unavailable", tone: "normal" },
  ])("reports $level pressure independently of allocation", ({ pressure, level, tone }) => {
    expect(hostMemoryView({ ...snapshot, memoryPressure: pressure }, 1_000)).toMatchObject({
      percent: 30,
      pressureLevel: level,
      tone,
    });
  });

  it("warns when memory reaches the shared slice's throttling threshold", () => {
    expect(hostMemoryView({ ...snapshot, memoryHighBytes: 30 }, 1_000)?.tone).toBe("warning");
    expect(hostMemoryView({ ...snapshot, availableMemoryBytes: 4 }, 1_000)?.tone).toBe("error");
  });

  it("does not present missing, empty or stale telemetry as current", () => {
    expect(hostMemoryView(null, 1_000)).toBeNull();
    expect(hostMemoryView({ ...snapshot, totalMemoryBytes: 0 }, 1_000)).toBeNull();
    expect(hostMemoryView(snapshot, 31_000)).not.toBeNull();
    expect(hostMemoryView(snapshot, 31_001)).toBeNull();
  });
});
