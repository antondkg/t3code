/** Keep bundler externals aligned with the staged production dependency list. */
const DESKTOP_RUNTIME_EXTERNAL_PREFIXES = [
  "@napi-rs/keyring",
  "@crowecawcaw/xa11y",
  "@clerk/electron-passkeys",
  "electron-webauthn",
  // Both resolve their sandboxed preload scripts from their own package directories.
  "electron-chrome-extensions",
  "electron-chrome-web-store",
  "ffi-rs",
  "@yuuang/",
  // Playwright reads its runtime bundle/driver from disk; inlining cannot replace those files.
  "playwright-core",
] as const;

export function isDesktopRuntimeExternalDependency(id: string): boolean {
  return DESKTOP_RUNTIME_EXTERNAL_PREFIXES.some((prefix) => id.startsWith(prefix));
}

export function selectDesktopRuntimeExternalDependencies(
  dependencies: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dependencies).filter(([name]) => isDesktopRuntimeExternalDependency(name)),
  );
}
