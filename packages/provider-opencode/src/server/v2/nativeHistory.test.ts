import { assert, it } from "@effect/vitest";
import { SessionMessage } from "@opencode/client/effect";
import {
  OrchestrationV2ProviderThread,
  OrchestrationV2TurnItem,
  OrchestrationV2DomainEvent,
  OrchestrationV2DomainEventJson,
  EventId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { projectNativeHistory } from "./nativeHistory.ts";

const decodeThread = Schema.decodeUnknownSync(OrchestrationV2ProviderThread);
const decodeHistory = Schema.decodeUnknownSync(Schema.Array(SessionMessage.Info));
const encodeItem = Schema.encodeSync(OrchestrationV2TurnItem);
const encodeEvent = Schema.encodeSync(OrchestrationV2DomainEventJson);
const decodeEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEvent);
const decodeStoredEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEventJson);
const at = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const thread = decodeThread({
  id: "provider-thread",
  driver: "acpRegistry",
  providerInstanceId: "acp",
  providerSessionId: null,
  appThreadId: "thread",
  ownerNodeId: null,
  nativeThreadRef: { driver: "acpRegistry", nativeId: "ses_test", strength: "strong" },
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  pendingBackgroundTasks: [],
  createdAt: at,
  updatedAt: at,
});
const history = decodeHistory([
  {
    id: "msg_user",
    type: "user",
    text: "inspect",
    files: [{ data: "aGk=", mime: "text/plain", source: { type: "inline" }, name: "note.txt" }],
    time: { created: 1000 },
  },
  {
    id: "msg_assistant",
    type: "assistant",
    agent: "build",
    model: { providerID: "anthropic", id: "haiku" },
    time: { created: 2000, completed: 5000 },
    content: [
      { type: "reasoning", text: "thinking", time: { created: 2000, completed: 2500 } },
      { type: "text", text: "before" },
      {
        type: "tool",
        id: "call_one",
        name: "bash",
        state: {
          status: "completed",
          input: { command: "pwd" },
          content: [{ type: "text", text: "/tmp" }],
          metadata: { exit: 0 },
        },
        time: { created: 3000, ran: 3100, completed: 4000 },
      },
      { type: "text", text: "after" },
    ],
  },
  {
    id: "msg_compact",
    type: "compaction",
    status: "completed",
    reason: "auto",
    summary: "summary",
    recent: "recent",
    time: { created: 6000 },
  },
]);
it("preserves native content order, tool output, reasoning, timestamps and attachment bytes", () => {
  const snapshot = projectNativeHistory(thread, history);
  assert.deepEqual(
    snapshot.turns.flatMap((turn) => turn.turnItems.map((item) => item.type)),
    [
      "user_message",
      "reasoning",
      "assistant_message",
      "command_execution",
      "assistant_message",
      "compaction",
    ],
  );
  const items = snapshot.turns.flatMap((turn) => turn.turnItems);
  assert.equal(DateTime.toEpochMillis(items[0]!.startedAt!), 1000);
  assert.equal(DateTime.toEpochMillis(items[3]!.completedAt!), 4000);
  assert.equal(items[3]!.type === "command_execution" && items[3]!.output, "/tmp");
  assert.deepEqual(
    snapshot.attachments.map(({ data, name }) => [data, name]),
    [["aGk=", "note.txt"]],
  );
  for (const item of items) assert.isDefined(encodeItem(item));
  assert.deepEqual(projectNativeHistory(thread, history), snapshot);
  assert.equal(
    projectNativeHistory(thread, [
      ...history,
      ...decodeHistory([{ id: "msg_later", type: "user", text: "later", time: { created: 7000 } }]),
    ]).turns.length,
    2,
  );
});
it("round trips the repair event through the persisted event codec", () => {
  const event = decodeEvent({
    id: EventId.make("repair"),
    threadId: thread.appThreadId,
    occurredAt: at,
    type: "transcript.items-removed",
    payload: { messageIds: ["old-message"], turnItemIds: ["old-item"] },
  });
  assert.deepEqual(decodeStoredEvent(encodeEvent(event)), event);
});
