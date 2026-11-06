import { type SessionMessage, Session } from "@opencode/client/effect";
import {
  MessageId,
  TurnItemId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import type { NativeHistorySnapshot } from "@t3tools/provider-core/server/driver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { openCodeToolTurnItem } from "../toolItems.ts";
import * as OpenCode2Client from "./OpenCode2Client.ts";
import type { OpenCode2Connection } from "./OpenCode2Server.ts";

/** Native IDs and content order survive retries, pagination and ACP reconnects. */
export function projectNativeHistory(
  thread: OrchestrationV2ProviderThread,
  history: ReadonlyArray<SessionMessage.Info>,
): NativeHistorySnapshot {
  const threadId = thread.appThreadId;
  if (threadId === null) return { sourceRevision: "unbound", turns: [], attachments: [] };
  const turns: Array<{
    nativeTurnId: string;
    nativeMessageIds: Array<string>;
    nativeToolIds: Array<string>;
    messages: Array<OrchestrationV2ConversationMessage>;
    turnItems: Array<OrchestrationV2TurnItem>;
  }> = [];
  const attachments: Array<NativeHistorySnapshot["attachments"][number]> = [];
  let ordinal = 0;
  let turn: (typeof turns)[number] | undefined;
  for (const message of history) {
    if (turn === undefined || message.type === "user") {
      turn = {
        nativeTurnId: message.id,
        nativeMessageIds: [],
        nativeToolIds: [],
        messages: [],
        turnItems: [],
      };
      turns.push(turn);
    }
    turn.nativeMessageIds.push(message.id);
    const at = message.time.created;
    const base = (nativeId: string, startedAt = at, completedAt = at) => ({
      id: TurnItemId.make(`native-history:${threadId}:${nativeId}`),
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: thread.id,
      providerTurnId: null,
      nativeItemRef: { driver: thread.driver, nativeId, strength: "strong" as const },
      parentItemId: null,
      ordinal: ++ordinal,
      status: "completed" as const,
      title: null,
      startedAt,
      completedAt,
      updatedAt: completedAt,
    });
    const addText = (
      text: string,
      nativeId: string,
      role: "user" | "assistant",
      completedAt = at,
    ) => {
      const id = MessageId.make(`native-history:${threadId}:${nativeId}`);
      turn!.messages.push({
        id,
        threadId,
        runId: null,
        nodeId: null,
        createdBy: role === "user" ? "user" : "agent",
        creationSource: "provider",
        role,
        text,
        attachments: [],
        streaming: false,
        createdAt: at,
        updatedAt: completedAt,
      });
      turn!.turnItems.push(
        role === "user"
          ? {
              ...base(nativeId, at, completedAt),
              type: "user_message",
              createdBy: "user",
              creationSource: "provider",
              messageId: id,
              text,
              attachments: [],
              inputIntent: "turn_start",
            }
          : {
              ...base(nativeId, at, completedAt),
              type: "assistant_message",
              messageId: id,
              text,
              streaming: false,
            },
      );
      return id;
    };
    switch (message.type) {
      case "user": {
        const messageId = addText(message.text, message.id, "user");
        for (const [index, file] of (message.files ?? []).entries())
          attachments.push({
            messageId,
            index,
            name: file.name ?? `attachment-${index + 1}`,
            mimeType: file.mime,
            data: file.data,
          });
        break;
      }
      case "assistant": {
        for (const [index, part] of message.content.entries()) {
          const nativeId = `${message.id}:${index}`;
          if (part.type === "text") {
            if (part.text !== "")
              addText(part.text, nativeId, "assistant", message.time.completed ?? at);
          } else if (part.type === "reasoning") {
            turn.turnItems.push({
              ...base(
                nativeId,
                part.time?.created ?? at,
                part.time?.completed ?? message.time.completed ?? part.time?.created ?? at,
              ),
              type: "reasoning",
              text: part.text,
              streaming: false,
            });
          } else {
            turn.nativeToolIds.push(part.id);
            const state = part.state;
            const output =
              state.status === "completed" || state.status === "error"
                ? state.content
                    ?.map((content) =>
                      content.type === "text" ? content.text : JSON.stringify(content),
                    )
                    .join("\n")
                : undefined;
            const item = openCodeToolTurnItem(
              base(
                nativeId,
                part.time.ran ?? part.time.created,
                part.time.completed ?? message.time.completed ?? part.time.ran ?? part.time.created,
              ),
              {
                name: part.name,
                input: state.status === "streaming" ? { partial: state.input } : state.input,
                output:
                  output ?? (state.status === "error" ? JSON.stringify(state.error) : undefined),
                completedMetadata:
                  state.status === "completed" || state.status === "error"
                    ? state.metadata
                    : undefined,
              },
            );
            turn.turnItems.push({
              ...item,
              status:
                state.status === "completed"
                  ? "completed"
                  : state.status === "error"
                    ? "failed"
                    : "interrupted",
            });
          }
        }
        if (message.error !== undefined)
          turn.turnItems.push({
            ...base(`${message.id}:error`),
            type: "system_notice",
            message: JSON.stringify(message.error),
          });
        break;
      }
      case "compaction":
        turn.turnItems.push({
          ...base(message.id),
          type: "compaction",
          driver: thread.driver,
          status: message.status === "running" ? "interrupted" : message.status,
          title: "Context compaction",
          ...("summary" in message ? { summary: message.summary } : {}),
        });
        break;
      case "shell":
        turn.turnItems.push({
          ...base(message.id, at, message.time.completed ?? at),
          type: "command_execution",
          input: message.command,
          output:
            typeof message.output === "string" ? message.output : JSON.stringify(message.output),
          ...(message.exit === undefined ? {} : { exitCode: message.exit }),
        });
        break;
      case "synthetic":
      case "system":
      case "skill":
        turn.turnItems.push({ ...base(message.id), type: "system_notice", message: message.text });
        break;
      case "idle":
        if (message.error !== undefined)
          turn.turnItems.push({
            ...base(message.id),
            type: "system_notice",
            message: JSON.stringify(message.error),
          });
        break;
      default:
        break;
    }
  }
  return { sourceRevision: "projected", turns, attachments };
}

export const readNativeHistory = Effect.fn("OpenCode2.readNativeHistory")(function* (
  connection: OpenCode2Connection,
  thread: OrchestrationV2ProviderThread,
  knownRevision?: string,
) {
  const id = thread.nativeThreadRef?.nativeId;
  if (id == null) return null;
  if (id in (yield* connection.client.session.active())) return null;
  const native = yield* connection.client.session.get({ sessionID: Session.ID.make(id) });
  const sourceRevision = `opencode-native-v3:${DateTime.formatIso(native.time.updated)}:${native.time.idle === undefined ? "" : DateTime.formatIso(native.time.idle)}`;
  if (sourceRevision === knownRevision) return null;
  const history = yield* OpenCode2Client.paginate(
    { sessionID: Session.ID.make(id), order: "asc" as const, limit: 100 },
    connection.client.message.list,
  ).pipe(Stream.runCollect);
  if (id in (yield* connection.client.session.active())) return null;
  const after = yield* connection.client.session.get({ sessionID: Session.ID.make(id) });
  if (!DateTime.Equivalence(native.time.updated, after.time.updated)) return null;
  return {
    ...projectNativeHistory(thread, history),
    sourceRevision,
    ...(native.model === undefined
      ? {}
      : {
          modelSelection: {
            instanceId: thread.providerInstanceId,
            model: `${native.model.providerID}/${native.model.id}`,
            ...(native.model.variant === undefined
              ? {}
              : { options: [{ id: "variant", value: native.model.variant }] }),
          },
        }),
  };
});
