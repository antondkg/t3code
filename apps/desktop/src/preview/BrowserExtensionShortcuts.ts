export interface ShortcutInput {
  readonly key: string;
  readonly meta: boolean;
  readonly control: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

interface ManifestCommand {
  readonly suggested_key?: Readonly<Record<string, string | undefined>>;
}

const SPECIAL_KEYS: Readonly<Record<string, string>> = {
  comma: ",",
  period: ".",
  space: " ",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
};

const platformKey = (platform: NodeJS.Platform): string =>
  platform === "darwin" ? "mac" : platform === "win32" ? "windows" : platform;

// Chrome maps Ctrl to Command on macOS unless the manifest says MacCtrl.
const matchesSuggestedKey = (
  suggested: string,
  input: ShortcutInput,
  platform: NodeJS.Platform,
): boolean => {
  const parts = suggested.split("+").map((part) => part.trim().toLowerCase());
  const key = parts.pop();
  if (!key) return false;
  const mac = platform === "darwin";
  const wanted = { meta: false, control: false, alt: false, shift: false };
  for (const modifier of parts) {
    if (modifier === "command" || (modifier === "ctrl" && mac)) wanted.meta = true;
    else if (modifier === "ctrl" || modifier === "macctrl") wanted.control = true;
    else if (modifier === "alt" || modifier === "option") wanted.alt = true;
    else if (modifier === "shift") wanted.shift = true;
    else return false;
  }
  return (
    input.meta === wanted.meta &&
    input.control === wanted.control &&
    input.alt === wanted.alt &&
    input.shift === wanted.shift &&
    input.key.toLowerCase() === (SPECIAL_KEYS[key] ?? key)
  );
};

/** The manifest command bound to this key press, using Chrome's per-platform suggested keys. */
export const findExtensionCommand = (
  commands: Readonly<Record<string, ManifestCommand>> | undefined,
  input: ShortcutInput,
  platform: NodeJS.Platform,
): string | undefined => {
  if (!commands) return undefined;
  for (const [name, command] of Object.entries(commands)) {
    const suggested = command.suggested_key;
    const binding = suggested?.[platformKey(platform)] ?? suggested?.default;
    if (binding && matchesSuggestedKey(binding, input, platform)) return name;
  }
  return undefined;
};
