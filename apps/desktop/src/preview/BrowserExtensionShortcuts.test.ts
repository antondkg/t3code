import { describe, expect, it } from "vite-plus/test";

import { findExtensionCommand } from "./BrowserExtensionShortcuts.ts";

// 1Password's manifest commands.
const commands = {
  _execute_action: {
    suggested_key: { default: "Ctrl+Shift+X", mac: "Command+Shift+X" },
  },
  lock: { suggested_key: { default: "Ctrl+Shift+L", mac: "Command+Shift+L" } },
  fill: { suggested_key: { default: "Ctrl+Period", mac: "MacCtrl+Period" } },
};

const press = (
  key: string,
  modifiers: Partial<Record<"meta" | "control" | "alt" | "shift", boolean>>,
) => ({
  key,
  meta: false,
  control: false,
  alt: false,
  shift: false,
  ...modifiers,
});

describe("findExtensionCommand", () => {
  it("uses each platform's suggested key with Chrome's modifier mapping", () => {
    expect(findExtensionCommand(commands, press("X", { meta: true, shift: true }), "darwin")).toBe(
      "_execute_action",
    );
    expect(
      findExtensionCommand(commands, press("x", { control: true, shift: true }), "linux"),
    ).toBe("_execute_action");
    expect(findExtensionCommand(commands, press("L", { meta: true, shift: true }), "darwin")).toBe(
      "lock",
    );
    expect(findExtensionCommand(commands, press(".", { control: true }), "darwin")).toBe("fill");
  });

  it("requires the exact modifiers", () => {
    expect(
      findExtensionCommand(commands, press("X", { control: true, shift: true }), "darwin"),
    ).toBeUndefined();
    expect(
      findExtensionCommand(commands, press("X", { meta: true, shift: true, alt: true }), "darwin"),
    ).toBeUndefined();
    expect(findExtensionCommand(commands, press("x", { meta: true }), "darwin")).toBeUndefined();
  });
});
