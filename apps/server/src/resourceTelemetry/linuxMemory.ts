import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

function memoryNumber(text: string): number | null {
  const value = /^\d+$/.test(text.trim()) ? Number(text.trim()) : Number.NaN;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function pressure(text: string) {
  const some = Number(/^some avg10=(\d+(?:\.\d+)?)\s/m.exec(text)?.[1] ?? Number.NaN);
  const full = Number(/^full avg10=(\d+(?:\.\d+)?)\s/m.exec(text)?.[1] ?? Number.NaN);
  return some >= 0 && some <= 100 && full >= 0 && full <= 100
    ? { someAvg10: some, fullAvg10: full }
    : null;
}

export const readLinuxMemory = Effect.fn("HostResources.readLinuxMemory")(function* (
  cgroupPath: string | undefined,
  totalMemoryBytes: number,
  availableMemoryBytes: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const read = (path: string) => fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""));
  const meminfo = yield* read("/proc/meminfo");
  const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo)?.[1];
  if (available) availableMemoryBytes = Number(available) * 1024;
  let memoryHighBytes: number | null = null;
  let memoryPressure = pressure(yield* read("/proc/pressure/memory"));

  // Parent slices include sibling agents and impose limits even when the server has none.
  let path = cgroupPath ?? null;
  while (path !== null) {
    const base = `/sys/fs/cgroup${path === "/" ? "" : path}`;
    const current = memoryNumber(yield* read(`${base}/memory.current`));
    if (current !== null) {
      const stat = yield* read(`${base}/memory.stat`);
      const reclaimable = Number(/^inactive_file (\d+)$/m.exec(stat)?.[1] ?? 0);
      const used = Math.max(0, current - reclaimable);
      const max = memoryNumber(yield* read(`${base}/memory.max`));
      const high = memoryNumber(yield* read(`${base}/memory.high`));
      if (max !== null) {
        totalMemoryBytes = Math.min(totalMemoryBytes, max);
        availableMemoryBytes = Math.min(availableMemoryBytes, max - used);
      }
      if (high !== null && high > 0) {
        memoryHighBytes = Math.min(memoryHighBytes ?? totalMemoryBytes, high);
      }
    }
    const sample = pressure(yield* read(`${base}/memory.pressure`));
    if (sample !== null) {
      memoryPressure = {
        someAvg10: Math.max(memoryPressure?.someAvg10 ?? 0, sample.someAvg10),
        fullAvg10: Math.max(memoryPressure?.fullAvg10 ?? 0, sample.fullAvg10),
      };
    }
    path = path === "/" ? null : path.slice(0, path.lastIndexOf("/")) || "/";
  }
  return {
    totalMemoryBytes,
    availableMemoryBytes: Math.min(totalMemoryBytes, Math.max(0, availableMemoryBytes)),
    memoryHighBytes,
    memoryPressure,
  };
});
