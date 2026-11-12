import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  ClipboardCheckIcon,
  LayersIcon,
  MessageSquareIcon,
  UserRoundIcon,
  UserRoundPlusIcon,
  UserRoundXIcon,
} from "lucide-react";
import { useState } from "react";

import { focusTerminal } from "~/lib/terminalFocus";
import { cn } from "~/lib/utils";
import { useTerminalUiStateStore } from "~/terminalUiStateStore";

import { useThreadTerminalActions } from "../terminal/useThreadTerminalActions";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { PullRequestGlyph } from "./pullRequestIcons";
import { toastManager } from "../ui/toast";
import { E2E_ICON } from "./LinkedPullRequestStatus";
import {
  END_TO_END_PRESENTATION,
  type PullRequestEndToEnd,
  type PullRequestMergeReadiness,
} from "./pullRequestDeploy.logic";
import { writeHandoffToComposer } from "./usePullRequestActions";

// `--confirm` makes Graphite list what it merges and ask again in the terminal.
const GRAPHITE_MERGE_COMMAND = "gt merge --confirm";

const list = (numbers: ReadonlyArray<number>) => numbers.map((number) => `#${number}`).join(" ");

/**
 * Whether the linked stack can merge, and what blocks it. Ready offers Graphite's merge in the
 * thread's terminal, or a prompt that asks the thread's agent to merge.
 */
export function StackReadinessBanner({
  threadRef,
  readiness,
  graphite,
  tops,
}: {
  threadRef: ScopedThreadRef;
  readiness: PullRequestMergeReadiness;
  /** The repository uses Graphite, so `gt merge` can land the stack. */
  graphite: boolean;
  /** Each stack's top and its E2E, which covers every layer below it. */
  tops: ReadonlyArray<{ readonly number: number; readonly e2e: PullRequestEndToEnd | null }>;
}) {
  const {
    open,
    failing,
    pending,
    stackPending,
    changesRequested,
    unapproved,
    noReviewer,
    signoff,
  } = readiness;
  const ready =
    failing.length === 0 &&
    pending.length === 0 &&
    changesRequested.length === 0 &&
    unapproved.length === 0 &&
    noReviewer.length === 0;
  const terminalActions = useThreadTerminalActions(threadRef);
  const newTerminal = useTerminalUiStateStore((state) => state.newTerminal);
  const [confirming, setConfirming] = useState(false);
  const kind = open === 1 ? "Pull request" : `Stack of ${open}`;

  const mergeInTerminal = async () => {
    setConfirming(false);
    const launched = terminalActions.launchTerminal({
      place: (terminalId) => newTerminal(threadRef, terminalId),
    });
    if (launched === null) {
      toastManager.add({ type: "error", title: "Could not open a terminal for this thread" });
      return;
    }
    focusTerminal(threadRef, launched.terminalId);
    const opened = await launched.result;
    if (opened._tag === "Failure") return;
    await terminalActions.writeToTerminal(launched.terminalId, `${GRAPHITE_MERGE_COMMAND}\r`);
  };

  const askAgent = () => {
    writeHandoffToComposer(threadRef, {
      prompt: `Every open layer of this stack is approved and its CI passed. Merge the stack bottom-up with \`${GRAPHITE_MERGE_COMMAND}\`, then report which pull requests merged.`,
    });
    toastManager.add({
      type: "success",
      title: "Merge request is in the composer",
      description: "Read it over, then send.",
    });
  };

  if (ready) {
    return (
      <div className="mx-1.5 mt-1.5 flex flex-col gap-1.5 rounded-lg border border-success/30 bg-success/8 px-2.5 py-2 text-xs text-success-foreground">
        <span className="flex min-w-0 items-center gap-1.5">
          <CircleCheckIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="shrink-0 font-semibold">
            {open === 1 ? "Ready to merge" : "Stack ready to merge"}
          </span>
          <span className="truncate">
            {open === 1 ? "approved, CI passing" : `all ${open} approved, CI passing`}
          </span>
        </span>
        <TopEndToEndLines tops={tops} />
        <span className="flex flex-wrap gap-1.5">
          {graphite ? (
            <Button size="xs" onClick={() => setConfirming(true)}>
              <PullRequestGlyph.merged aria-hidden className="size-3.5" />
              Merge stack with Graphite
            </Button>
          ) : null}
          <Button size="xs" variant="outline" onClick={askAgent}>
            <MessageSquareIcon aria-hidden className="size-3.5" />
            Ask agent to merge
          </Button>
        </span>
        <AlertDialog open={confirming} onOpenChange={setConfirming}>
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>Merge the stack with Graphite?</AlertDialogTitle>
              <AlertDialogDescription>
                This runs <code>{GRAPHITE_MERGE_COMMAND}</code> in a terminal in this thread's
                checkout. It merges every layer from the trunk up to the checked-out branch, and
                Graphite lists them and asks once more before it starts.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" size="sm" />}>
                Cancel
              </AlertDialogClose>
              <Button size="sm" onClick={() => void mergeInTerminal()}>
                Open terminal and merge
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      </div>
    );
  }

  return (
    <div className="mx-1.5 mt-1.5 flex flex-col gap-0.5 rounded-lg border border-border/70 bg-muted/40 px-2.5 py-2 text-xs">
      <span className="flex min-w-0 items-center gap-1.5">
        <LayersIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="shrink-0 font-semibold">{kind}</span>
        <span className="truncate text-muted-foreground">not ready to merge</span>
      </span>
      <TopEndToEndLines tops={tops} />
      {changesRequested.length > 0 ? (
        <Line tone="destructive" icon={UserRoundXIcon}>
          Changes requested: {list(changesRequested)}
        </Line>
      ) : null}
      {noReviewer.length > 0 ? (
        <Line tone="destructive" icon={UserRoundPlusIcon}>
          No reviewer assigned: {list(noReviewer)}
        </Line>
      ) : null}
      {unapproved.length > 0 ? (
        <Line tone="muted" icon={UserRoundIcon}>
          Waiting on review: {list(unapproved)}
        </Line>
      ) : null}
      {signoff.length > 0 ? (
        <Line tone="muted" icon={ClipboardCheckIcon}>
          Reviewer sign-off pending: {list(signoff)}
        </Line>
      ) : null}
      {failing.length > 0 ? (
        <Line tone="destructive" icon={CircleXIcon}>
          Checks failing: {list(failing)}
        </Line>
      ) : null}
      {pending.length > 0 ? (
        <Line tone="muted" icon={CircleXIcon}>
          Checks running: {list(pending)}
        </Line>
      ) : null}
      {stackPending.length > 0 && failing.length === 0 && pending.length === 0 ? (
        <Line tone="muted" icon={CircleCheckIcon}>
          CI passed · {stackPending.length}{" "}
          {stackPending.length === 1 ? "layer waits" : "layers wait"} on Graphite's stack check
        </Line>
      ) : null}
    </div>
  );
}

/** The E2E that matters for a stack: its top's, which carries every change below it. */
function TopEndToEndLines({
  tops,
}: {
  tops: ReadonlyArray<{ readonly number: number; readonly e2e: PullRequestEndToEnd | null }>;
}) {
  return tops.map(({ number, e2e }) => {
    const shown = e2e === null ? null : END_TO_END_PRESENTATION[e2e.state];
    return (
      <Line
        key={number}
        tone={shown?.tone ?? "muted"}
        icon={e2e === null ? CircleDashedIcon : E2E_ICON[e2e.state]}
      >
        <span className="font-medium">Top of stack #{number}:</span>{" "}
        {shown?.label ?? "no E2E reported"}
      </Line>
    );
  });
}

type LineTone = "destructive" | "muted" | "success" | "attention";

const LINE_TONE: Record<LineTone, string> = {
  destructive: "text-destructive",
  muted: "text-muted-foreground",
  success: "text-success-foreground",
  attention: "text-warning-foreground",
};

function Line({
  tone,
  icon: Icon,
  children,
}: {
  tone: LineTone;
  icon: typeof LayersIcon;
  children: React.ReactNode;
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5 truncate", LINE_TONE[tone])}>
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">{children}</span>
    </span>
  );
}
