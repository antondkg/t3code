import {
  CommandId,
  type ThreadId,
  type ThreadWidget,
  type ThreadWidgetUpdate,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as HtmlRender from "./HtmlRender.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

export class ThreadWidgetRequestError extends Schema.TaggedError<ThreadWidgetRequestError>()(
  "ThreadWidgetRequestError",
  { reason: Schema.Literals(["missing-document", "conflicting-source"]) },
) {
  override get message() {
    return this.reason === "missing-document"
      ? "A new widget needs html or path."
      : "Pass exactly one of html or path.";
  }
}

type WidgetFailure =
  | ThreadWidgetRequestError
  | Effect.Error<ReturnType<HtmlRender.HtmlRender["Service"]["publish"]>>
  | Effect.Error<ReturnType<ThreadManagement.ThreadManagementService["Service"]["dispatch"]>>
  | Effect.Error<
      ReturnType<ThreadManagement.ThreadManagementService["Service"]["getThreadRecords"]>
    >;

interface WidgetInput {
  readonly threadId: ThreadId;
  readonly id: string;
  readonly html?: string | undefined;
  readonly path?: string | undefined;
  readonly title?: string | undefined;
  readonly height?: number | undefined;
  readonly data?: ThreadWidgetUpdate["data"] | undefined;
  readonly remove?: boolean | undefined;
}

export class ThreadWidgets extends Context.Service<
  ThreadWidgets,
  {
    readonly list: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<ThreadWidget>, WidgetFailure>;
    readonly update: (
      input: WidgetInput,
    ) => Effect.Effect<ReadonlyArray<ThreadWidget>, WidgetFailure>;
  }
>()("t3/htmlRender/ThreadWidgets") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const renderer = yield* HtmlRender.HtmlRender;
  const random = yield* SecureRandom.SecureRandom;
  const list = Effect.fn("ThreadWidgets.list")(function* (threadId: ThreadId) {
    return (yield* threads.getThreadRecords(threadId, [])).thread.widgets ?? [];
  });
  const update = Effect.fn("ThreadWidgets.update")(function* (input: WidgetInput) {
    if (input.html !== undefined && input.path !== undefined) {
      return yield* new ThreadWidgetRequestError({ reason: "conflicting-source" });
    }
    const widgets = yield* list(input.threadId);
    const previous = widgets.find((widget) => widget.id === input.id);
    const source =
      input.html !== undefined
        ? { html: input.html }
        : input.path !== undefined
          ? { path: input.path }
          : undefined;
    if (!input.remove && !source && !previous) {
      return yield* new ThreadWidgetRequestError({ reason: "missing-document" });
    }
    const document =
      source && !input.remove
        ? yield* renderer.publish({
            ...source,
            threadId: input.threadId,
            title: input.title ?? previous?.title ?? input.id,
            height: input.height ?? previous?.height ?? 240,
            placement: "thread-details",
          })
        : undefined;
    yield* threads.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make(yield* random.uuidV4()),
      threadId: input.threadId,
      widget: {
        id: input.id,
        ...(document ? { document } : {}),
        ...(input.data === undefined ? {} : { data: input.data }),
        ...(input.remove ? { remove: true } : {}),
      },
    });
    return yield* list(input.threadId);
  });
  return ThreadWidgets.of({ list, update });
});

export const layer = Layer.effect(ThreadWidgets, make);
