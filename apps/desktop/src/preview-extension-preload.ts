import { contextBridge } from "electron";

// Chromium's native `browser` namespace misses the APIs electron-chrome-extensions adds to `chrome`.
const aliasBrowserNamespace = (): void => {
  const { chrome } = globalThis as { chrome?: { runtime?: { id?: string } } };
  if (!chrome?.runtime?.id) return;
  Object.defineProperty(globalThis, "browser", {
    value: chrome,
    configurable: true,
    writable: true,
  });
};

if (process.type === "service-worker" || location.href.startsWith("chrome-extension://")) {
  if (process.contextIsolated) {
    contextBridge.executeInMainWorld({ func: aliasBrowserNamespace });
  } else {
    aliasBrowserNamespace();
  }
}
