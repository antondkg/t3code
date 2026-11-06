import { assert, it } from "@effect/vitest";
import { nativeSourceMessageId } from "./nativeHistoryIdentity.ts";
it("recovers native message identity from weak ACP refs without using text or clocks", () => {
  assert.equal(
    nativeSourceMessageId("ses_native:turn:1:assistant:message:msg_native"),
    "msg_native",
  );
  assert.equal(
    nativeSourceMessageId("ses_native:turn:1:reasoning:message:msg_native:reasoning:2"),
    "msg_native",
  );
  assert.equal(nativeSourceMessageId("ses_native:turn:1:assistant:0"), undefined);
  assert.equal(nativeSourceMessageId("ses_native:turn:1:assistant:message:"), undefined);
});
