import { createContext } from "react";

export const CHAT_PANE_DRAG_TYPE = "application/x-t3code-chat-pane";

/** What a split pane tells the ChatView inside it; null outside a split. */
export interface ChatPaneContextValue {
  /** The pane's root, which contains fixed descendants such as the right panel sheet. */
  readonly element: HTMLElement | null;
  /** Too narrow for the right panel beside the chat, so it opens as a sheet. */
  readonly narrow: boolean;
  /** One pane keeps other threads' terminals mounted; the others mount only their own. */
  readonly hostsHiddenTerminals: boolean;
  /** Threads the other panes show; those panes mount their terminals. */
  readonly otherPaneThreadKeys: ReadonlySet<string>;
  readonly close: () => void;
  /** Identifies the pane when its header is dragged onto another pane. */
  readonly paneId: string;
}

export const ChatPaneContext = createContext<ChatPaneContextValue | null>(null);
