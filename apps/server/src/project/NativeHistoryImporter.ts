// @effect-diagnostics nodeBuiltinImport:off -- transcript hashes and attachment buffers are boundary data.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import {
  ChatAttachment,
  ChatAttachmentId,
  EventId,
  OrchestrationV2ConversationMessageJson,
  OrchestrationV2TurnItemJson,
  type ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { nativeSourceMessageId } from "@t3tools/provider-acp/server/adapter";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import { importedHistoryOrdinalBoundary } from "../orchestration-v2/TurnItemPositionStore.ts";
import * as ServerConfig from "../config.ts";
import { createDeterministicAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";

class NativeHistoryImportError extends Schema.TaggedError<NativeHistoryImportError>()(
  "NativeHistoryImportError",
  { detail: Schema.String },
) {}
const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeMessage = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ConversationMessageJson),
);
const encodeItem = Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2TurnItemJson));
const decodeAttachment = Schema.decodeUnknownEffect(ChatAttachment);

const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sink = yield* EventSink.EventSinkV2;
  const commands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const lock = yield* KeyedLock.make<ThreadId>();
  const tracked = new Set<ThreadId>();
  const refresh = Effect.fn("NativeHistoryImporter.refresh")(function* (threadId: ThreadId) {
    return yield* lock.withLock(
      threadId,
      Effect.gen(function* () {
        const records = yield* orchestrator.getThreadRecords(threadId, [
          "providerThreads",
          "runs",
          "providerTurns",
          "messages",
          "turnItems",
        ]);
        if (records.thread.deletedAt !== null) {
          tracked.delete(threadId);
          return null;
        }
        const instance = yield* registry.getInstance(records.thread.providerInstanceId);
        if (instance?.enabled !== true || instance.nativeHistorySourceInstanceId === undefined)
          return null;
        const source = yield* registry.getInstance(instance.nativeHistorySourceInstanceId);
        if (source?.enabled !== true || source.nativeHistory === undefined) return null;
        const providerThread = records.providerThreads.find(
          (thread) => thread.id === records.thread.activeProviderThreadId,
        );
        if (providerThread?.nativeThreadRef == null) return null;
        tracked.add(threadId);
        if (
          records.runs.some(
            (run) =>
              !["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(
                run.status,
              ),
          )
        )
          return 0;
        const snapshot = yield* source.nativeHistory
          .read(providerThread, providerThread.nativeMetadata?.historySourceRevision)
          .pipe(Effect.timeout("60 seconds"));
        if (snapshot === null) return 0;
        // Live ACP records belong to their T3 runs. Strong native turn refs prevent replay duplicates.
        const ownedTurns = new Set(
          records.providerTurns.flatMap((turn) =>
            turn.nativeTurnRef?.strength === "strong" ? [turn.nativeTurnRef.nativeId] : [],
          ),
        );
        const ownedMessages = new Set(
          records.turnItems.flatMap((item) => {
            if (
              item.runId === null ||
              item.nativeItemRef?.driver !== "acpRegistry" ||
              item.nativeItemRef.nativeId === null
            )
              return [];
            const id = nativeSourceMessageId(item.nativeItemRef.nativeId);
            return id === undefined ? [] : [id];
          }),
        );
        const ownedItems = new Set(
          records.turnItems.flatMap((item) =>
            item.runId !== null &&
            item.nativeItemRef?.strength === "strong" &&
            item.nativeItemRef.nativeId !== null
              ? [item.nativeItemRef.nativeId]
              : [],
          ),
        );
        const turns = snapshot.turns.filter(
          (turn) =>
            !ownedTurns.has(turn.nativeTurnId) &&
            !turn.nativeMessageIds.some((id) => ownedMessages.has(id)) &&
            !turn.nativeToolIds.some((id) => ownedItems.has(id)),
        );
        const messages = turns.flatMap((turn) => turn.messages);
        const positions = new Map<number, number>();
        const turnItems = turns.flatMap((turn) => {
          const start = turn.messages[0]?.createdAt ?? turn.turnItems[0]?.startedAt;
          const preceding =
            start == null
              ? undefined
              : records.runs
                  .filter(
                    (run) =>
                      DateTime.toEpochMillis(run.requestedAt) <= DateTime.toEpochMillis(start),
                  )
                  .sort((a, b) => b.ordinal - a.ordinal)[0];
          const band =
            preceding === undefined ? 0 : importedHistoryOrdinalBoundary(preceding.ordinal);
          return turn.turnItems.map((item) => {
            const ordinal = (positions.get(band) ?? band) + 1;
            positions.set(band, ordinal);
            return { ...item, ordinal };
          });
        });
        const revision = NodeCrypto.createHash("sha256")
          .update(
            yield* encodeSnapshot({
              turns,
              attachments: snapshot.attachments,
              sourceRevision: snapshot.sourceRevision,
              modelSelection: snapshot.modelSelection,
            }),
          )
          .digest("hex");
        if (providerThread.nativeMetadata?.historyRevision === revision) return messages.length;
        const byMessage = new Map<string, Array<ChatAttachment>>();
        for (const file of snapshot.attachments) {
          if (!messages.some((message) => message.id === file.messageId)) continue;
          const bytes = Buffer.from(file.data, "base64");
          const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
          const name = NodePath.basename(file.name).slice(0, 255) || "attachment";
          const id = createDeterministicAttachmentId(
            threadId,
            `${file.messageId}:${file.index}:${digest}`,
          );
          if (id === null)
            return yield* new NativeHistoryImportError({
              detail: "Cannot allocate native attachment ID",
            });
          const attachment = yield* decodeAttachment({
            type: file.mimeType.startsWith("image/") ? "image" : "file",
            id: ChatAttachmentId.make(id),
            name,
            mimeType: file.mimeType,
            sizeBytes: bytes.length,
          });
          const destination = resolveAttachmentPath({
            attachmentsDir: config.attachmentsDir,
            attachment,
          });
          if (destination === null)
            return yield* new NativeHistoryImportError({
              detail: "Cannot resolve native attachment path",
            });
          yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
          if (!(yield* fs.exists(destination))) {
            const temporary = `${destination}.${NodeCrypto.randomUUID()}.part`;
            yield* fs
              .writeFile(temporary, bytes)
              .pipe(
                Effect.andThen(fs.rename(temporary, destination)),
                Effect.ensuring(fs.remove(temporary).pipe(Effect.ignore)),
              );
          }
          const list = byMessage.get(file.messageId) ?? [];
          list.push(attachment);
          byMessage.set(file.messageId, list);
        }
        return yield* commands.withLock(
          threadId,
          Effect.gen(function* () {
            const current = yield* orchestrator.getThreadRecords(threadId, [
              "runs",
              "messages",
              "turnItems",
              "providerThreads",
            ]);
            // Recheck after the network read so a newly started run cannot be overwritten.
            if (
              current.runs.length !== records.runs.length ||
              current.runs.some(
                (run) =>
                  !["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(
                    run.status,
                  ),
              )
            )
              return 0;
            const currentProviderThread = current.providerThreads.find(
              (thread) => thread.id === providerThread.id,
            );
            if (
              currentProviderThread === undefined ||
              current.thread.activeProviderThreadId !== providerThread.id ||
              current.thread.providerInstanceId !== records.thread.providerInstanceId
            )
              return 0;
            if (
              (yield* registry.getInstance(instance.instanceId)) !== instance ||
              (yield* registry.getInstance(source.instanceId)) !== source
            )
              return 0;
            const desiredMessages = messages.map((message) => ({
              ...message,
              attachments: byMessage.get(message.id) ?? [],
            }));
            const desiredItems = turnItems.map((item) =>
              item.type === "user_message"
                ? { ...item, attachments: byMessage.get(item.messageId) ?? [] }
                : item,
            );
            const currentMessages = new Map(
              current.messages.map((message) => [message.id, message]),
            );
            const currentItems = new Map(current.turnItems.map((item) => [item.id, item]));
            const messageIds = new Set(desiredMessages.map((message) => message.id));
            const itemIds = new Set(desiredItems.map((item) => item.id));
            const changedMessages = yield* Effect.filter(desiredMessages, (message) => {
              const previous = currentMessages.get(message.id);
              return previous === undefined
                ? Effect.succeed(true)
                : Effect.all([encodeMessage(previous), encodeMessage(message)]).pipe(
                    Effect.map(([a, b]) => a !== b),
                  );
            });
            const changedItems = yield* Effect.filter(desiredItems, (item) => {
              const previous = currentItems.get(item.id);
              return previous === undefined
                ? Effect.succeed(true)
                : Effect.all([encodeItem(previous), encodeItem(item)]).pipe(
                    Effect.map(([a, b]) => a !== b),
                  );
            });
            const movedItems = new Set(
              desiredItems
                .filter((item) => {
                  const previous = currentItems.get(item.id);
                  return previous !== undefined && previous.ordinal !== item.ordinal;
                })
                .map((item) => item.id),
            );
            const at = yield* DateTime.now;
            const prefix = `native-history:${threadId}:${NodeCrypto.randomUUID()}`;
            const events: Array<OrchestrationV2DomainEvent> = [
              {
                id: EventId.make(`${prefix}:remove`),
                threadId,
                occurredAt: at,
                type: "transcript.items-removed",
                payload: {
                  messageIds: current.messages
                    .filter((message) => message.runId === null && !messageIds.has(message.id))
                    .map((message) => message.id),
                  turnItemIds: current.turnItems
                    .filter(
                      (item) =>
                        item.runId === null && (!itemIds.has(item.id) || movedItems.has(item.id)),
                    )
                    .map((item) => item.id),
                  positions: desiredItems
                    .filter((item) => !currentItems.has(item.id) || movedItems.has(item.id))
                    .map(({ id, ordinal }) => ({ id, ordinal })),
                },
              },
            ];
            for (const message of changedMessages)
              events.push({
                id: EventId.make(`${prefix}:message:${message.id}`),
                threadId,
                occurredAt: at,
                type: "message.updated",
                payload: message,
              });
            for (const item of changedItems)
              events.push({
                id: EventId.make(`${prefix}:item:${item.id}`),
                threadId,
                occurredAt: at,
                type: "turn-item.updated",
                payload: item,
              });
            events.push({
              id: EventId.make(`${prefix}:provider`),
              threadId,
              occurredAt: at,
              type: "provider-thread.updated",
              payload: {
                ...currentProviderThread,
                status: "idle",
                nativeMetadata: {
                  ...currentProviderThread.nativeMetadata,
                  historyRevision: revision,
                  historySourceRevision: snapshot.sourceRevision,
                },
              },
            });
            events.push({
              id: EventId.make(`${prefix}:thread`),
              threadId,
              occurredAt: at,
              type: "thread.metadata-updated",
              payload: {
                ...current.thread,
                historyOrigin: "v1_import",
                // Reflect the existing native model; this is hydration, not a provider switch.
                ...(current.thread.modelSelection.model === "default" &&
                snapshot.modelSelection !== undefined
                  ? { modelSelection: snapshot.modelSelection }
                  : {}),
                ...(current.runs.length === 0
                  ? { settledOverride: "settled", settledAt: at, unsettledAt: null }
                  : {}),
              },
            });
            yield* sink.write({ events });
            return messages.length;
          }),
        );
      }),
    );
  });
  // Track only chats actually opened/imported. A failed native read leaves the existing transcript intact.
  yield* Effect.forever(
    Effect.sleep("60 seconds").pipe(
      Effect.andThen(() =>
        Effect.forEach(
          [...tracked],
          (id) =>
            refresh(id).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Native history refresh failed", { threadId: id, cause }),
              ),
            ),
          { concurrency: 1, discard: true },
        ),
      ),
    ),
  ).pipe(Effect.forkScoped);
  return { refresh };
});
export class NativeHistoryImporter extends Context.Service<
  NativeHistoryImporter,
  Effect.Success<typeof make>
>()("t3/project/NativeHistoryImporter") {}
export const layer = Layer.effect(NativeHistoryImporter, make);
