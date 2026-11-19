import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const MAX_THREAD_WIDGETS = 8;
export const ThreadWidgetId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,64}$/));
export const ThreadWidgetData = Schema.Json.check(
  Schema.makeFilter(
    (data) => JSON.stringify(data).length <= 16_384 || "Widget data exceeds 16 KB.",
  ),
);
export const ThreadWidgetDocument = Schema.Struct({
  attachmentId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  height: Schema.Int.check(Schema.isBetween({ minimum: 80, maximum: 2000 })),
});
export const ThreadWidget = Schema.Struct({
  id: ThreadWidgetId,
  ...ThreadWidgetDocument.fields,
  data: Schema.optional(ThreadWidgetData),
  updatedAt: IsoDateTime,
});
export type ThreadWidget = typeof ThreadWidget.Type;

export const ThreadWidgetUpdate = Schema.Struct({
  id: ThreadWidgetId,
  document: Schema.optional(ThreadWidgetDocument),
  data: Schema.optional(ThreadWidgetData),
  remove: Schema.optional(Schema.Boolean),
});
export type ThreadWidgetUpdate = typeof ThreadWidgetUpdate.Type;
