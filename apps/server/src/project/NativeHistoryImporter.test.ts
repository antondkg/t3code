import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  MessageId,
  TurnItemId,
  ProviderThreadId,
  RunId,
  type OrchestrationV2TurnItem,
  ThreadId,
  ProviderInstanceId,
  ProviderDriverKind,
  OrchestrationV2AppThread,
  OrchestrationV2ProviderThread,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import type { ProviderInstance, NativeHistorySnapshot } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as Registry from "../provider/ProviderInstanceRegistry.ts";
import * as NativeHistoryImporter from "./NativeHistoryImporter.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";

const threadId = ThreadId.make("native-history-test");
const instanceId = ProviderInstanceId.make("acp");
const sourceId = ProviderInstanceId.make("native");
const driver = ProviderDriverKind.make("acpRegistry");
const now = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
const decodeThread = Schema.decodeUnknownSync(OrchestrationV2AppThread);
const decodeProviderThread = Schema.decodeUnknownSync(OrchestrationV2ProviderThread);
const thread = decodeThread({
  id: threadId,
  createdBy: "user",
  creationSource: "server",
  projectId: "project",
  title: "History",
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "default" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  linkedPullRequest: null,
  branchPullRequest: null,
  activeProviderThreadId: "provider-thread",
  historyOrigin: "v1_import",
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  unsettledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  pinnedAt: null,
  pinOrderKey: null,
  activeOrderKey: null,
  lastVisitedAt: null,
  deletedAt: null,
});
const providerThread = decodeProviderThread({
  id: "provider-thread",
  driver,
  providerInstanceId: instanceId,
  appThreadId: threadId,
  providerSessionId: null,
  ownerNodeId: null,
  nativeThreadRef: { driver, nativeId: "ses_native", strength: "strong" },
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  pendingBackgroundTasks: [],
  createdAt: now,
  updatedAt: now,
});
function provider(id: typeof instanceId): ProviderInstance {
  return {
    instanceId: id,
    driverKind: driver,
    continuationIdentity: { driverKind: driver, continuationKey: String(id) },
    displayName: undefined,
    enabled: true,
    snapshot: {
      getSnapshot: Effect.die("unused"),
      refresh: Effect.die("unused"),
      resolveMaintenance: () => Effect.die("unused"),
      streamChanges: Stream.empty,
      applyUsageLimits: () => Effect.void,
    },
    orchestrationAdapter: {
      instanceId: id,
      driver,
      getCapabilities: () => Effect.die("unused"),
      planSelectionTransition: () => Effect.die("unused"),
      openSession: () => Effect.die("ACP must not be opened for a history read"),
    },
    textGeneration: {
      generateThreadTitle: () => Effect.die("unused"),
      generateCommitMessage: () => Effect.die("unused"),
      generatePrContent: () => Effect.die("unused"),
      generateBranchName: () => Effect.die("unused"),
      generateReviewGuide: () => Effect.die("unused"),
    },
  };
}
const message = (id: string, text: string): OrchestrationV2ConversationMessage => ({
  id: MessageId.make(id),
  threadId,
  runId: null,
  nodeId: null,
  role: "user",
  text,
  attachments: [],
  streaming: false,
  createdBy: "user",
  creationSource: "provider",
  createdAt: now,
  updatedAt: now,
});
function tool(id: string): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make(id),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: ProviderThreadId.make("provider-thread"),
    providerTurnId: null,
    nativeItemRef: { driver, nativeId: id, strength: "strong" },
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "command_execution",
    input: "pwd",
    output: "/tmp",
  };
}
const stores = Layer.mergeAll(ProjectionStore.layer, EventStore.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
);
const sinkLayer = EventSink.layer.pipe(Layer.provideMerge(stores));
it.effect(
  "repairs old copies transactionally, retains native binding, imports bytes and makes repeat refresh idempotent",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* sink.write({
        events: [
          {
            id: EventId.make("create"),
            threadId,
            occurredAt: now,
            type: "thread.created",
            payload: thread,
          },
          {
            id: EventId.make("binding"),
            threadId,
            occurredAt: now,
            type: "provider-thread.updated",
            payload: providerThread,
          },
          {
            id: EventId.make("old"),
            threadId,
            occurredAt: now,
            type: "message.updated",
            payload: message("old-ordinal", "old replay"),
          },
        ],
      });
      yield* sink.write({
        events: [
          {
            id: EventId.make("old-tool"),
            threadId,
            occurredAt: now,
            type: "turn-item.updated",
            payload: tool("old-tool"),
          },
          {
            id: EventId.make("owned-message"),
            threadId,
            occurredAt: now,
            type: "message.updated",
            payload: {
              ...message("owned-message", "T3-owned work"),
              runId: RunId.make("owned-run"),
            },
          },
        ],
      });
      const original = message("native-message", "full native history");
      let snapshot: NativeHistorySnapshot = {
        sourceRevision: "revision-1",
        turns: [
          {
            nativeTurnId: "native-message",
            messages: [original],
            turnItems: [tool("native-tool")],
          },
        ],
        attachments: [
          {
            messageId: original.id,
            index: 0,
            name: "note.txt",
            mimeType: "text/plain",
            data: "aGk=",
          },
        ],
      };
      let reads = 0;
      const source = {
        ...provider(sourceId),
        nativeHistory: {
          read: (_thread: OrchestrationV2ProviderThread, revision?: string) =>
            Effect.sync(() => {
              reads++;
              return revision === snapshot.sourceRevision ? null : snapshot;
            }),
        },
      };
      const acp = { ...provider(instanceId), nativeHistorySourceInstanceId: sourceId };
      const importer = yield* NativeHistoryImporter.NativeHistoryImporter.pipe(
        Effect.provide(
          NativeHistoryImporter.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(EventSink.EventSinkV2, sink),
                ThreadCommandExecutor.layer,
                Layer.mock(Orchestrator.OrchestratorV2)({
                  getThreadRecords: (id, fields) =>
                    projections
                      .getThreadRecords(id, fields)
                      .pipe(
                        Effect.mapError(
                          (cause) =>
                            new Orchestrator.OrchestratorProjectionError({ threadId: id, cause }),
                        ),
                      ),
                }),
                Layer.mock(Registry.ProviderInstanceRegistry)({
                  getInstance: (id) => Effect.succeed(id === sourceId ? source : acp),
                }),
              ),
            ),
          ),
        ),
      );
      assert.equal(yield* importer.refresh(threadId), 1);
      const after = yield* projections.getThreadRecords(threadId, ["messages", "providerThreads"]);
      assert.deepEqual(
        after.messages.filter((row) => row.runId === null).map((row) => row.text),
        ["full native history"],
      );
      assert.equal(after.providerThreads[0]!.nativeThreadRef!.nativeId, "ses_native");
      assert.equal(after.thread.settledOverride, "settled");
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const attachment = after.messages.find((row) => row.id === original.id)!.attachments[0]!;
      const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
      assert.isNotNull(path);
      assert.equal(yield* fs.readFileString(path!), "hi");
      const repairedItems = (yield* projections.getThreadRecords(threadId, ["turnItems"]))
        .turnItems;
      assert.deepEqual(
        repairedItems.map((item) => [item.id, item.ordinal]),
        [["native-tool", 1]],
      );
      assert.equal(after.messages.find((row) => row.id === "owned-message")?.text, "T3-owned work");
      assert.equal(yield* importer.refresh(threadId), 0);
      assert.equal(reads, 2);
      assert.deepEqual(
        (yield* projections.getThreadRecords(threadId, ["messages"])).messages,
        after.messages,
      );
      const events = yield* EventStore.EventStoreV2;
      const sequence = yield* events.latestSequence({ threadId });
      snapshot = {
        ...snapshot,
        sourceRevision: "revision-2",
        turns: [
          ...snapshot.turns,
          {
            nativeTurnId: "later",
            messages: [message("later", "external follow-up")],
            turnItems: [tool("later-tool")],
          },
        ],
      };
      assert.equal(yield* importer.refresh(threadId), 2);
      const additions = yield* events
        .read({ threadId, afterSequence: sequence })
        .pipe(Stream.runCollect);
      assert.deepEqual(
        additions
          .filter((event) => event.event.type === "message.updated")
          .map((event) => (event.event.type === "message.updated" ? event.event.payload.text : "")),
        ["external follow-up"],
      );
      assert.deepEqual(
        additions
          .filter((event) => event.event.type === "turn-item.updated")
          .map((event) => (event.event.type === "turn-item.updated" ? event.event.payload.id : "")),
        ["later-tool"],
      );

      assert.equal(
        (yield* projections.getThreadRecords(threadId, ["messages"])).messages.length,
        3,
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          sinkLayer,
          ServerConfig.layerTest(process.cwd(), { prefix: "native-history-" }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
      Effect.scoped,
    ),
);
