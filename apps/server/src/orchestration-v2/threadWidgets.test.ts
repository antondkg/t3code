import { describe, expect, it } from "vite-plus/test";
import * as Result from "effect/Result";
import { MAX_THREAD_WIDGETS, ThreadWidgetData, type ThreadWidget } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { updateThreadWidgets } from "./threadWidgets.ts";

const isWidgetData = Schema.is(ThreadWidgetData);

const widget: ThreadWidget = {
  id: "status",
  title: "Status",
  attachmentId: "status-html",
  height: 240,
  updatedAt: "2026-01-01T00:00:00.000Z",
  data: { done: 1 },
};

describe("updateThreadWidgets", () => {
  it("requires a document for creation and enforces the limit without blocking existing updates", () => {
    expect(
      Result.isFailure(updateThreadWidgets([], { id: "new", data: {} }, widget.updatedAt)),
    ).toBe(true);
    const widgets = Array.from({ length: MAX_THREAD_WIDGETS }, (_, index) => ({
      ...widget,
      id: `widget-${index}`,
    }));
    expect(
      Result.isFailure(
        updateThreadWidgets(widgets, { id: "new", document: widget }, widget.updatedAt),
      ),
    ).toBe(true);
    const update = updateThreadWidgets(
      widgets,
      { id: "widget-0", document: { ...widget, attachmentId: "new-html" } },
      widget.updatedAt,
    );
    expect(Result.isSuccess(update) && update.success[0]).toMatchObject({
      attachmentId: "new-html",
      data: { done: 1 },
    });
    expect(widgets[0]?.attachmentId).toBe("status-html");
    expect(isWidgetData({ log: "x".repeat(16_384) })).toBe(false);
  });
});
