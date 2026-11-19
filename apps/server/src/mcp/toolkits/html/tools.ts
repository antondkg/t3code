import {
  OrchestratorMcpFailure,
  ThreadWidget,
  ThreadWidgetId,
  ThreadWidgetData,
} from "@t3tools/contracts";
import {
  HTML_RENDER_COLUMN_WIDTH,
  HTML_RENDER_LAYOUT_GUIDE,
  HTML_RENDER_MAX_FIT_HEIGHT,
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_MAX_TITLE_LENGTH,
  HTML_RENDER_MIN_HEIGHT,
  HTML_RENDER_THEME_GUIDE,
  HTML_RENDER_TOOL_NAME,
} from "@t3tools/shared/htmlRender";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as HtmlRender from "../../../htmlRender/HtmlRender.ts";
import * as ThreadWidgets from "../../../htmlRender/ThreadWidgets.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const Html = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512_000)).annotate({
  description: "Inline HTML.",
});

const HtmlPath = Schema.String.annotate({
  description: "Absolute .html file path.",
});

const PAGE_RULES =
  "Self-contained: inline <style> and <script>. Local images as absolute paths are inlined. Remote URLs load as-is.";

export const HtmlPreviewTool = Tool.make("html_preview", {
  description: `Check an HTML page before html_render. Returns PNG, contentHeight, and console output. ${PAGE_RULES} Theme and layout rules are in html_render.`,
  parameters: Schema.Struct({
    path: Schema.optional(HtmlPath),
    html: Schema.optional(Html),
    width: Schema.optional(
      Schema.Int.annotate({
        description: `CSS pixels, 240 to 1600. Default ${HTML_RENDER_COLUMN_WIDTH}. Use about 390 for phones.`,
      }),
    ),
    appearance: Schema.optional(
      Schema.Literals(["dark", "light"]).annotate({
        description: "Default dark.",
      }),
    ),
  }),
  success: Schema.Struct({
    width: Schema.Int,
    contentHeight: Schema.Int,
    capturedHeight: Schema.Int,
    consoleMessages: Schema.Array(
      Schema.Struct({
        level: Schema.Literals(["log", "info", "warning", "error"]),
        text: Schema.String,
      }),
    ),
    missingImages: Schema.optional(Schema.Array(Schema.String)),
    screenshot: Schema.Struct({
      mimeType: Schema.Literal("image/png"),
      data: Schema.String,
      width: Schema.Int,
      height: Schema.Int,
    }),
  }),
  failure: OrchestratorMcpFailure,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    HtmlRender.HtmlRender,
  ],
})
  .annotate(Tool.Title, "Preview HTML")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

// This affects only the caller's thread, not its workspace, so read-only sandboxes and plan mode may use it.
const HtmlRenderTool = Tool.make(HTML_RENDER_TOOL_NAME, {
  description: `Show a finished HTML page (chart, diagram, mockup) inline in this thread, above your final reply. Do not announce or restate the page. Frame fits height to ${HTML_RENDER_MAX_FIT_HEIGHT}px. On mobile, content past the given height scrolls. ${HTML_RENDER_LAYOUT_GUIDE} ${HTML_RENDER_THEME_GUIDE}`,
  parameters: Schema.Struct({
    path: Schema.optional(HtmlPath),
    html: Schema.optional(Html),
    title: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(HTML_RENDER_MAX_TITLE_LENGTH),
    ),
    height: Schema.Int.annotate({
      description: `Frame height in CSS pixels, ${HTML_RENDER_MIN_HEIGHT} to ${HTML_RENDER_MAX_HEIGHT}. Use the contentHeight from html_preview.`,
    }),
  }),
  success: Schema.Struct({
    htmlRender: Schema.Struct({
      attachmentId: Schema.String,
      title: Schema.String,
      height: Schema.Number,
      heights: Schema.optional(Schema.Array(Schema.Tuple([Schema.Int, Schema.Int]))),
    }),
    message: Schema.String,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    HtmlRender.HtmlRender,
  ],
})
  .annotate(Tool.Title, "Render HTML")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const ThreadWidgetTool = Tool.make("thread_widget", {
  description: `Create or update a persistent live HTML widget in this thread's details area. Use a short stable id, such as "progress"; reusing it updates the existing widget. First call: id, title, html (or path), optional data and height. Later send only id and data for live updates without reloading the page, or html/path to replace it. In HTML, window.t3Widget.onUpdate(data => { /* update DOM */ }) receives initial data and every update; window.t3Widget.data holds the latest value. Data replaces the previous JSON value. Use action:"list" to recover ids after compaction, action:"remove" with id to delete one. Widgets remain visible between turns and after reconnect. ${PAGE_RULES} ${HTML_RENDER_THEME_GUIDE}`,
  parameters: Schema.Struct({
    action: Schema.optional(Schema.Literals(["upsert", "list", "remove"])),
    id: Schema.optional(ThreadWidgetId),
    title: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
    html: Schema.optional(Html),
    path: Schema.optional(HtmlPath),
    data: Schema.optional(ThreadWidgetData),
    height: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 80, maximum: 2000 }))),
  }),
  success: Schema.Struct({ widgets: Schema.Array(ThreadWidget) }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadWidgets.ThreadWidgets,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "Update thread widget")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const HtmlPreviewToolkit = Toolkit.make(HtmlPreviewTool);

export const HtmlRenderToolkit = Toolkit.make(HtmlRenderTool, ThreadWidgetTool);

export const HtmlToolkit = Toolkit.make(HtmlPreviewTool, HtmlRenderTool, ThreadWidgetTool);
