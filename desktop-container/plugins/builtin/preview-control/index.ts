import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type {
  CamelAIExtensionModule,
  CamelAIPreviewTarget,
  CamelAIThreadPreviewMutationResult,
} from "../../../sdk";

const PREVIEW_CONTROL_ID = "preview-control";

const filePreviewTargetSchema = z.object({
  kind: z.literal("file"),
  source: z.enum(["workspace", "upload", "output"]).optional(),
  workspaceId: z.string().nullable().optional(),
  path: z.string(),
  filename: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  contentType: z.string().nullable().optional(),
});

const urlPreviewTargetSchema = z.object({
  kind: z.literal("url"),
  url: z.string(),
  title: z.string().nullable().optional(),
});

const previewTargetSchema = z.union([
  filePreviewTargetSchema,
  urlPreviewTargetSchema,
]);

const previewItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  target: previewTargetSchema,
});

const previewStateSchema = z.object({
  threadId: z.string(),
  visible: z.boolean(),
  activeItemId: z.string().nullable(),
  items: z.array(previewItemSchema),
});

const previewSelectionInputSchema = z.object({
  threadId: z.string().optional(),
  target: previewTargetSchema,
});

const previewSetItemsInputSchema = z.object({
  threadId: z.string().optional(),
  items: z.array(previewTargetSchema),
  activeIndex: z.number().int().min(0).nullable().optional(),
});

const previewClearInputSchema = z.object({
  threadId: z.string().optional(),
});

const previewVisibilityInputSchema = z.object({
  threadId: z.string().optional(),
  visible: z.boolean(),
});

function normalizePreviewTarget(target: CamelAIPreviewTarget): CamelAIPreviewTarget {
  if (target.kind === "url") {
    return {
      kind: "url",
      url: target.url,
      title: target.title ?? null,
    };
  }

  const normalizedPath = target.path.trim();
  const inferredSource =
    target.source ??
    (normalizedPath.startsWith("/mnt/user-uploads/")
      ? "upload"
      : normalizedPath.startsWith("/mnt/user-outputs/")
        ? "output"
        : "workspace");

  return {
    kind: "file",
    source: inferredSource,
    workspaceId: target.workspaceId ?? null,
    path: target.path,
    filename: target.filename ?? null,
    title: target.title ?? null,
    contentType: target.contentType ?? null,
  };
}

function toStructuredContent(
  result: CamelAIThreadPreviewMutationResult,
) {
  return {
    threadId: result.threadId,
    visible: result.state.visible,
    activeItemId: result.state.activeItemId,
    items: result.state.items.map((item) => ({
      id: item.id,
      title: item.title,
      target: normalizePreviewTarget(item.target),
    })),
  };
}

const extension: CamelAIExtensionModule = {
  activate(api) {
    api.registerMcpServer(PREVIEW_CONTROL_ID, {
      createServer: () => {
        const server = new McpServer({
          name: PREVIEW_CONTROL_ID,
          version: "1.0.0",
        });

        server.registerTool(
          "open_preview",
          {
            description:
              "Open or focus a file or URL in the desktop app thread preview pane. Omits threadId to target the active thread.",
            inputSchema: previewSelectionInputSchema,
            outputSchema: previewStateSchema,
          },
          async ({ threadId, target }) => {
            const result = api.openThreadPreviewItem(
              normalizePreviewTarget(target),
              threadId ?? null,
            );
            const structuredContent = toStructuredContent(result);
            return {
              content: [
                {
                  type: "text",
                  text: `Opened preview item in thread ${structuredContent.threadId}.`,
                },
              ],
              structuredContent,
            };
          },
        );

        server.registerTool(
          "set_preview_items",
          {
            description:
              "Replace the desktop app thread preview tabs with a set of file or URL items. Omits threadId to target the active thread.",
            inputSchema: previewSetItemsInputSchema,
            outputSchema: previewStateSchema,
          },
          async ({ threadId, items, activeIndex }) => {
            const result = api.setThreadPreviewItems(
              items.map((item) => normalizePreviewTarget(item)),
              {
                threadId: threadId ?? null,
                activeIndex: activeIndex ?? null,
              },
            );
            const structuredContent = toStructuredContent(result);
            return {
              content: [
                {
                  type: "text",
                  text:
                    structuredContent.items.length > 0
                      ? `Set ${structuredContent.items.length} preview item(s) in thread ${structuredContent.threadId}.`
                      : `Cleared preview items in thread ${structuredContent.threadId}.`,
                },
              ],
              structuredContent,
            };
          },
        );

        server.registerTool(
          "clear_preview",
          {
            description:
              "Clear all preview tabs from the desktop app thread preview pane. Omits threadId to target the active thread.",
            inputSchema: previewClearInputSchema,
            outputSchema: previewStateSchema,
          },
          async ({ threadId }) => {
            const result = api.clearThreadPreview(threadId ?? null);
            const structuredContent = toStructuredContent(result);
            return {
              content: [
                {
                  type: "text",
                  text: `Cleared preview items in thread ${structuredContent.threadId}.`,
                },
              ],
              structuredContent,
            };
          },
        );

        server.registerTool(
          "set_preview_visibility",
          {
            description:
              "Show or hide the desktop app thread preview pane without changing the current preview items. Omits threadId to target the active thread.",
            inputSchema: previewVisibilityInputSchema,
            outputSchema: previewStateSchema,
          },
          async ({ threadId, visible }) => {
            const result = api.setThreadPreviewVisibility(
              visible,
              threadId ?? null,
            );
            const structuredContent = toStructuredContent(result);
            return {
              content: [
                {
                  type: "text",
                  text: `${visible ? "Showed" : "Hid"} the preview pane for thread ${structuredContent.threadId}.`,
                },
              ],
              structuredContent,
            };
          },
        );

        return server;
      },
    });
  },
};

export default extension;
