import { MAX_THREAD_WIDGETS, type ThreadWidget, type ThreadWidgetUpdate } from "@t3tools/contracts";
import * as Result from "effect/Result";

export function updateThreadWidgets(
  widgets: ReadonlyArray<ThreadWidget>,
  update: ThreadWidgetUpdate,
  updatedAt: string,
) {
  const previous = widgets.find((widget) => widget.id === update.id);
  if (update.remove) return Result.succeed(widgets.filter((widget) => widget.id !== update.id));
  if (!previous && !update.document) return Result.fail("A new widget needs html or path.");
  if (!previous && widgets.length >= MAX_THREAD_WIDGETS) {
    return Result.fail(
      `A thread can have at most ${MAX_THREAD_WIDGETS} widgets. Remove one first.`,
    );
  }
  const document = update.document ?? previous!;
  const next: ThreadWidget = {
    ...previous,
    id: update.id,
    attachmentId: document.attachmentId,
    title: document.title,
    height: document.height,
    ...(update.data === undefined ? {} : { data: update.data }),
    updatedAt,
  };
  return Result.succeed(
    previous
      ? widgets.map((widget) => (widget.id === update.id ? next : widget))
      : [...widgets, next],
  );
}
