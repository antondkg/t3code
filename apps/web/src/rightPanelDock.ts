import * as Schema from "effect/Schema";

import { useLocalStorage } from "./hooks/useLocalStorage";

export type RightPanelDock = "right" | "bottom";

const RIGHT_PANEL_DOCK_STORAGE_KEY = "t3code:right-panel-dock";
const RightPanelDockSchema = Schema.Literals(["right", "bottom"]);

/** Where the side panel sits on wide layouts. Saved per device, like other layout choices. */
export function useRightPanelDock() {
  return useLocalStorage<RightPanelDock, RightPanelDock>(
    RIGHT_PANEL_DOCK_STORAGE_KEY,
    "right",
    RightPanelDockSchema,
  );
}
