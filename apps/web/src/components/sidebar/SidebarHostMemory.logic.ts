import type { HostResourcesSnapshot } from "@t3tools/contracts";

export function hostMemoryView(resources: HostResourcesSnapshot | null, now: number) {
  if (!resources || resources.totalMemoryBytes <= 0 || now - resources.sampledAt > 30_000) {
    return null;
  }
  const used = Math.max(0, resources.totalMemoryBytes - resources.availableMemoryBytes);
  const fraction = used / resources.totalMemoryBytes;
  const pressure = resources.memoryPressure;
  const pressureLevel = !pressure
    ? "Unavailable"
    : pressure.fullAvg10 >= 10 || pressure.someAvg10 >= 20
      ? "High"
      : pressure.fullAvg10 >= 1 || pressure.someAvg10 >= 5
        ? "Elevated"
        : "Low";
  const tone =
    pressureLevel === "High" || fraction >= 0.95
      ? "error"
      : pressureLevel === "Elevated" ||
          fraction >= 0.85 ||
          (resources.memoryHighBytes != null && used >= resources.memoryHighBytes)
        ? "warning"
        : "normal";
  return { used, percent: Math.round(fraction * 100), pressureLevel, tone };
}
