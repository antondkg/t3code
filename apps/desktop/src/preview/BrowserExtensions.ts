import { app, BrowserWindow, dialog, type Session, type WebContents } from "electron";
import type { ElectronChromeExtensions } from "electron-chrome-extensions";

import { findExtensionCommand } from "./BrowserExtensionShortcuts.ts";

/** Installed into persistent preview profiles. */
const DEFAULT_EXTENSION_IDS = ["aeblfdkhhhdcdjpifhhbdiojplfjncoa"]; // 1Password
const PREVIEW_PARTITION_PATH = /[\\/]Partitions[\\/]t3code-preview-[^\\/]+[\\/]?$/u;
const EXECUTE_ACTION_COMMAND = "_execute_action";
const POPUP_ANCHOR_SIZE = 40;
const POPUP_ANCHOR_TOP = 40;

// Private electron-chrome-extensions@4.10 members: Chrome opens popups from a toolbar T3 lacks.
interface ExtensionsInternals {
  readonly api: {
    readonly browserAction: {
      readonly activateClick: (details: {
        readonly eventType: "click";
        readonly extensionId: string;
        readonly tabId: number;
        readonly anchorRect: Electron.Rectangle;
      }) => void;
    };
  };
  readonly ctx: {
    readonly router: {
      readonly sendEvent: (extensionId: string, eventName: string, ...args: unknown[]) => void;
    };
  };
}

type Report = (message: string, cause: unknown) => void;

const pendingSessions = new Map<Session, Promise<ElectronChromeExtensions>>();
const readySessions = new Set<Session>();
const propagatingPaths = new WeakMap<Session, Set<string>>();
const extensionWindows = new WeakSet<Electron.BaseWindow>();
let report: Report = () => undefined;
let platform: NodeJS.Platform = "darwin";
let libraries:
  | Promise<
      readonly [
        typeof import("electron-chrome-extensions"),
        typeof import("electron-chrome-web-store"),
      ]
    >
  | undefined;

const openExtensionWindow = (session: Session, url: string | undefined): BrowserWindow => {
  const window = new BrowserWindow({
    width: 1000,
    height: 760,
    autoHideMenuBar: true,
    webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  extensionWindows.add(window);
  if (url) window.loadURL(url).catch((cause) => report("extension window failed to load", cause));
  return window;
};

const closeExtensionWindow = (window: Electron.BaseWindow): void => {
  if (extensionWindows.has(window) && !window.isDestroyed()) window.close();
};

// Profiles share one extensions directory; a load in any profile, including an update, reaches the rest.
const propagate = (source: Session, extension: Electron.Extension): void => {
  for (const target of readySessions) {
    if (target === source) continue;
    const current = target.extensions.getExtension(extension.id);
    if (current?.version === extension.version) continue;
    const pending = propagatingPaths.get(target) ?? new Set<string>();
    propagatingPaths.set(target, pending);
    if (pending.has(extension.path)) continue;
    pending.add(extension.path);
    if (current) target.extensions.removeExtension(extension.id);
    target.extensions.loadExtension(extension.path).catch((cause) => {
      pending.delete(extension.path);
      report(`failed to load extension ${extension.id} into a preview profile`, cause);
    });
  }
};

const confirmInstall = async (details: {
  readonly localizedName: string;
  readonly browserWindow?: BrowserWindow;
}): Promise<{ action: "allow" | "deny" }> => {
  const options = {
    type: "question" as const,
    buttons: ["Add Extension", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: `Add “${details.localizedName}” to the T3 Code browser?`,
  };
  const { response } = details.browserWindow
    ? await dialog.showMessageBox(details.browserWindow, options)
    : await dialog.showMessageBox(options);
  return { action: response === 0 ? "allow" : "deny" };
};

const setUpSession = async (
  session: Session,
  preloadPath: string,
  primary: boolean,
): Promise<ElectronChromeExtensions> => {
  libraries ??= Promise.all([
    import("electron-chrome-extensions"),
    import("electron-chrome-web-store"),
  ]);
  const [{ ElectronChromeExtensions }, webStore] = await libraries;
  const extensions = new ElectronChromeExtensions({
    session,
    createTab: async (details) => {
      const window = openExtensionWindow(session, details.url);
      return [window.webContents, window];
    },
    selectTab: (_tab, window) => {
      if (extensionWindows.has(window)) window.focus();
    },
    removeTab: (_tab, window) => closeExtensionWindow(window),
    createWindow: async (details) =>
      openExtensionWindow(session, Array.isArray(details.url) ? details.url[0] : details.url),
    removeWindow: closeExtensionWindow,
  });
  // Runs after the library's preload, which only patches `chrome`.
  for (const type of ["frame", "service-worker"] as const) {
    session.registerPreloadScript({
      id: `t3code-extension-namespace-${type}`,
      type,
      filePath: preloadPath,
    });
  }
  session.extensions.on("extension-loaded", (_event, extension) => {
    if (propagatingPaths.get(session)?.delete(extension.path)) return;
    propagate(session, extension);
  });
  readySessions.add(session);
  loadExtensions(session, webStore, primary).catch((cause) =>
    report("failed to load preview browser extensions", cause),
  );
  return extensions;
};

const loadExtensions = async (
  session: Session,
  webStore: typeof import("electron-chrome-web-store"),
  primary: boolean,
): Promise<void> => {
  // The first profile owns update checks; propagation moves the others to each new version.
  await webStore.installChromeWebStore({
    session,
    autoUpdate: primary,
    beforeInstall: confirmInstall,
  });
  if (!primary) return;
  for (const id of DEFAULT_EXTENSION_IDS) {
    if (!session.extensions.getExtension(id)) await webStore.installExtension(id, { session });
  }
};

/** Adds Chrome extension support to persistent preview profiles as Electron creates them. */
export const install = (options: {
  readonly preloadPath: string;
  readonly platform: NodeJS.Platform;
  readonly enabled: boolean;
  readonly report: Report;
}): void => {
  if (!options.enabled) return;
  report = options.report;
  platform = options.platform;
  app.on("session-created", (session) => {
    if (!session.isPersistent() || !PREVIEW_PARTITION_PATH.test(session.storagePath ?? "")) return;
    const setup = setUpSession(session, options.preloadPath, pendingSessions.size === 0);
    pendingSessions.set(session, setup);
    setup.catch((cause) => report("failed to set up preview browser extensions", cause));
  });
};

const runCommand = (
  extensions: ElectronChromeExtensions,
  guest: WebContents,
  input: Electron.Input,
): boolean => {
  for (const extension of guest.session.extensions.getAllExtensions()) {
    const manifest = extension.manifest as {
      readonly commands?: Parameters<typeof findExtensionCommand>[0];
    };
    const command = findExtensionCommand(manifest.commands, input, platform);
    if (command === undefined) continue;
    const internals = extensions as unknown as ExtensionsInternals;
    if (command === EXECUTE_ACTION_COMMAND) {
      const host = guest.hostWebContents
        ? BrowserWindow.fromWebContents(guest.hostWebContents)
        : null;
      const width = host?.getContentSize()[0] ?? POPUP_ANCHOR_SIZE;
      internals.api.browserAction.activateClick({
        eventType: "click",
        extensionId: extension.id,
        tabId: guest.id,
        anchorRect: {
          x: width - POPUP_ANCHOR_SIZE,
          y: POPUP_ANCHOR_TOP,
          width: POPUP_ANCHOR_SIZE,
          height: POPUP_ANCHOR_SIZE,
        },
      });
    } else {
      internals.ctx.router.sendEvent(extension.id, "commands.onCommand", command);
    }
    return true;
  }
  return false;
};

const registerGuest = (
  extensions: ElectronChromeExtensions,
  window: BrowserWindow,
  guest: WebContents,
): void => {
  if (guest.isDestroyed() || window.isDestroyed()) return;
  extensions.addTab(guest, window);
  extensions.selectTab(guest);
  guest.on("focus", () => extensions.selectTab(guest));
  guest.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.isAutoRepeat) return;
    try {
      if (runCommand(extensions, guest, input)) event.preventDefault();
    } catch (cause) {
      report("extension command failed", cause);
    }
  });
};

/** Exposes a preview guest to extensions as a tab and routes their keyboard commands. */
export const attachGuest = (window: BrowserWindow, guest: WebContents): void => {
  pendingSessions
    .get(guest.session)
    ?.then((extensions) => registerGuest(extensions, window, guest))
    .catch((cause) => report("failed to attach a preview tab to extensions", cause));
};
