/** ACP v2 text IDs embed the provider's message ID, even when the turn ref is weak. */
export function nativeSourceMessageId(itemId: string): string | undefined {
  const assistant = ":assistant:message:";
  const assistantAt = itemId.lastIndexOf(assistant);
  if (assistantAt >= 0) return itemId.slice(assistantAt + assistant.length) || undefined;
  const reasoning = ":reasoning:message:";
  const reasoningAt = itemId.lastIndexOf(reasoning);
  if (reasoningAt < 0) return undefined;
  // OpenCode names each reasoning block with the assistant message and its ordinal.
  return itemId.slice(reasoningAt + reasoning.length).split(":reasoning:")[0] || undefined;
}
