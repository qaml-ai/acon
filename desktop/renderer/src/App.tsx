import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type DragEvent,
  type ReactNode,
} from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  File,
  Folder,
  FolderOpen,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import {
  ChatPreviewProvider,
  useChatPreviewContext,
} from "@/components/chat-preview/preview-context";
import {
  FilePreviewContent,
  parseUploadRefs,
} from "@/components/chat-file-preview";
import type { Attachment } from "@/components/attachment-list";
import { ContentBlockRenderer } from "@/components/message-bubble";
import { FileCard } from "@/components/file-card";
import { FloatingTodoList, type TodoItem } from "@/components/floating-todo";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PromptInput } from "@/components/prompt-input";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { LoadingDots } from "@/components/loading-dots";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { cn } from "@/lib/utils";
import {
  mergeTaskNotifications,
  mergeTeammateMessages,
  normalizeToolResultMessages,
} from "@/lib/streaming";
import { toast } from "sonner";
import type { ContentBlock, Message, PreviewTarget } from "@/types";
import type {
  DesktopClientEvent,
  DesktopModel,
  DesktopPane,
  DesktopPaneDropPlacement,
  DesktopPaneNode,
  DesktopModelSource,
  DesktopPreviewTarget,
  DesktopThreadPreviewState,
  DesktopProvider,
  DesktopShellCommand,
  DesktopServerEvent,
  DesktopSnapshot,
  DesktopTab,
  DesktopThread,
  DesktopThreadGroup,
  DesktopView,
  DesktopWorkspaceEntry,
  DesktopWorkspaceListing,
} from "../../shared/protocol";
import {
  applyRuntimeEventToMessages,
  mergeSnapshotMessages,
} from "../../shared/message-state";
import { getDesktopPreviewItemId } from "../../shared/preview";
import { DesktopSidebar } from "./desktop-sidebar";
import { SettingsPage } from "./settings-page";
import { getDesktopIcon } from "./desktop-icons";
import { ThreadRuntimeIndicator } from "./thread-runtime-indicator";

const desktopShell = window.desktopShell;
const fallbackBackendUrl = "http://127.0.0.1:4315";
const EMPTY_THREAD_DRAFT_KEY = "__no_thread__";
const DESKTOP_WORKSPACE_ID = "desktop";
const DESKTOP_TAB_MIME_TYPE = "application/x-acon-tab";
const KANBAN_LANES = [
  {
    id: "drafts",
    title: "Drafts",
    description: "Fresh threads that have not started yet.",
  },
  {
    id: "in_progress",
    title: "In Progress",
    description: "Sessions that are currently running or being worked.",
  },
  {
    id: "ready_for_review",
    title: "Ready for Review",
    description: "Finished passes that may still need a follow-up.",
  },
  {
    id: "finished",
    title: "Finished",
    description: "Archived work you want to keep around.",
  },
] as const;

type KanbanLaneId = (typeof KANBAN_LANES)[number]["id"];

type HostSurfaceComponentProps = {
  snapshot: DesktopSnapshot;
  surface: DesktopView;
  activeThreadId: string | null;
  rawMessages: Message[];
  initialDraft: string;
  isStreaming: boolean;
  onDraftChange: (threadId: string | null, draft: string) => void;
  onSetProvider: (provider: DesktopProvider) => void;
  onSetModel: (model: string) => void;
  onSetModelSource: (modelSource: string) => void;
  onStopThread: (threadId: string) => void;
  onSubmitMessage: (threadId: string, content: string) => void;
  onRequestCreateGroup: () => void;
  onRequestDeleteGroup: (groupId: string) => void;
  onRequestRenameGroup: (groupId: string) => void;
  onSendEvent: (event: DesktopClientEvent) => void;
  onOpenPreviewTarget: (target: PreviewTarget) => void;
  onSetPreviewTargets: (
    targets: PreviewTarget[],
    options?: { activeTarget?: PreviewTarget | null },
  ) => void;
  onClearPreviewTargets: () => void;
};

type GroupEditorState =
  | {
      mode: "create";
      open: boolean;
      title: string;
    }
  | {
      mode: "rename";
      open: boolean;
      groupId: string;
      title: string;
    };

type GroupDeleteState = {
  open: boolean;
  groupId: string;
};

function getActiveThread(
  snapshot: DesktopSnapshot | null,
  threadId: string | null,
): DesktopThread | null {
  if (!snapshot || !threadId) return null;
  return snapshot.threads.find((thread) => thread.id === threadId) ?? null;
}

function getActiveThreadGroup(
  snapshot: DesktopSnapshot | null,
): DesktopThreadGroup | null {
  if (!snapshot) {
    return null;
  }

  const activeGroupId = snapshot.activeGroupId;
  if (!activeGroupId) {
    return snapshot.threadGroups[0] ?? null;
  }

  return (
    snapshot.threadGroups.find((group) => group.id === activeGroupId) ??
    snapshot.threadGroups[0] ??
    null
  );
}

function getView(
  snapshot: DesktopSnapshot | null,
  viewId: string | null,
): DesktopView | null {
  if (!snapshot || !viewId) {
    return null;
  }

  return snapshot.views.find((view) => view.id === viewId) ?? null;
}

function deriveDesktopPanes(snapshot: DesktopSnapshot | null): DesktopPane[] {
  if (!snapshot) {
    return [];
  }

  if (snapshot.panes && snapshot.panes.length > 0) {
    return snapshot.panes;
  }

  const primaryTabs = snapshot.tabs.map((tab) => ({
    ...tab,
    paneId: tab.paneId ?? "primary",
  }));
  const activeThreadPreviewState =
    (snapshot.activeThreadId
      ? snapshot.threadPreviewStateById[snapshot.activeThreadId]
      : null) ?? null;
  const previewTabs =
    activeThreadPreviewState?.visible && activeThreadPreviewState.items.length > 0
      ? activeThreadPreviewState.items.map<DesktopTab>((item) => ({
          id: `preview:${snapshot.activeThreadId}:${item.id}`,
          kind: "preview",
          paneId: "secondary",
          threadId: snapshot.activeThreadId,
          viewId: null,
          title: item.title,
          subtitle:
            snapshot.threads.find((thread) => thread.id === snapshot.activeThreadId)?.title ??
            null,
          icon: item.target.kind === "url" ? "globe" : "file",
          closable: true,
          previewItem: item,
        }))
      : [];

  const panes: DesktopPane[] = [];
  if (primaryTabs.length > 0) {
    panes.push({
      id: "primary",
      activeTabId: snapshot.activeTabId,
      tabs: primaryTabs,
    });
  }
  if (previewTabs.length > 0) {
    panes.push({
      id: "secondary",
      activeTabId:
        previewTabs.find((tab) => tab.previewItem?.id === activeThreadPreviewState?.activeItemId)
          ?.id ?? previewTabs[0]?.id ?? null,
      tabs: previewTabs,
    });
  }

  return panes;
}

function deriveDesktopPaneLayout(snapshot: DesktopSnapshot | null): DesktopPaneNode | null {
  if (!snapshot) {
    return null;
  }

  if (snapshot.paneLayout) {
    return snapshot.paneLayout;
  }

  const panes = deriveDesktopPanes(snapshot);
  if (panes.length === 0) {
    return null;
  }
  if (panes.length === 1) {
    return {
      id: panes[0]!.id,
      kind: "pane",
    };
  }

  return {
    id: "root",
    kind: "split",
    direction: "horizontal",
    children: panes.map((pane) => ({
      id: pane.id,
      kind: "pane" as const,
    })),
    sizes: null,
  };
}

function isSupportedPluginWebviewEntrypoint(
  entrypoint: string | null | undefined,
): entrypoint is string {
  if (!entrypoint) {
    return false;
  }

  return (
    /^(https?:|data:|file:)/.test(entrypoint) ||
    entrypoint.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(entrypoint) ||
    entrypoint.startsWith("\\\\")
  );
}

function withPluginWebviewContext(
  source: string,
  context: {
    pluginId?: string | null;
    surfaceId?: string | null;
    params?: Record<string, string | null | undefined>;
  },
): string {
  try {
    const url = new URL(source);
    const params = new URLSearchParams();
    if (context.pluginId) {
      params.set("pluginId", context.pluginId);
    }
    if (context.surfaceId) {
      params.set("surfaceId", context.surfaceId);
    }
    for (const [key, value] of Object.entries(context.params ?? {})) {
      if (value) {
        params.set(key, value);
      }
    }

    if (url.protocol === "file:") {
      url.hash = params.toString();
      return url.toString();
    }

    for (const [key, value] of params.entries()) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  } catch {
    return source;
  }
}

function useResolvedPluginWebviewSource(entrypoint: string | null | undefined): {
  resolvedWebviewSrc: string | null;
  webviewError: string | null;
} {
  const [resolvedWebviewSrc, setResolvedWebviewSrc] = useState<string | null>(null);
  const [webviewError, setWebviewError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function resolveWebviewSource() {
      if (!entrypoint || !isSupportedPluginWebviewEntrypoint(entrypoint)) {
        setResolvedWebviewSrc(null);
        setWebviewError(null);
        return;
      }

      if (desktopShell?.resolveWebviewSrc) {
        try {
          const nextSrc = await desktopShell.resolveWebviewSrc(entrypoint);
          if (!cancelled) {
            setResolvedWebviewSrc(nextSrc);
            setWebviewError(null);
          }
          return;
        } catch (error) {
          if (!cancelled) {
            setResolvedWebviewSrc(null);
            setWebviewError(error instanceof Error ? error.message : String(error));
          }
          return;
        }
      }

      if (!cancelled) {
        setResolvedWebviewSrc(entrypoint);
        setWebviewError(null);
      }
    }

    void resolveWebviewSource();

    return () => {
      cancelled = true;
    };
  }, [entrypoint]);

  return {
    resolvedWebviewSrc,
    webviewError,
  };
}

function toDesktopPreviewTarget(target: PreviewTarget): DesktopPreviewTarget {
  if (target.kind === "url") {
    return {
      kind: "url",
      url: target.url,
      title: target.title ?? null,
    };
  }

  return {
    kind: "file",
    source: target.source,
    workspaceId: target.workspaceId,
    path: target.path,
    filename: target.filename ?? null,
    title: target.title ?? null,
    contentType: target.contentType ?? null,
  };
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function focusWorkbenchTab(tabId: string): void {
  window.requestAnimationFrame(() => {
    const tabButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="tab"][data-tab-id]'),
    ).find((button) => button.dataset.tabId === tabId);
    tabButton?.focus();
  });
}

function runtimeDetail(snapshot: DesktopSnapshot | null): string | null {
  if (!snapshot) {
    return null;
  }
  const detail = snapshot.runtimeStatus.detail?.trim();
  return detail || null;
}

function getDraftKey(threadId: string | null): string {
  return threadId ?? EMPTY_THREAD_DRAFT_KEY;
}

function shouldShowRuntimeNotice(snapshot: DesktopSnapshot | null): boolean {
  if (!snapshot) {
    return false;
  }

  return snapshot.runtimeStatus.state === "error" && Boolean(runtimeDetail(snapshot));
}

function coerceTextContent(content: string | ContentBlock[]): string {
  if (typeof content === "string") {
    return content.trim();
  }

  return content
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function appendAssistantDeltaContent(
  content: string | ContentBlock[],
  delta: string,
): string | ContentBlock[] {
  if (typeof content === "string") {
    return `${content}${delta}`;
  }

  const nextContent = [...content];
  const lastBlock = nextContent[nextContent.length - 1];
  if (lastBlock?.type === "text") {
    nextContent[nextContent.length - 1] = {
      ...lastBlock,
      text: `${lastBlock.text}${delta}`,
    };
    return nextContent;
  }

  nextContent.push({ type: "text", text: delta });
  return nextContent;
}

type DraftAttachment = Attachment & {
  originalName: string;
  uploadPath: string;
};

type ElectronFile = File & {
  path?: string;
};

function getDesktopFilePath(file: File): string | null {
  const candidate = (file as ElectronFile).path;
  return typeof candidate === "string" && candidate.trim() ? candidate : null;
}

function buildUploadReference(attachment: DraftAttachment): string {
  return `(user uploaded file named ${JSON.stringify(attachment.originalName)} to /mnt/user-uploads/${attachment.uploadPath})`;
}

function revokeAttachmentPreviewUrls(attachments: DraftAttachment[]) {
  for (const attachment of attachments) {
    if (attachment.previewUrl?.startsWith("blob:")) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
  }
}

function UploadedFileChips({
  refs,
}: {
  refs: ReturnType<typeof parseUploadRefs>["refs"];
}) {
  const previewContext = useChatPreviewContext();
  if (!previewContext || refs.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {refs.map((ref) => (
        <FileCard
          key={ref.mountPath}
          filename={ref.originalName}
          onClick={() => {
            previewContext.openPreviewTarget({
              kind: "file",
              source: "upload",
              workspaceId: DESKTOP_WORKSPACE_ID,
              path: ref.filename,
              filename: ref.originalName,
            });
          }}
        />
      ))}
    </div>
  );
}

function MessageRow({ message }: { message: Message }) {
  if (message.isMeta || message.sourceToolUseID) {
    return null;
  }

  if (message.role === "user") {
    const rawContent = coerceTextContent(message.content);
    if (!rawContent) {
      return null;
    }
    const uploadInfo = parseUploadRefs(rawContent);
    const visibleContent = uploadInfo.cleanContent;

    return (
      <div className="group flex flex-col items-end gap-2 py-3">
        <UploadedFileChips refs={uploadInfo.refs} />
        {visibleContent ? (
          <div className="max-w-[85%] rounded-3xl border border-border bg-muted/30 px-4 py-3 text-foreground">
            <div className="max-w-none">
              <MarkdownRenderer content={visibleContent} variant="user" />
            </div>
          </div>
        ) : null}
        <div className="flex items-center gap-0.5 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
          <span>{formatTime(message.created_at)}</span>
        </div>
      </div>
    );
  }

  const isStreaming = Boolean(message.isStreaming);
  const hasContent =
    typeof message.content === "string"
      ? Boolean(message.content.trim())
      : message.content.length > 0;

  return (
    <div className="group flex flex-col gap-1 py-3">
      {hasContent ? (
        <div className="max-w-none space-y-4">
          <ContentBlockRenderer
            content={message.content}
            messageId={message.id}
            isStreaming={isStreaming}
          />
        </div>
      ) : null}
      {isStreaming && <LoadingDots />}
      {hasContent && (
        <div className="flex items-center gap-0.5 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
          <span>{formatTime(message.created_at)}</span>
        </div>
      )}
    </div>
  );
}

const MemoizedMessageRow = memo(
  MessageRow,
  (prev, next) => prev.message === next.message,
);

function TranscriptPane({
  rawMessages,
}: {
  rawMessages: Message[];
}) {
  const messagesViewportRef = useRef<HTMLDivElement | null>(null);
  const messages = useMemo(
    () =>
      mergeTaskNotifications(
        mergeTeammateMessages(normalizeToolResultMessages(rawMessages)),
      ),
    [rawMessages],
  );

  useEffect(() => {
    const viewport = messagesViewportRef.current;
    if (!viewport) return;
    const frameId = window.requestAnimationFrame(() => {
      viewport.scrollTop = viewport.scrollHeight;
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [messages]);

  return (
    <div
      ref={messagesViewportRef}
      role="region"
      aria-label="Chat messages"
      className="flex flex-1 flex-col overflow-y-auto overflow-x-hidden"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 pb-6 pt-2 md:px-6">
        {messages.length === 0 ? (
          <div className="flex flex-1 items-center justify-center py-12">
            <div className="max-w-md text-center">
              <h2 className="text-xl font-semibold">Start a new chat</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                Chat is now a contributed workbench view. Builtin and trusted
                extensions can own how thread conversations are rendered.
              </p>
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <MemoizedMessageRow key={message.id} message={message} />
          ))
        )}
      </div>
    </div>
  );
}

const MemoizedTranscriptPane = memo(
  TranscriptPane,
  (prev, next) => prev.rawMessages === next.rawMessages,
);

function ComposerToolbar({
  availableProviders,
  availableModels,
  availableModelSources,
  provider,
  model,
  modelSource,
  onSetProvider,
  onSetModel,
  onSetModelSource,
}: {
  availableProviders: DesktopSnapshot["availableProviders"];
  availableModels: DesktopSnapshot["availableModels"];
  availableModelSources: DesktopSnapshot["availableModelSources"];
  provider: DesktopProvider;
  model: DesktopModel;
  modelSource: DesktopModelSource;
  onSetProvider: (provider: DesktopProvider) => void;
  onSetModel: (model: string) => void;
  onSetModelSource: (modelSource: string) => void;
}) {
  const showModelSourceSelector = availableModelSources.length > 1;
  const modelSelectDisabled = showModelSourceSelector && availableModels.length <= 1;

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Select
        value={provider}
        onValueChange={(value) => onSetProvider(value as DesktopProvider)}
      >
        <SelectTrigger
          size="sm"
          className="desktop-chat-provider-switcher w-[148px]"
          aria-label="Provider"
        >
          <SelectValue placeholder="Provider" />
        </SelectTrigger>
        <SelectContent>
          {availableProviders.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {showModelSourceSelector ? (
        <Select value={modelSource} onValueChange={onSetModelSource}>
          <SelectTrigger
            size="sm"
            className="desktop-chat-model-source-switcher w-[168px]"
            aria-label="Model source"
          >
            <SelectValue placeholder="Source" />
          </SelectTrigger>
          <SelectContent>
            {availableModelSources.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      <Select
        value={model}
        onValueChange={onSetModel}
        disabled={modelSelectDisabled}
      >
        <SelectTrigger
          size="sm"
          className="desktop-chat-model-switcher w-[168px]"
          aria-label="Model"
        >
          <SelectValue placeholder="Model" />
        </SelectTrigger>
        <SelectContent>
          {availableModels.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

const MemoizedComposerToolbar = memo(
  ComposerToolbar,
  (prev, next) =>
    prev.availableProviders === next.availableProviders &&
    prev.availableModels === next.availableModels &&
    prev.availableModelSources === next.availableModelSources &&
    prev.provider === next.provider &&
    prev.model === next.model &&
    prev.modelSource === next.modelSource &&
    prev.onSetProvider === next.onSetProvider &&
    prev.onSetModel === next.onSetModel &&
    prev.onSetModelSource === next.onSetModelSource,
);

function Composer({
  availableProviders,
  availableModels,
  availableModelSources,
  activeThreadId,
  initialDraft,
  isStreaming,
  provider,
  model,
  modelSource,
  onDraftChange,
  onSetProvider,
  onSetModel,
  onSetModelSource,
  onStopThread,
  onSubmitMessage,
}: {
  availableProviders: DesktopSnapshot["availableProviders"];
  availableModels: DesktopSnapshot["availableModels"];
  availableModelSources: DesktopSnapshot["availableModelSources"];
  activeThreadId: string | null;
  initialDraft: string;
  isStreaming: boolean;
  provider: DesktopProvider;
  model: DesktopModel;
  modelSource: DesktopModelSource;
  onDraftChange: (threadId: string | null, draft: string) => void;
  onSetProvider: (provider: DesktopProvider) => void;
  onSetModel: (model: string) => void;
  onSetModelSource: (modelSource: string) => void;
  onStopThread: (threadId: string) => void;
  onSubmitMessage: (threadId: string, content: string) => void;
}) {
  const [draft, setDraft] = useState(initialDraft);
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const attachmentsRef = useRef<DraftAttachment[]>([]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    setDraft(initialDraft);
    setAttachments((previousAttachments) => {
      revokeAttachmentPreviewUrls(previousAttachments);
      return [];
    });
  }, [activeThreadId, initialDraft]);

  useEffect(() => {
    return () => {
      revokeAttachmentPreviewUrls(attachmentsRef.current);
    };
  }, []);

  useEffect(() => {
    if (!activeThreadId) {
      return;
    }

    const focusComposer = () => {
      const textarea = composerTextareaRef.current;
      if (!textarea || textarea.disabled) {
        return;
      }

      textarea.focus({ preventScroll: true });
      const selectionEnd = textarea.value.length;
      textarea.setSelectionRange(selectionEnd, selectionEnd);
    };

    const frameId = window.requestAnimationFrame(focusComposer);
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [activeThreadId]);

  const handleChange = useCallback((value: string) => {
    setDraft(value);
    onDraftChange(activeThreadId, value);
  }, [activeThreadId, onDraftChange]);

  const handleSubmit = useCallback(() => {
    if (!activeThreadId) return;
    const uploadRefs = attachments
      .filter((attachment) => attachment.status === "complete")
      .map((attachment) => buildUploadReference(attachment));
    const trimmedDraft = draft.trim();
    const content = [trimmedDraft, uploadRefs.join("\n")]
      .filter((value) => value.length > 0)
      .join(trimmedDraft ? "\n\n" : "\n");
    if (!content) return;

    onSubmitMessage(activeThreadId, content);
    setDraft("");
    revokeAttachmentPreviewUrls(attachments);
    setAttachments([]);
    onDraftChange(activeThreadId, "");
  }, [activeThreadId, attachments, draft, onDraftChange, onSubmitMessage]);

  const handleStageFiles = useCallback(async (
    entries: Array<{
      sourcePath: string;
      file?: File;
    }>,
  ) => {
    if (!desktopShell?.importLocalFiles) {
      toast.error("Desktop file staging is unavailable.");
      return;
    }

    const pendingAttachments: DraftAttachment[] = entries.map(({ file, sourcePath }) => ({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: file?.name ?? sourcePath.split(/[\\/]/).pop() ?? "file",
      originalName: file?.name ?? sourcePath.split(/[\\/]/).pop() ?? "file",
      path: "",
      uploadPath: "",
      size: file?.size ?? 0,
      contentType: file?.type || undefined,
      previewUrl:
        file && file.type.startsWith("image/")
          ? URL.createObjectURL(file)
          : undefined,
      progress: 20,
      status: "uploading",
    }));

    setAttachments((current) => [...current, ...pendingAttachments]);

    try {
      const importedFiles = await desktopShell.importLocalFiles(
        entries.map((entry) => entry.sourcePath),
      );
      setAttachments((current) =>
        current.map((attachment) => {
          const index = pendingAttachments.findIndex((pending) => pending.id === attachment.id);
          if (index === -1) {
            return attachment;
          }
          const imported = importedFiles[index];
          return imported
            ? {
                ...attachment,
                name: imported.originalName,
                originalName: imported.originalName,
                path: imported.relativePath,
                uploadPath: imported.relativePath,
                size: imported.size,
                progress: 100,
                status: "complete",
              }
            : {
                ...attachment,
                progress: undefined,
                status: "error",
                error: "The desktop app did not return a staged file.",
              };
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAttachments((current) =>
        current.map((attachment) =>
          pendingAttachments.some((pending) => pending.id === attachment.id)
            ? {
                ...attachment,
                progress: undefined,
                status: "error",
                error: message,
              }
            : attachment,
        ),
      );
      toast.error(message || "Failed to upload files.");
    }
  }, []);

  const handleFilesSelected = useCallback(async (files: File[]) => {
    const pathEntries: Array<{ sourcePath: string; file: File }> = [];
    const payloadFiles: File[] = [];

    for (const file of files) {
      const sourcePath = getDesktopFilePath(file);
      if (sourcePath) {
        pathEntries.push({ sourcePath, file });
        continue;
      }
      payloadFiles.push(file);
    }

    if (pathEntries.length > 0) {
      await handleStageFiles(pathEntries);
    }

    if (payloadFiles.length === 0) {
      return;
    }

    if (!desktopShell?.importFilePayloads) {
      toast.error("These files could not be imported from the desktop environment.");
      return;
    }

    const pendingAttachments: DraftAttachment[] = payloadFiles.map((file) => ({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: file.name || "file",
      originalName: file.name || "file",
      path: "",
      uploadPath: "",
      size: file.size,
      contentType: file.type || undefined,
      previewUrl:
        file.type.startsWith("image/")
          ? URL.createObjectURL(file)
          : undefined,
      progress: 20,
      status: "uploading",
    }));

    setAttachments((current) => [...current, ...pendingAttachments]);

    try {
      const payloads = await Promise.all(
        payloadFiles.map(async (file) => ({
          name: file.name || "file",
          bytes: await file.arrayBuffer(),
        })),
      );
      const importedFiles = await desktopShell.importFilePayloads(payloads);
      setAttachments((current) =>
        current.map((attachment) => {
          const index = pendingAttachments.findIndex((pending) => pending.id === attachment.id);
          if (index === -1) {
            return attachment;
          }
          const imported = importedFiles[index];
          return imported
            ? {
                ...attachment,
                name: imported.originalName,
                originalName: imported.originalName,
                path: imported.relativePath,
                uploadPath: imported.relativePath,
                size: imported.size,
                progress: 100,
                status: "complete",
              }
            : {
                ...attachment,
                progress: undefined,
                status: "error",
                error: "The desktop app did not return a staged file.",
              };
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAttachments((current) =>
        current.map((attachment) =>
          pendingAttachments.some((pending) => pending.id === attachment.id)
            ? {
                ...attachment,
                progress: undefined,
                status: "error",
                error: message,
              }
            : attachment,
        ),
      );
      toast.error(message || "Failed to upload files.");
    }
  }, [handleStageFiles]);

  const handleAttachmentRemove = useCallback((attachmentId: string) => {
    setAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === attachmentId);
      if (removed?.previewUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(removed.previewUrl);
      }
      return current.filter((attachment) => attachment.id !== attachmentId);
    });
  }, []);

  return (
    <div className="flex flex-col gap-2">
      <MemoizedComposerToolbar
        availableProviders={availableProviders}
        availableModels={availableModels}
        availableModelSources={availableModelSources}
        provider={provider}
        model={model}
        modelSource={modelSource}
        onSetProvider={onSetProvider}
        onSetModel={onSetModel}
        onSetModelSource={onSetModelSource}
      />
      <PromptInput
        className="shrink-0"
        value={draft}
        onChange={handleChange}
        onSubmit={handleSubmit}
        onStop={activeThreadId ? () => onStopThread(activeThreadId) : undefined}
        attachments={attachments}
        onFilesSelected={handleFilesSelected}
        onAttachmentRemove={handleAttachmentRemove}
        placeholder="Type a message..."
        isAssistantRunning={isStreaming}
        textareaRef={composerTextareaRef}
      />
    </div>
  );
}

const MemoizedComposer = memo(
  Composer,
  (prev, next) =>
    prev.availableProviders === next.availableProviders &&
    prev.availableModels === next.availableModels &&
    prev.availableModelSources === next.availableModelSources &&
    prev.activeThreadId === next.activeThreadId &&
    prev.initialDraft === next.initialDraft &&
    prev.isStreaming === next.isStreaming &&
    prev.provider === next.provider &&
    prev.model === next.model &&
    prev.modelSource === next.modelSource &&
    prev.onDraftChange === next.onDraftChange &&
    prev.onSetProvider === next.onSetProvider &&
    prev.onSetModel === next.onSetModel &&
    prev.onSetModelSource === next.onSetModelSource &&
    prev.onStopThread === next.onStopThread &&
    prev.onSubmitMessage === next.onSubmitMessage,
);

function normalizeTodoStatus(status: unknown): TodoItem["status"] {
  if (status === "completed") return "completed";
  if (status === "in_progress" || status === "inProgress") return "in_progress";
  return "pending";
}

function extractLatestTodos(messages: Message[]): TodoItem[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    for (let j = message.content.length - 1; j >= 0; j -= 1) {
      const block = message.content[j];
      if (
        block.type === "tool_use" &&
        block.name === "TodoWrite" &&
        block.input &&
        typeof block.input === "object"
      ) {
        const rawTodos = (block.input as { todos?: unknown }).todos;
        if (!Array.isArray(rawTodos)) continue;
        return rawTodos
          .map((entry): TodoItem | null => {
            if (!entry || typeof entry !== "object") return null;
            const record = entry as Record<string, unknown>;
            const content =
              typeof record.content === "string" && record.content.trim()
                ? record.content
                : null;
            if (!content) return null;
            const activeForm =
              typeof record.activeForm === "string" && record.activeForm.trim()
                ? record.activeForm
                : content;
            return {
              content,
              status: normalizeTodoStatus(record.status),
              activeForm,
            };
          })
          .filter((todo): todo is TodoItem => todo !== null);
      }
    }
  }
  return [];
}

function ChatThreadView({
  snapshot,
  activeThreadId,
  rawMessages,
  initialDraft,
  isStreaming,
  onDraftChange,
  onSetProvider,
  onSetModel,
  onSetModelSource,
  onStopThread,
  onSubmitMessage,
  onOpenPreviewTarget,
  onSetPreviewTargets,
  onClearPreviewTargets,
}: Pick<
  HostSurfaceComponentProps,
  | "snapshot"
  | "activeThreadId"
  | "rawMessages"
  | "initialDraft"
  | "isStreaming"
  | "onDraftChange"
  | "onSetProvider"
  | "onSetModel"
  | "onSetModelSource"
  | "onStopThread"
  | "onSubmitMessage"
  | "onOpenPreviewTarget"
  | "onSetPreviewTargets"
  | "onClearPreviewTargets"
>) {
  const currentTodos = useMemo(() => extractLatestTodos(rawMessages), [rawMessages]);

  return (
    <ChatPreviewProvider
      value={{
        openPreviewTarget: onOpenPreviewTarget,
        setPreviewTargets: onSetPreviewTargets,
        clearPreviewTarget: onClearPreviewTargets,
      }}
    >
      <>
        <MemoizedTranscriptPane rawMessages={rawMessages} />

        <div className="sticky bottom-0 z-20 shrink-0">
          <div
            className="pointer-events-none absolute inset-x-0 bottom-full h-8 bg-gradient-to-t from-background to-transparent"
            aria-hidden="true"
          />
          <div className="bg-background">
            <div className="px-4 pb-4 pt-2">
              <div className="mx-auto flex w-full max-w-3xl flex-col max-h-[calc(100dvh-2rem)]">
                {currentTodos.length > 0 && (
                  <div className="mb-2">
                    <FloatingTodoList
                      todos={currentTodos}
                      isStreaming={isStreaming}
                    />
                  </div>
                )}
                <MemoizedComposer
                  availableProviders={snapshot.availableProviders}
                  availableModels={snapshot.availableModels}
                  availableModelSources={snapshot.availableModelSources}
                  activeThreadId={activeThreadId}
                  initialDraft={initialDraft}
                  isStreaming={isStreaming}
                  provider={snapshot.provider}
                  model={snapshot.model}
                  modelSource={snapshot.modelSource}
                  onDraftChange={onDraftChange}
                  onSetProvider={onSetProvider}
                  onSetModel={onSetModel}
                  onSetModelSource={onSetModelSource}
                  onStopThread={onStopThread}
                  onSubmitMessage={onSubmitMessage}
                />
              </div>
            </div>
          </div>
        </div>
      </>
    </ChatPreviewProvider>
  );
}

function formatKanbanTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function resolveKanbanLane(
  snapshot: DesktopSnapshot,
  thread: DesktopThread,
): KanbanLaneId {
  const runtime = snapshot.threadRuntimeById[thread.id];
  if (thread.archivedAt !== null) {
    return "finished";
  }
  if (runtime?.isRunning) {
    return "in_progress";
  }
  switch (thread.lane) {
    case "drafts":
    case "in_progress":
    case "ready_for_review":
    case "finished":
      return thread.lane;
    default:
      if (thread.hasUnreadUpdate) {
        return "ready_for_review";
      }
      return runtime?.hasMessages ? "ready_for_review" : "drafts";
  }
}

function threadUpdatesForKanbanLane(lane: KanbanLaneId): {
  status: string;
  lane: KanbanLaneId;
  archivedAt: number | null;
} {
  switch (lane) {
    case "drafts":
      return { status: "draft", lane, archivedAt: null };
    case "in_progress":
      return { status: "in_progress", lane, archivedAt: null };
    case "ready_for_review":
      return { status: "ready_for_review", lane, archivedAt: null };
    case "finished":
      return { status: "finished", lane, archivedAt: Date.now() };
  }
}

function KanbanBoardPane({
  onRequestCreateGroup,
  onRequestDeleteGroup,
  onRequestRenameGroup,
  snapshot,
  onSendEvent,
}: Pick<
  HostSurfaceComponentProps,
  | "onRequestCreateGroup"
  | "onRequestDeleteGroup"
  | "onRequestRenameGroup"
  | "snapshot"
  | "onSendEvent"
>) {
  const [draggedThreadId, setDraggedThreadId] = useState<string | null>(null);
  const activeGroup = useMemo(() => getActiveThreadGroup(snapshot), [snapshot]);
  const activeGroupThreads = useMemo(
    () =>
      activeGroup
        ? snapshot.threads.filter((thread) => thread.groupId === activeGroup.id)
        : [],
    [activeGroup, snapshot.threads],
  );

  const lanes = useMemo(
    () =>
      KANBAN_LANES.map((lane) => ({
        ...lane,
        threads: activeGroupThreads.filter(
          (thread) => resolveKanbanLane(snapshot, thread) === lane.id,
        ),
      })),
    [activeGroupThreads, snapshot],
  );

  const handleCreateDraft = useCallback(() => {
    onSendEvent({
      type: "create_thread",
      groupId: activeGroup?.id,
      ...threadUpdatesForKanbanLane("drafts"),
    });
  }, [activeGroup?.id, onSendEvent]);

  const handleMoveThread = useCallback(
    (threadId: string, lane: KanbanLaneId) => {
      onSendEvent({
        type: "update_thread",
        threadId,
        updates: threadUpdatesForKanbanLane(lane),
      });
    },
    [onSendEvent],
  );

  const handleOpenThread = useCallback(
    (threadId: string) => {
      onSendEvent({
        type: "select_thread",
        threadId,
      });
    },
    [onSendEvent],
  );

  const handleDrop =
    (lane: KanbanLaneId) => (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (draggedThreadId) {
        handleMoveThread(draggedThreadId, lane);
      }
      setDraggedThreadId(null);
    };

  return (
    <div className="flex min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
      <div className="mx-auto flex min-h-0 w-full max-w-[1600px] flex-col gap-6 px-4 pb-8 pt-5 md:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 className="font-heading text-lg font-semibold">Kanban</h2>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Organize the current session group as drafts, active work,
              review-ready sessions, and finished archives.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={activeGroup?.id ?? undefined}
              onValueChange={(groupId) => {
                onSendEvent({
                  type: "select_group",
                  groupId,
                });
              }}
            >
              <SelectTrigger className="w-[220px] bg-background">
                <SelectValue placeholder="Select group" />
              </SelectTrigger>
              <SelectContent>
                {snapshot.threadGroups.map((group) => (
                  <SelectItem key={group.id} value={group.id}>
                    {group.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="outline"
              onClick={onRequestCreateGroup}
            >
              New Group
            </Button>
            {activeGroup ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onRequestRenameGroup(activeGroup.id)}
              >
                <Pencil className="size-3.5" />
                Rename Group
              </Button>
            ) : null}
            {activeGroup && activeGroup.id !== snapshot.threadGroups[0]?.id ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onRequestDeleteGroup(activeGroup.id)}
              >
                <Trash2 className="size-3.5" />
                Delete Group
              </Button>
            ) : null}
            <Button size="sm" onClick={handleCreateDraft}>
              New Draft
            </Button>
          </div>
        </div>

        <div className="grid min-h-0 gap-4 xl:grid-cols-4">
          {lanes.map((lane, laneIndex) => (
            <section
              key={lane.id}
              className="flex min-h-[28rem] flex-col rounded-2xl border border-border/70 bg-muted/25"
              onDragOver={(event) => {
                event.preventDefault();
              }}
              onDrop={handleDrop(lane.id)}
            >
              <div className="border-b border-border/60 px-4 py-4">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold uppercase tracking-[0.16em] text-foreground/85">
                      {lane.title}
                    </h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {lane.description}
                    </p>
                  </div>
                  <Badge variant="secondary">{lane.threads.length}</Badge>
                </div>
              </div>

              <div className="flex flex-1 flex-col gap-3 p-3">
                {lane.threads.length === 0 ? (
                  <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-border/70 bg-background/60 px-4 py-6 text-center text-sm text-muted-foreground">
                    Drop a thread here.
                  </div>
                ) : (
                  lane.threads.map((thread) => {
                    const runtime = snapshot.threadRuntimeById[thread.id];
                    return (
                      <Card
                        key={thread.id}
                        size="sm"
                        draggable
                        onDragStart={() => {
                          setDraggedThreadId(thread.id);
                        }}
                        onDragEnd={() => {
                          setDraggedThreadId(null);
                        }}
                        className="cursor-grab border-border/70 bg-background/95 active:cursor-grabbing"
                      >
                        <CardHeader className="gap-3">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="space-y-1">
                              <CardTitle className="text-sm leading-snug">
                                {thread.title}
                              </CardTitle>
                              <CardDescription className="text-xs">
                                Updated {formatKanbanTimestamp(thread.updatedAt)}
                              </CardDescription>
                            </div>
                            <div className="flex flex-wrap gap-1">
                              <Badge variant="outline">{thread.provider}</Badge>
                              {thread.hasUnreadUpdate ? (
                                <Badge variant="secondary">New review</Badge>
                              ) : null}
                              {runtime?.isRunning ? (
                                <Badge variant="default">
                                  {runtime.stopRequested ? "Stopping" : "Running"}
                                </Badge>
                              ) : null}
                              {thread.archivedAt !== null ? (
                                <Badge variant="secondary">Archived</Badge>
                              ) : null}
                            </div>
                          </div>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <p className="min-h-12 line-clamp-3 text-sm text-muted-foreground">
                            {thread.lastMessagePreview ??
                              "No messages yet. This thread is still a draft."}
                          </p>

                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => {
                                handleOpenThread(thread.id);
                              }}
                            >
                              Open
                            </Button>
                            {runtime?.isRunning ? (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  onSendEvent({
                                    type: "stop_thread",
                                    threadId: thread.id,
                                  });
                                }}
                              >
                                Stop
                              </Button>
                            ) : null}
                            {lane.id === "finished" ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  handleMoveThread(thread.id, "ready_for_review");
                                }}
                              >
                                <ArrowLeft className="size-4" />
                                Restore
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  handleMoveThread(thread.id, "finished");
                                }}
                              >
                                <Archive className="size-4" />
                                Finish
                              </Button>
                            )}
                          </div>

                          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                            <span>
                              {runtime?.hasMessages ? "Has messages" : "Empty thread"}
                            </span>
                            <div className="flex items-center gap-1">
                              {laneIndex > 0 ? (
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="size-7"
                                  onClick={() => {
                                    handleMoveThread(
                                      thread.id,
                                      KANBAN_LANES[laneIndex - 1].id,
                                    );
                                  }}
                                >
                                  <ArrowLeft className="size-3.5" />
                                </Button>
                              ) : (
                                <span className="size-7" />
                              )}
                              {laneIndex < KANBAN_LANES.length - 1 ? (
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="size-7"
                                  onClick={() => {
                                    handleMoveThread(
                                      thread.id,
                                      KANBAN_LANES[laneIndex + 1].id,
                                    );
                                  }}
                                >
                                  <ArrowRight className="size-3.5" />
                                </Button>
                              ) : (
                                <span className="size-7" />
                              )}
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })
                )}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

function ExtensionCatalogPane({
  snapshot,
  onSendEvent,
}: Pick<HostSurfaceComponentProps, "snapshot" | "onSendEvent">) {
  const [isInstallingPlugin, setIsInstallingPlugin] = useState(false);
  const [installFeedback, setInstallFeedback] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);
  const canInstallPlugins = Boolean(desktopShell?.installPlugin);
  const canOpenPluginDirectory = Boolean(desktopShell?.openPluginDirectory);

  const handleInstallPlugin = useCallback(async () => {
    if (!desktopShell?.installPlugin || isInstallingPlugin) {
      return;
    }

    setIsInstallingPlugin(true);
    setInstallFeedback(null);

    try {
      const result = await desktopShell.installPlugin();
      if (!result || result.status === "cancelled") {
        return;
      }

      setInstallFeedback({
        tone: "success",
        message: `${result.replaced ? "Updated" : "Installed"} ${result.pluginName ?? result.pluginId ?? "plugin"}${result.pluginId ? ` (${result.pluginId})` : ""}${result.installPath ? ` in ${result.installPath}.` : "."}`,
      });
    } catch (error) {
      setInstallFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsInstallingPlugin(false);
    }
  }, [isInstallingPlugin]);

  const handleOpenPluginDirectory = useCallback(async () => {
    if (!desktopShell?.openPluginDirectory) {
      return;
    }

    try {
      await desktopShell.openPluginDirectory();
    } catch (error) {
      setInstallFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const handleSetPluginEnabled = useCallback(
    (pluginId: string, enabled: boolean) => {
      onSendEvent({
        type: "set_plugin_enabled",
        pluginId,
        enabled,
      });
    },
    [onSendEvent],
  );

  return (
    <div className="flex min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
      <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-col gap-4 px-4 pb-8 pt-5 md:px-6">
        <div className="space-y-3">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold font-heading">Extension Lab</h2>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Install plugins and inspect the ones currently loaded by the
              desktop app. Re-installing the same `camelai.id` updates that
              plugin in place.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => {
                void handleInstallPlugin();
              }}
              disabled={!canInstallPlugins || isInstallingPlugin}
            >
              {isInstallingPlugin ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Installing...
                </>
              ) : (
                "Install Plugin"
              )}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void handleOpenPluginDirectory();
              }}
              disabled={!canOpenPluginDirectory}
            >
              Open Plugins Folder
            </Button>
          </div>
          {installFeedback ? (
            <Alert
              variant={
                installFeedback.tone === "error" ? "destructive" : "default"
              }
            >
              <AlertTitle>
                {installFeedback.tone === "error"
                  ? "Install failed"
                  : "Plugin installed"}
              </AlertTitle>
              <AlertDescription>{installFeedback.message}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        <Card size="sm">
          <CardHeader className="gap-1">
            <CardTitle>Installed plugins</CardTitle>
            <CardDescription>
              {snapshot.plugins.length === 1
                ? "1 plugin loaded"
                : `${snapshot.plugins.length} plugins loaded`}
            </CardDescription>
          </CardHeader>
          {snapshot.plugins.length === 0 ? (
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Builtin plugins and anything installed into the desktop data
                `plugins/` directory will appear here.
              </p>
            </CardContent>
          ) : (
            <CardContent className="px-0">
              <div className="divide-y divide-border/70">
                {snapshot.plugins.map((plugin) => {
                  const toolSummary =
                    plugin.capabilities.tools.length > 0
                      ? plugin.capabilities.tools.map((tool) => tool.id).join(", ")
                      : null;
                  const hookSummary =
                    plugin.runtime.subscribedEvents.length > 0
                      ? plugin.runtime.subscribedEvents.join(", ")
                      : null;
                  const permissionSummary =
                    plugin.permissions.length > 0
                      ? plugin.permissions.join(", ")
                      : null;
                  const settingsSummary =
                    plugin.settings && plugin.settings.fields.length > 0
                      ? plugin.settings.fields.map((field) => field.id).join(", ")
                      : null;
                  const stateLabel = !plugin.enabled
                    ? "disabled"
                    : !plugin.compatibility.compatible
                      ? "incompatible"
                      : plugin.runtime.activated
                        ? "activated"
                        : "discovered";

                  return (
                    <div key={plugin.id} className="space-y-3 px-3 py-3 sm:px-4">
                      <div className="flex flex-col gap-2 xl:flex-row xl:items-start xl:justify-between">
                        <div className="min-w-0 space-y-1">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <CardTitle>{plugin.name}</CardTitle>
                            <Badge variant="secondary">{plugin.source}</Badge>
                            <Badge
                              variant={
                                plugin.enabled && plugin.compatibility.compatible
                                  ? "secondary"
                                  : "outline"
                              }
                            >
                              {stateLabel}
                            </Badge>
                            <Badge variant="outline">
                              {plugin.disableable ? "manageable" : "protected"}
                            </Badge>
                            {!plugin.compatibility.compatible ? (
                              <Badge variant="destructive">api mismatch</Badge>
                            ) : null}
                            {plugin.runtime.activationError ? (
                              <Badge variant="destructive">activation error</Badge>
                            ) : null}
                          </div>
                          <CardDescription className="break-words">
                            {plugin.description ?? "No plugin description yet."}
                          </CardDescription>
                        </div>
                        <div className="flex shrink-0 items-center gap-2 self-start">
                          <p className="text-xs text-muted-foreground">
                            v{plugin.version}
                          </p>
                          {plugin.disableable ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                handleSetPluginEnabled(plugin.id, !plugin.enabled);
                              }}
                            >
                              {plugin.enabled ? "Disable" : "Enable"}
                            </Button>
                          ) : null}
                        </div>
                      </div>

                      <div className="grid gap-3 text-sm xl:grid-cols-[minmax(0,1fr)_minmax(18rem,28rem)]">
                        <div className="space-y-2">
                          <p className="text-sm text-muted-foreground">
                            {plugin.capabilities.views.length} views ·{" "}
                            {plugin.capabilities.sidebarPanels.length} sidebar panels ·{" "}
                            {plugin.capabilities.commands.length} commands ·{" "}
                            {plugin.capabilities.tools.length} tools
                          </p>

                          {toolSummary ? (
                            <p className="text-sm leading-relaxed text-muted-foreground">
                              Tools:{" "}
                              <span className="break-words text-foreground">
                                {toolSummary}
                              </span>
                            </p>
                          ) : null}

                          {hookSummary ? (
                            <p className="text-sm leading-relaxed text-muted-foreground">
                              Hooks:{" "}
                              <span className="break-words text-foreground">
                                {hookSummary}
                              </span>
                            </p>
                          ) : null}

                          {permissionSummary ? (
                            <p className="text-sm leading-relaxed text-muted-foreground">
                              Permissions:{" "}
                              <span className="break-words text-foreground">
                                {permissionSummary}
                              </span>
                            </p>
                          ) : null}

                          {settingsSummary ? (
                            <p className="text-sm leading-relaxed text-muted-foreground">
                              Settings fields:{" "}
                              <span className="break-words text-foreground">
                                {settingsSummary}
                              </span>
                            </p>
                          ) : null}
                        </div>

                        <div className="space-y-1 rounded-md border border-border/70 bg-muted/20 px-3 py-2">
                          <p className="text-xs leading-relaxed text-muted-foreground">
                            API v{plugin.compatibility.declaredApiVersion} · min v
                            {plugin.compatibility.minApiVersion} · host v
                            {plugin.compatibility.currentApiVersion}
                          </p>
                          <p className="break-all font-mono text-xs leading-relaxed text-foreground">
                            {plugin.id}
                          </p>
                          <p className="break-all font-mono text-xs leading-relaxed text-muted-foreground">
                            {plugin.path}
                          </p>
                        </div>
                      </div>

                      {!plugin.compatibility.compatible ? (
                        <Alert variant="destructive">
                          <AlertTitle>Compatibility issue</AlertTitle>
                          <AlertDescription className="break-words">
                            {plugin.compatibility.reason}
                          </AlertDescription>
                        </Alert>
                      ) : null}

                      {plugin.runtime.activationError ? (
                        <Alert variant="destructive">
                          <AlertTitle>Activation failed</AlertTitle>
                          <AlertDescription className="break-words">
                            {plugin.runtime.activationError}
                          </AlertDescription>
                        </Alert>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </CardContent>
          )}
        </Card>
      </div>
    </div>
  );
}

const HOST_SURFACE_COMPONENTS: Record<
  string,
  ComponentType<HostSurfaceComponentProps>
> = {
  "chat:thread-view": ChatThreadView,
  "extension-lab:catalog": ExtensionCatalogPane,
  "kanban:board": KanbanBoardPane,
};

function GenericHostDataPane({
  surface,
}: {
  surface: DesktopView;
}) {
  const ViewIcon = getDesktopIcon(surface.icon);
  return (
    <div className="flex flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 pb-8 pt-5 md:px-6">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-2xl border border-border bg-muted/40">
                <ViewIcon className="size-5" />
              </div>
              <div>
                <CardTitle>{surface.title}</CardTitle>
                <CardDescription>
                  {surface.description ??
                    "Plugin-provided data for the current container runtime context."}
                </CardDescription>
              </div>
            </div>
          </CardHeader>
        </Card>

        {surface.hostData?.sections.map((section) => (
          <Card key={section.id}>
            <CardHeader>
              <CardTitle>{section.title}</CardTitle>
            <CardDescription>
              {section.description ?? "Plugin-provided section"}
            </CardDescription>
          </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-2">
              {section.items.map((item) => (
                <div
                  key={`${section.id}:${item.label}`}
                  className="rounded-lg border border-border/60 bg-background/70 px-3 py-3"
                >
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                    {item.label}
                  </p>
                  <p className="mt-2 break-all text-sm text-foreground">
                    {item.value}
                  </p>
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function WebviewSurfacePane({
  surface,
}: {
  surface: DesktopView;
}) {
  const webviewEntrypoint =
    surface.render.kind === "webview" ? surface.render.entrypoint : null;
  const { resolvedWebviewSrc, webviewError } =
    useResolvedPluginWebviewSource(webviewEntrypoint);

  const contextualWebviewSrc = resolvedWebviewSrc
    ? withPluginWebviewContext(resolvedWebviewSrc, {
        pluginId: surface.pluginId,
        surfaceId: surface.id,
      })
    : null;

  return (
    <div className="flex flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 pb-8 pt-5 md:px-6">
        <Card>
          <CardHeader>
            <CardTitle>{surface.title}</CardTitle>
            <CardDescription>
              {surface.description ?? "Plugin-owned webview surface."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!isSupportedPluginWebviewEntrypoint(webviewEntrypoint) ? (
              <Alert>
                <AlertTitle>Unsupported webview entrypoint</AlertTitle>
                <AlertDescription>
                  Plugin webviews currently support `https:`, `http:`, `data:`,
                  and plugin-local HTML entrypoints.
                </AlertDescription>
              </Alert>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/60 bg-muted/20 px-4 py-3">
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-foreground">
                      Plugin webview
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Rendering plugin-owned workbench content.
                    </p>
                  </div>
                  <Button
                    disabled={!resolvedWebviewSrc}
                    onClick={() => {
                      if (!resolvedWebviewSrc) {
                        return;
                      }
                      window.open(resolvedWebviewSrc, "_blank", "noopener,noreferrer");
                    }}
                    type="button"
                    variant="outline"
                  >
                    Open in browser
                  </Button>
                </div>

                <div className="overflow-hidden rounded-2xl border border-border/70 bg-background shadow-sm">
                  {webviewError ? (
                    <Alert className="m-4">
                      <AlertTitle>Webview failed to load</AlertTitle>
                      <AlertDescription>{webviewError}</AlertDescription>
                    </Alert>
                  ) : contextualWebviewSrc ? (
                    <iframe
                      title={`${surface.title} plugin webview`}
                      src={contextualWebviewSrc}
                      className="min-h-[640px] w-full bg-white"
                      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div className="flex min-h-[640px] items-center justify-center bg-muted/10">
                      <div className="flex items-center gap-3 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" />
                        <span>Loading plugin surface…</span>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function WorkbenchSurfacePane(props: HostSurfaceComponentProps) {
  const { surface } = props;

  if (surface.render.kind === "host") {
    const componentKey =
      surface.pluginId && surface.render.component
        ? `${surface.pluginId}:${surface.render.component}`
        : surface.render.component ?? "";
    const HostComponent = surface.render.component
      ? HOST_SURFACE_COMPONENTS[componentKey]
      : null;
    if (HostComponent) {
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          <HostComponent {...props} />
        </div>
      );
    }

    if (surface.hostData) {
      return <GenericHostDataPane surface={surface} />;
    }

    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <Alert className="max-w-xl">
          <AlertTitle>Unknown host surface</AlertTitle>
          <AlertDescription>
            No renderer host component is registered for `{surface.render.component}`.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return <WebviewSurfacePane surface={surface} />;
}

function PreviewProviderPane({
  item,
  threadId,
}: {
  item: DesktopThreadPreviewState["items"][number];
  threadId: string;
}) {
  const renderer = item.renderer;
  const webviewEntrypoint =
    renderer?.render.kind === "webview" ? renderer.render.entrypoint : null;
  const { resolvedWebviewSrc, webviewError } =
    useResolvedPluginWebviewSource(webviewEntrypoint);

  const contextualWebviewSrc =
    resolvedWebviewSrc && renderer?.render.kind === "webview"
      ? withPluginWebviewContext(resolvedWebviewSrc, {
          pluginId: renderer.pluginId,
          params: {
            previewProviderId: renderer.providerId,
            previewThreadId: threadId,
            previewItemId: item.id,
            previewKind: item.target.kind,
            previewTitle: item.title,
            previewContentType: item.contentType ?? undefined,
            previewSrc: item.src ?? undefined,
            previewFilename:
              item.target.kind === "file"
                ? item.target.filename ?? item.title
                : undefined,
            previewPath:
              item.target.kind === "file" ? item.target.path : undefined,
            previewUrl:
              item.target.kind === "url" ? item.target.url : undefined,
          },
        })
      : null;

  if (!item.src) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Alert className="max-w-sm">
          <AlertTitle>Preview unavailable</AlertTitle>
          <AlertDescription>
            This preview provider could not access the current item.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!isSupportedPluginWebviewEntrypoint(webviewEntrypoint)) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Alert className="max-w-sm">
          <AlertTitle>Unsupported preview renderer</AlertTitle>
          <AlertDescription>
            Preview providers currently support plugin webviews only.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-border/70 px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-foreground">
            {renderer?.title ?? "Custom preview"}
          </p>
          <p className="truncate text-xs text-muted-foreground">{item.title}</p>
        </div>
        <Button
          disabled={!item.src}
          onClick={() => {
            if (!item.src) {
              return;
            }
            window.open(item.src, "_blank", "noopener,noreferrer");
          }}
          type="button"
          variant="outline"
          size="sm"
        >
          <ExternalLink className="size-4" />
          Open Source
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden bg-background">
        {webviewError ? (
          <div className="flex h-full items-center justify-center p-6">
            <Alert className="max-w-sm">
              <AlertTitle>Renderer failed to load</AlertTitle>
              <AlertDescription>{webviewError}</AlertDescription>
            </Alert>
          </div>
        ) : contextualWebviewSrc ? (
          <iframe
            title={`${item.title} custom preview`}
            src={contextualWebviewSrc}
            className="min-h-0 h-full w-full bg-white"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="flex h-full items-center justify-center bg-muted/10">
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              <span>Loading preview renderer…</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

type WorkbenchDropTarget = {
  paneId: string;
  index: number;
  placement: DesktopPaneDropPlacement;
};

function WorkbenchTabStrip({
  activeTabId,
  draggingTabId,
  dropTarget,
  onCycleTabs,
  onCloseTab,
  onCreateTab,
  onDropTarget,
  onSelectTab,
  onSetDropTarget,
  onTabDragEnd,
  onTabDragStart,
  paneId,
  threadRuntimeById,
  tabs,
}: {
  activeTabId: string | null;
  draggingTabId: string | null;
  dropTarget: WorkbenchDropTarget | null;
  onCycleTabs: (offset: -1 | 1) => void;
  onCloseTab: (tabId: string) => void;
  onCreateTab: () => void;
  onDropTarget: (target: WorkbenchDropTarget) => void;
  onSelectTab: (tabId: string) => void;
  onSetDropTarget: (target: WorkbenchDropTarget | null) => void;
  onTabDragEnd: () => void;
  onTabDragStart: (tabId: string, event: DragEvent<HTMLElement>) => void;
  paneId: string;
  threadRuntimeById: DesktopSnapshot["threadRuntimeById"];
  tabs: DesktopTab[];
}) {
  const renderDropTarget = (index: number) => {
    const target: WorkbenchDropTarget = {
      paneId,
      index,
      placement: "center",
    };
    const isActive =
      dropTarget?.paneId === paneId &&
      dropTarget.placement === "center" &&
      dropTarget.index === index;

    return (
      <div
        key={`drop:${paneId}:${index}`}
        data-pane-drop-target={paneId}
        data-pane-drop-index={index}
        className={cn("desktop-workbench-tab-drop-target", isActive && "is-active")}
        onDragOver={(event) => {
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "move";
          onSetDropTarget(target);
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onDropTarget(target);
        }}
      />
    );
  };

  return (
    <div className="desktop-workbench-tabstrip">
      <div
        role="tablist"
        aria-label="Open workbench tabs"
        className="desktop-workbench-tablist desktop-no-drag"
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            onSetDropTarget(null);
          }
        }}
      >
        {renderDropTarget(0)}
        {tabs.map((tab, index) => {
          const TabIcon = getDesktopIcon(tab.icon);
          const isActive = tab.id === activeTabId;
          const runtime = tab.threadId ? threadRuntimeById[tab.threadId] : null;
          const closeLabel =
            tab.kind === "thread"
              ? `Close ${tab.title} chat tab`
              : `Close ${tab.title} tab`;

          return (
            <Fragment key={tab.id}>
              <div
                draggable
                className={cn(
                  "desktop-workbench-tab group/tab",
                  isActive && "is-active",
                  draggingTabId === tab.id && "is-dragging",
                )}
                onDragStart={(event) => onTabDragStart(tab.id, event)}
                onDragEnd={onTabDragEnd}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  data-tab-id={tab.id}
                  tabIndex={isActive ? 0 : -1}
                  className="desktop-workbench-tab-button"
                  onClick={() => onSelectTab(tab.id)}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowRight") {
                      event.preventDefault();
                      onCycleTabs(1);
                      return;
                    }
                    if (event.key === "ArrowLeft") {
                      event.preventDefault();
                      onCycleTabs(-1);
                      return;
                    }
                    if (event.key === "Home") {
                      event.preventDefault();
                      const firstTabId = tabs[0]?.id ?? tab.id;
                      onSelectTab(firstTabId);
                      focusWorkbenchTab(firstTabId);
                      return;
                    }
                    if (event.key === "End") {
                      event.preventDefault();
                      const lastTabId = tabs[tabs.length - 1]?.id ?? tab.id;
                      onSelectTab(lastTabId);
                      focusWorkbenchTab(lastTabId);
                    }
                  }}
                >
                  <TabIcon className="desktop-workbench-tab-icon" />
                  <span className="desktop-workbench-tab-copy">
                    <ThreadRuntimeIndicator runtime={runtime} className="desktop-workbench-tab-runtime" />
                    <span className="desktop-workbench-tab-title">{tab.title}</span>
                    {tab.subtitle ? (
                      <span className="desktop-workbench-tab-subtitle">
                        {tab.subtitle}
                      </span>
                    ) : null}
                  </span>
                </button>
                {tab.closable ? (
                  <button
                    type="button"
                    aria-label={closeLabel}
                    className="desktop-workbench-tab-close"
                    onClick={(event) => {
                      event.stopPropagation();
                      onCloseTab(tab.id);
                    }}
                  >
                    <X className="size-3" />
                  </button>
                ) : null}
              </div>
              {renderDropTarget(index + 1)}
            </Fragment>
          );
        })}
      </div>
      <button
        type="button"
        aria-label="New tab"
        className="desktop-workbench-new-tab desktop-no-drag"
        onClick={onCreateTab}
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  );
}

function EmptyWorkbenchPane({
  activeThreadId,
  onFocusPane,
  onOpenWorkspaceFile,
  paneId,
}: {
  activeThreadId: string | null;
  onFocusPane: (paneId: string) => void;
  onOpenWorkspaceFile: (paneId: string, entry: DesktopWorkspaceEntry) => void;
  paneId: string;
}) {
  const [listingsByPath, setListingsByPath] = useState<Record<string, DesktopWorkspaceListing>>({});
  const [expandedPaths, setExpandedPaths] = useState<Record<string, boolean>>({ "/": true });
  const [loadingPaths, setLoadingPaths] = useState<Record<string, boolean>>({});
  const [errorByPath, setErrorByPath] = useState<Record<string, string>>({});

  const loadDirectory = useCallback(async (path: string) => {
    if (!desktopShell?.listWorkspaceEntries) {
      setErrorByPath((current) => ({
        ...current,
        [path]: "Workspace browsing is unavailable in this build.",
      }));
      return;
    }

    setLoadingPaths((current) => ({ ...current, [path]: true }));
    setErrorByPath((current) => {
      if (!(path in current)) {
        return current;
      }
      const next = { ...current };
      delete next[path];
      return next;
    });

    try {
      const listing = await desktopShell.listWorkspaceEntries(path === "/" ? null : path);
      setListingsByPath((current) => ({
        ...current,
        [listing.path]: listing,
      }));
    } catch (error) {
      setErrorByPath((current) => ({
        ...current,
        [path]:
          error instanceof Error
            ? error.message
            : "Workspace files could not be loaded.",
      }));
    } finally {
      setLoadingPaths((current) => ({
        ...current,
        [path]: false,
      }));
    }
  }, []);

  useEffect(() => {
    void loadDirectory("/");
  }, [loadDirectory]);

  const toggleDirectory = useCallback((path: string) => {
    setExpandedPaths((current) => ({
      ...current,
      [path]: !current[path],
    }));

    if (!listingsByPath[path] && !loadingPaths[path]) {
      void loadDirectory(path);
    }
  }, [listingsByPath, loadDirectory, loadingPaths]);

  const handleOpenEntry = useCallback((entry: DesktopWorkspaceEntry) => {
    onFocusPane(paneId);
    if (!activeThreadId) {
      toast.error("Open a chat tab before opening workspace previews.");
      return;
    }
    onOpenWorkspaceFile(paneId, entry);
  }, [activeThreadId, onFocusPane, onOpenWorkspaceFile, paneId]);

  const renderEntries = useCallback((path: string, depth: number): ReactNode => {
    const listing = listingsByPath[path];
    if (!listing) {
      if (loadingPaths[path]) {
        return (
          <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <span>Loading files…</span>
          </div>
        );
      }
      if (errorByPath[path]) {
        return (
          <div className="px-3 py-2 text-sm text-destructive">
            {errorByPath[path]}
          </div>
        );
      }
      return null;
    }

    if (listing.entries.length === 0) {
      return (
        <div className="px-3 py-2 text-sm text-muted-foreground">
          This directory is empty.
        </div>
      );
    }

    return listing.entries.map((entry) => {
      const isDirectory = entry.type === "directory";
      const isExpanded = expandedPaths[entry.path] === true;
      const EntryIcon = isDirectory ? (isExpanded ? FolderOpen : Folder) : File;

      return (
        <Fragment key={entry.path}>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-muted/60"
            style={{ paddingLeft: `${depth * 14 + 12}px` }}
            onClick={() => {
              if (isDirectory) {
                toggleDirectory(entry.path);
                return;
              }
              handleOpenEntry(entry);
            }}
          >
            {isDirectory ? (
              isExpanded ? (
                <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              )
            ) : (
              <span className="size-4 shrink-0" />
            )}
            <EntryIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate">{entry.name}</span>
          </button>
          {isDirectory && isExpanded ? renderEntries(entry.path, depth + 1) : null}
        </Fragment>
      );
    });
  }, [errorByPath, expandedPaths, handleOpenEntry, listingsByPath, loadingPaths, toggleDirectory]);

  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-foreground">Workspace files</h2>
          <p className="text-sm text-muted-foreground">
            Click a file to open it in a preview tab.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void loadDirectory("/")}
        >
          Refresh
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border/70 bg-muted/20 py-2">
        {renderEntries("/", 0)}
      </div>
    </div>
  );
}

function PreviewWorkbenchTabPane({
  item,
  threadId,
}: {
  item: NonNullable<DesktopTab["previewItem"]>;
  threadId: string;
}) {
  const handleDownload = useCallback(async () => {
    if (item.target.kind !== "file" || !desktopShell?.downloadFile) {
      return;
    }

    try {
      const result = await desktopShell.downloadFile({
        source: item.target.source,
        path: item.target.path,
        filename: item.target.filename ?? item.title,
      });
      if (!result.canceled) {
        toast.success("File saved.");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [item]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {item.renderer ? (
        <PreviewProviderPane item={item} threadId={threadId} />
      ) : item.target.kind === "file" ? (
        item.src ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex items-center justify-between gap-3 border-b border-border/70 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-foreground">
                  {item.title}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {item.target.path}
                </p>
              </div>
              {desktopShell?.downloadFile ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void handleDownload();
                  }}
                >
                  <Download className="size-4" />
                  Save As
                </Button>
              ) : null}
            </div>
            <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
              <FilePreviewContent
                filename={item.title}
                previewUrl={item.src}
                contentType={item.contentType ?? undefined}
                layout="panel"
              />
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center p-6">
            <Alert className="max-w-sm">
              <AlertTitle>Preview unavailable</AlertTitle>
              <AlertDescription>
                This file could not be read from the current desktop runtime.
              </AlertDescription>
            </Alert>
          </div>
        )
      ) : item.src ? (
        (() => {
          const targetUrl = item.target.kind === "url" ? item.target.url : item.title;
          return (
            <div className="flex h-full flex-col">
              <div className="flex items-center justify-between gap-3 border-b border-border/70 px-3 py-2">
                <p className="truncate text-xs text-muted-foreground">
                  {targetUrl}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    window.open(targetUrl, "_blank", "noopener,noreferrer");
                  }}
                >
                  <ExternalLink className="size-4" />
                  Open
                </Button>
              </div>
              <iframe
                title={item.title}
                src={item.src}
                className="min-h-0 w-full flex-1 bg-white"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                referrerPolicy="no-referrer"
              />
            </div>
          );
        })()
      ) : (
        <div className="flex h-full items-center justify-center p-6">
          <Alert className="max-w-sm">
            <AlertTitle>Preview unavailable</AlertTitle>
            <AlertDescription>
              This URL preview could not be opened.
            </AlertDescription>
          </Alert>
        </div>
      )}
    </div>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState<DesktopSnapshot | null>(null);
  const [uiMessagesByThread, setUiMessagesByThread] = useState<
    Record<string, Message[]>
  >({});
  const [activePaneId, setActivePaneId] = useState<string | null>(null);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<
    "connecting" | "open" | "closed"
  >("connecting");
  const [showSettings, setShowSettings] = useState(false);
  const [groupEditor, setGroupEditor] = useState<GroupEditorState>({
    mode: "create",
    open: false,
    title: "",
  });
  const [groupDeleteState, setGroupDeleteState] = useState<GroupDeleteState | null>(null);
  const composerDraftsRef = useRef<Record<string, string>>({});
  const fallbackSocketRef = useRef<WebSocket | null>(null);
  const streamingMessageIdsRef = useRef<Record<string, string | null>>({});
  const reportedReadyRef = useRef(false);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<WorkbenchDropTarget | null>(null);

  const activeThread = useMemo(
    () => getActiveThread(snapshot, activeThreadId),
    [snapshot, activeThreadId],
  );
  const groupBeingEdited = useMemo(() => {
    if (!snapshot || groupEditor.mode !== "rename") {
      return null;
    }

    return snapshot.threadGroups.find((group) => group.id === groupEditor.groupId) ?? null;
  }, [groupEditor, snapshot]);
  const groupBeingDeleted = useMemo(() => {
    if (!snapshot || !groupDeleteState) {
      return null;
    }

    return snapshot.threadGroups.find((group) => group.id === groupDeleteState.groupId) ?? null;
  }, [groupDeleteState, snapshot]);
  const deletedGroupThreadCount = useMemo(() => {
    if (!groupBeingDeleted || !snapshot) {
      return 0;
    }

    return snapshot.threads.filter((thread) => thread.groupId === groupBeingDeleted.id).length;
  }, [groupBeingDeleted, snapshot]);
  const rawMessages = useMemo(() => {
    if (!activeThreadId) return [];
    return uiMessagesByThread[activeThreadId] ?? [];
  }, [activeThreadId, uiMessagesByThread]);
  useEffect(() => {
    let cancelled = false;

    async function loadSnapshot() {
      try {
        const next = desktopShell?.getSnapshot
          ? await desktopShell.getSnapshot()
          : await fetch(`${fallbackBackendUrl}/api/snapshot`).then(
              (response) => response.json() as Promise<DesktopSnapshot>,
            );
        if (!next || cancelled) return;
        setSnapshot(next);
        setUiMessagesByThread((current) => {
          const merged = { ...current };
          for (const [threadId, threadMessages] of Object.entries(
            next.messagesByThread,
          )) {
            merged[threadId] = mergeSnapshotMessages(
              current[threadId],
              threadMessages,
              threadId,
              streamingMessageIdsRef.current,
            );
          }
          return merged;
        });
        setActivePaneId(next.activePaneId ?? deriveDesktopPanes(next)[0]?.id ?? null);
        setActiveTabId(next.activeTabId);
        setActiveThreadId(next.activeThreadId ?? next.threads[0]?.id ?? null);
        setActiveViewId(
          next.activeViewId !== undefined
            ? next.activeViewId
            : next.views.find((view) => view.isDefault)?.id ??
                next.views[0]?.id ??
                null,
        );
        setDraggingTabId(null);
        setDropTarget(null);
      } catch {
        setConnectionState("closed");
      }
    }

    void loadSnapshot();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handleEvent = (event: DesktopServerEvent) => {
      if (event.type === "snapshot") {
        setSnapshot(event.snapshot);
        setUiMessagesByThread((current) => {
          const merged = { ...current };
          for (const [threadId, threadMessages] of Object.entries(
            event.snapshot.messagesByThread,
          )) {
            merged[threadId] = mergeSnapshotMessages(
              current[threadId],
              threadMessages,
              threadId,
              streamingMessageIdsRef.current,
            );
          }
          return merged;
        });
        setActivePaneId(
          event.snapshot.activePaneId ?? deriveDesktopPanes(event.snapshot)[0]?.id ?? null,
        );
        setActiveTabId(event.snapshot.activeTabId);
        setActiveThreadId(
          event.snapshot.activeThreadId ??
            event.snapshot.threads[0]?.id ??
            null,
        );
        setActiveViewId(
          event.snapshot.activeViewId !== undefined
            ? event.snapshot.activeViewId
            : event.snapshot.views.find((view) => view.isDefault)?.id ??
                event.snapshot.views[0]?.id ??
                null,
        );
        setConnectionState("open");
        return;
      }

      if (event.type === "assistant_delta") {
        setUiMessagesByThread((current) => {
          const threadMessages = current[event.threadId] ?? [];
          return {
            ...current,
            [event.threadId]: threadMessages.map((message) =>
              message.id === event.messageId
                ? {
                    ...message,
                    content: appendAssistantDeltaContent(
                      message.content,
                      event.delta,
                    ),
                    isStreaming: true,
                  }
                : message,
            ),
          };
        });
        return;
      }

      if (event.type === "runtime_event") {
        setUiMessagesByThread((current) => {
          const threadMessages = current[event.threadId] ?? [];
          return {
            ...current,
            [event.threadId]: applyRuntimeEventToMessages(
              threadMessages,
              event.threadId,
              event.provider,
              event.event,
              streamingMessageIdsRef.current,
            ),
          };
        });
      }
    };

    if (desktopShell?.onEvent) {
      setConnectionState("connecting");
      const unsubscribe = desktopShell.onEvent(handleEvent);
      return () => {
        unsubscribe();
      };
    }

    const url = `${fallbackBackendUrl.replace("http://", "ws://").replace("https://", "wss://")}/ws`;
    const socket = new WebSocket(url);
    fallbackSocketRef.current = socket;

    socket.addEventListener("open", () => {
      setConnectionState("open");
    });

    socket.addEventListener("close", () => {
      setConnectionState("closed");
    });

    socket.addEventListener("message", (raw) => {
      handleEvent(JSON.parse(raw.data) as DesktopServerEvent);
    });

    return () => {
      socket.close();
    };
  }, []);

  useEffect(() => {
    if (!snapshot || reportedReadyRef.current || !desktopShell?.reportReady) {
      return;
    }
    reportedReadyRef.current = true;
    desktopShell.reportReady({
      activeThreadId: snapshot.activeThreadId,
      provider: snapshot.provider,
      authSource: snapshot.auth.source,
      hasAuth: snapshot.auth.available,
      runtimeState: snapshot.runtimeStatus.state,
    });
  }, [snapshot]);

  const sendEvent = useCallback((event: DesktopClientEvent) => {
    if (desktopShell?.sendEvent) {
      desktopShell.sendEvent(event);
      return;
    }

    const socket = fallbackSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(event));
  }, []);

  const handleCreateThreadInPane = useCallback((paneId: string, groupId?: string) => {
    const defaultThreadViewId =
      snapshot?.views.find((view) => view.scope === "thread" && view.isDefault)?.id ??
      snapshot?.views.find((view) => view.scope === "thread")?.id ??
      null;
    setShowSettings(false);
    setActiveTabId(null);
    setActivePaneId(paneId);
    if (defaultThreadViewId) {
      setActiveViewId(defaultThreadViewId);
    }
    if (activePaneId !== paneId) {
      sendEvent({ type: "focus_pane", paneId });
    }
    sendEvent({
      type: "create_thread",
      groupId,
    });
  }, [activePaneId, sendEvent, snapshot?.views]);

  const handleCreateThread = useCallback((groupId?: string) => {
    handleCreateThreadInPane(activePaneId ?? "primary", groupId);
  }, [activePaneId, handleCreateThreadInPane]);

  const handleCreateGroup = useCallback((title?: string) => {
    sendEvent({ type: "create_group", title });
  }, [sendEvent]);

  const handleRequestCreateGroup = useCallback(() => {
    setGroupEditor({
      mode: "create",
      open: true,
      title: "",
    });
  }, []);

  const handleSelectGroup = useCallback((groupId: string) => {
    sendEvent({
      type: "select_group",
      groupId,
    });
  }, [sendEvent]);

  const handleRenameGroup = useCallback((groupId: string, title: string) => {
    sendEvent({
      type: "update_group",
      groupId,
      title,
    });
  }, [sendEvent]);

  const handleRequestRenameGroup = useCallback((groupId: string) => {
    const group = snapshot?.threadGroups.find((entry) => entry.id === groupId);
    if (!group) {
      return;
    }

    setGroupEditor({
      mode: "rename",
      open: true,
      groupId: group.id,
      title: group.title,
    });
  }, [snapshot?.threadGroups]);

  const handleRequestDeleteGroup = useCallback((groupId: string) => {
    setGroupDeleteState({ open: true, groupId });
  }, []);

  const handleSelectThread = useCallback((threadId: string) => {
    const defaultThreadViewId =
      snapshot?.views.find((view) => view.scope === "thread" && view.isDefault)?.id ??
      snapshot?.views.find((view) => view.scope === "thread")?.id ??
      null;
    const existingTab =
      snapshot?.tabs.find(
        (tab) =>
          tab.kind === "thread" &&
          tab.threadId === threadId &&
          tab.viewId === defaultThreadViewId,
      ) ??
      snapshot?.tabs.find(
        (tab) => tab.kind === "thread" && tab.threadId === threadId,
      ) ??
      null;
    setShowSettings(false);
    setActiveThreadId(threadId);
    setActivePaneId(existingTab?.paneId ?? activePaneId ?? "primary");
    if (defaultThreadViewId) {
      setActiveViewId(defaultThreadViewId);
    }
    setActiveTabId(existingTab?.id ?? null);
    sendEvent({ type: "select_thread", threadId });
  }, [activePaneId, sendEvent, snapshot?.tabs, snapshot?.views]);

  const handleSelectView = useCallback((viewId: string) => {
    const existingTab =
      snapshot?.tabs.find(
        (tab) => tab.kind === "workspace" && tab.viewId === viewId,
      ) ?? null;
    setShowSettings(false);
    setActivePaneId(existingTab?.paneId ?? activePaneId ?? "primary");
    setActiveViewId(viewId);
    setActiveTabId(existingTab?.id ?? null);
    sendEvent({ type: "select_view", viewId });
  }, [activePaneId, sendEvent, snapshot?.tabs]);

  const handleSelectTab = useCallback((tabId: string) => {
    const tab = snapshot?.tabs.find((entry) => entry.id === tabId) ?? null;
    if (!tab) {
      return;
    }

    setShowSettings(false);
    setActivePaneId(tab.paneId ?? "primary");
    setActiveTabId(tab.id);
    setActiveViewId(tab.viewId);
    if (tab.threadId) {
      setActiveThreadId(tab.threadId);
    }
    sendEvent({ type: "select_tab", tabId });
  }, [sendEvent, snapshot?.tabs]);

  const handleFocusPane = useCallback((paneId: string) => {
    setActivePaneId(paneId);
    sendEvent({ type: "focus_pane", paneId });
  }, [sendEvent]);

  const handleCloseTab = useCallback((tabId: string) => {
    const tabs = snapshot?.tabs ?? [];
    const index = tabs.findIndex((tab) => tab.id === tabId);
    if (index === -1) {
      return;
    }

    const nextTabs = tabs.filter((tab) => tab.id !== tabId);
    if (activeTabId === tabId) {
      const fallback = nextTabs[index] ?? nextTabs[index - 1] ?? nextTabs[0] ?? null;
      setActivePaneId(fallback?.paneId ?? activePaneId ?? "primary");
      setActiveTabId(fallback?.id ?? null);
      setActiveViewId(fallback?.viewId ?? null);
      if (fallback?.threadId) {
        setActiveThreadId(fallback.threadId);
      }
      if (fallback?.id) {
        focusWorkbenchTab(fallback.id);
      }
    }
    sendEvent({ type: "close_tab", tabId });
  }, [activePaneId, activeTabId, sendEvent, snapshot?.tabs]);

  const handleTabDragStart = useCallback((tabId: string, event: DragEvent<HTMLElement>) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(DESKTOP_TAB_MIME_TYPE, tabId);
    setDraggingTabId(tabId);
    setDropTarget(null);
  }, []);

  const handleTabDragEnd = useCallback(() => {
    setDraggingTabId(null);
    setDropTarget(null);
  }, []);

  const handleDropTarget = useCallback((target: WorkbenchDropTarget) => {
    const tabId = draggingTabId;
    if (!tabId) {
      return;
    }

    sendEvent({
      type: "move_tab",
      tabId,
      targetPaneId: target.paneId,
      targetIndex: target.index,
      placement: target.placement,
    });
    setDraggingTabId(null);
    setDropTarget(null);
  }, [draggingTabId, sendEvent]);

  const handleCycleTabs = useCallback((offset: -1 | 1) => {
    const tabs = snapshot?.tabs ?? [];
    if (tabs.length < 2) {
      return;
    }

    const currentIndex = tabs.findIndex((tab) => tab.id === activeTabId);
    const baseIndex = currentIndex === -1 ? 0 : currentIndex;
    const nextIndex = (baseIndex + offset + tabs.length) % tabs.length;
    const nextTab = tabs[nextIndex];
    if (!nextTab) {
      return;
    }

    setShowSettings(false);
    handleSelectTab(nextTab.id);
    focusWorkbenchTab(nextTab.id);
  }, [activeTabId, handleSelectTab, snapshot?.tabs]);

  const handleOpenSettings = useCallback(() => {
    setShowSettings(true);
  }, []);

  const handleSetModel = useCallback((model: string) => {
    if (!snapshot?.availableModels.some((option) => option.id === model)) {
      return;
    }
    sendEvent({ type: "set_model", model: model as DesktopModel });
  }, [sendEvent, snapshot?.availableModels]);

  const handleSetModelSource = useCallback((modelSource: string) => {
    if (!snapshot?.availableModelSources.some((option) => option.id === modelSource)) {
      return;
    }
    sendEvent({ type: "set_model_source", modelSource });
  }, [sendEvent, snapshot?.availableModelSources]);

  const handleSetProvider = useCallback((provider: DesktopProvider) => {
    if (!snapshot?.availableProviders.some((option) => option.id === provider)) {
      return;
    }
    sendEvent({ type: "set_provider", provider });
  }, [sendEvent, snapshot?.availableProviders]);

  const handleDraftChange = useCallback((threadId: string | null, draft: string) => {
    composerDraftsRef.current[getDraftKey(threadId)] = draft;
  }, []);

  const handleSubmitMessage = useCallback((threadId: string, content: string) => {
    composerDraftsRef.current[getDraftKey(threadId)] = "";
    sendEvent({
      type: "send_message",
      threadId,
      content,
    });
  }, [sendEvent]);

  const handleStopThread = useCallback((threadId: string) => {
    sendEvent({
      type: "stop_thread",
      threadId,
    });
  }, [sendEvent]);

  const handleOpenPreviewTarget = useCallback((target: PreviewTarget) => {
    if (!activeThreadId) {
      return;
    }

    sendEvent({
      type: "preview_open_item",
      threadId: activeThreadId,
      item: toDesktopPreviewTarget(target),
    });
  }, [activeThreadId, sendEvent]);

  const handleOpenPreviewTargetInPane = useCallback((paneId: string, target: PreviewTarget) => {
    if (!activeThreadId) {
      return;
    }

    setShowSettings(false);
    if (activePaneId !== paneId) {
      setActivePaneId(paneId);
      sendEvent({ type: "focus_pane", paneId });
    }
    sendEvent({
      type: "preview_open_item",
      threadId: activeThreadId,
      item: toDesktopPreviewTarget(target),
    });
  }, [activePaneId, activeThreadId, sendEvent]);

  const handleSetPreviewTargets = useCallback((
    targets: PreviewTarget[],
    options?: { activeTarget?: PreviewTarget | null },
  ) => {
    if (!activeThreadId) {
      return;
    }

    const items = targets.map((target) => toDesktopPreviewTarget(target));
    const activeItemId = options?.activeTarget
      ? getDesktopPreviewItemId(toDesktopPreviewTarget(options.activeTarget))
      : null;

    sendEvent({
      type: "preview_set_items",
      threadId: activeThreadId,
      items,
      activeItemId,
    });
  }, [activeThreadId, sendEvent]);

  const handleClearPreviewTargets = useCallback(() => {
    if (!activeThreadId) {
      return;
    }

    sendEvent({
      type: "preview_clear",
      threadId: activeThreadId,
    });
  }, [activeThreadId, sendEvent]);

  useEffect(() => {
    if (!desktopShell?.onCommand) {
      return;
    }

    return desktopShell.onCommand((command: DesktopShellCommand) => {
      switch (command) {
        case "new_chat":
          handleCreateThread();
          return;
        case "open_settings":
          handleOpenSettings();
          return;
        case "toggle_sidebar":
          window.dispatchEvent(new Event("desktop:toggle-sidebar"));
          return;
        case "close_tab":
          if (activeTabId) {
            handleCloseTab(activeTabId);
          }
          return;
        case "next_tab":
          handleCycleTabs(1);
          return;
        case "previous_tab":
          handleCycleTabs(-1);
          return;
      }
    });
  }, [
    activeTabId,
    handleCloseTab,
    handleCreateThread,
    handleCycleTabs,
    handleOpenSettings,
  ]);

  useEffect(() => {
    const handleWindowKeyDown = (event: KeyboardEvent) => {
      const hasNativeCommandShortcuts = Boolean(desktopShell?.onCommand);

      if (event.defaultPrevented || event.isComposing) {
        return;
      }

      if (!(event.metaKey || event.ctrlKey) || event.altKey) {
        return;
      }

      if (event.key === "w") {
        if (hasNativeCommandShortcuts) {
          return;
        }
        if (!activeTabId) {
          return;
        }
        event.preventDefault();
        handleCloseTab(activeTabId);
        return;
      }

      if (event.ctrlKey && event.key === "Tab") {
        event.preventDefault();
        handleCycleTabs(event.shiftKey ? -1 : 1);
        return;
      }

      if (event.shiftKey && (event.key === "]" || event.key === "[")) {
        if (hasNativeCommandShortcuts) {
          return;
        }
        event.preventDefault();
        handleCycleTabs(event.key === "]" ? 1 : -1);
        return;
      }

      if (event.key === "PageDown" || event.key === "PageUp") {
        event.preventDefault();
        handleCycleTabs(event.key === "PageDown" ? 1 : -1);
        return;
      }

      if (event.shiftKey) {
        return;
      }

      if (/^[1-9]$/.test(event.key)) {
        const nextTab = snapshot?.tabs[Number(event.key) - 1];
        if (!nextTab) {
          return;
        }
        event.preventDefault();
        handleSelectTab(nextTab.id);
        focusWorkbenchTab(nextTab.id);
      }
    };

    window.addEventListener("keydown", handleWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", handleWindowKeyDown);
    };
  }, [activeTabId, handleCloseTab, handleCycleTabs, handleSelectTab, snapshot?.tabs]);

  const paneModels = useMemo(() => {
    const panes = deriveDesktopPanes(snapshot).map((pane) => ({
      ...pane,
      tabs: pane.tabs.map((tab) => ({
        ...tab,
        paneId: tab.paneId ?? pane.id,
      })),
    }));
    if (panes.length === 0) {
      return [];
    }

    const resolvedActivePaneId =
      activePaneId ?? snapshot?.activePaneId ?? panes[0]?.id ?? null;

    return panes.map((pane) => {
      const activeId =
        pane.id === resolvedActivePaneId &&
        activeTabId &&
        pane.tabs.some((tab) => tab.id === activeTabId)
          ? activeTabId
          : pane.activeTabId && pane.tabs.some((tab) => tab.id === pane.activeTabId)
            ? pane.activeTabId
            : pane.tabs[0]?.id ?? null;
      return {
        ...pane,
        activeTabId: activeId,
      };
    });
  }, [activePaneId, activeTabId, snapshot]);
  const paneLayout = useMemo(
    () => deriveDesktopPaneLayout(snapshot),
    [snapshot],
  );
  const paneById = useMemo(
    () => new Map(paneModels.map((pane) => [pane.id, pane])),
    [paneModels],
  );

  const handleCycleTabsInPane = useCallback((paneId: string, offset: -1 | 1) => {
    const pane = paneModels.find((entry) => entry.id === paneId) ?? null;
    const tabs = pane?.tabs ?? [];
    if (!pane || tabs.length < 2) {
      return;
    }

    const currentIndex = tabs.findIndex((tab) => tab.id === pane.activeTabId);
    const baseIndex = currentIndex === -1 ? 0 : currentIndex;
    const nextIndex = (baseIndex + offset + tabs.length) % tabs.length;
    const nextTab = tabs[nextIndex];
    if (!nextTab) {
      return;
    }

    handleSelectTab(nextTab.id);
    focusWorkbenchTab(nextTab.id);
  }, [handleSelectTab, paneModels]);

  const buildSurfacePropsForTab = useCallback((tab: DesktopTab) => {
    if (!snapshot || tab.kind === "preview" || !tab.viewId) {
      return null;
    }

    const surface = getView(snapshot, tab.viewId);
    if (!surface) {
      return null;
    }

    const tabThreadId = tab.kind === "thread" ? tab.threadId : activeThreadId;
    const tabRawMessages = tab.kind === "thread" && tab.threadId
      ? uiMessagesByThread[tab.threadId] ?? []
      : rawMessages;
    const tabInitialDraft = composerDraftsRef.current[getDraftKey(tabThreadId)] ?? "";
    const tabIsStreaming = tabRawMessages.some(
      (message) => message.role === "assistant" && message.isStreaming,
    );

    return {
      snapshot,
      surface,
      activeThreadId: tabThreadId,
      rawMessages: tabRawMessages,
      initialDraft: tabInitialDraft,
      isStreaming: tabIsStreaming,
      onDraftChange: handleDraftChange,
      onSetProvider: handleSetProvider,
      onSetModel: handleSetModel,
      onSetModelSource: handleSetModelSource,
      onStopThread: handleStopThread,
      onSubmitMessage: handleSubmitMessage,
      onRequestCreateGroup: handleRequestCreateGroup,
      onRequestDeleteGroup: handleRequestDeleteGroup,
      onRequestRenameGroup: handleRequestRenameGroup,
      onSendEvent: sendEvent,
      onOpenPreviewTarget: handleOpenPreviewTarget,
      onSetPreviewTargets: handleSetPreviewTargets,
      onClearPreviewTargets: handleClearPreviewTargets,
    };
  }, [
    activeThreadId,
    handleClearPreviewTargets,
    handleDraftChange,
    handleOpenPreviewTarget,
    handleRequestCreateGroup,
    handleRequestDeleteGroup,
    handleRequestRenameGroup,
    handleSetModel,
    handleSetModelSource,
    handleSetPreviewTargets,
    handleSetProvider,
    handleStopThread,
    handleSubmitMessage,
    rawMessages,
    sendEvent,
    snapshot,
    uiMessagesByThread,
  ]);

  const renderWorkbenchPane = useCallback((pane: DesktopPane) => {
    const activeTab =
      pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? pane.tabs[0] ?? null;
    const surfaceProps = activeTab ? buildSurfacePropsForTab(activeTab) : null;
    const paneContent = !activeTab ? (
      <EmptyWorkbenchPane
        activeThreadId={activeThreadId}
        onFocusPane={handleFocusPane}
        onOpenWorkspaceFile={(paneId, entry) => {
          handleOpenPreviewTargetInPane(paneId, {
            kind: "file",
            source: "workspace",
            workspaceId: DESKTOP_WORKSPACE_ID,
            path: entry.path,
            filename: entry.name,
          });
        }}
        paneId={pane.id}
      />
    ) : activeTab.kind === "preview" && activeTab.previewItem && activeTab.threadId ? (
      <PreviewWorkbenchTabPane item={activeTab.previewItem} threadId={activeTab.threadId} />
    ) : surfaceProps ? (
      <WorkbenchSurfacePane {...surfaceProps} />
    ) : (
      <div className="flex flex-1 items-center justify-center p-6">
        <Alert className="max-w-xl">
          <AlertTitle>Unavailable tab</AlertTitle>
          <AlertDescription>
            This workbench tab could not be resolved from the current desktop snapshot.
          </AlertDescription>
        </Alert>
      </div>
    );
    const paneDropTargetActive =
      draggingTabId !== null &&
      dropTarget?.paneId === pane.id &&
      (dropTarget.placement !== "center" || pane.tabs.length === 0);
    const paneBodyDropTargets: DesktopPaneDropPlacement[] = [
      "center",
      "left",
      "right",
      "top",
      "bottom",
    ];

    return (
      <div
        key={pane.id}
        data-pane-id={pane.id}
        className="desktop-workbench-pane"
        onMouseDownCapture={() => {
          if (activePaneId !== pane.id) {
            handleFocusPane(pane.id);
          }
        }}
      >
        <WorkbenchTabStrip
          activeTabId={pane.activeTabId}
          draggingTabId={draggingTabId}
          dropTarget={dropTarget}
          onCycleTabs={(offset) => handleCycleTabsInPane(pane.id, offset)}
          onCloseTab={handleCloseTab}
          onCreateTab={() => handleCreateThreadInPane(pane.id)}
          onDropTarget={handleDropTarget}
          onSelectTab={handleSelectTab}
          onSetDropTarget={setDropTarget}
          onTabDragEnd={handleTabDragEnd}
          onTabDragStart={handleTabDragStart}
          paneId={pane.id}
          threadRuntimeById={snapshot?.threadRuntimeById ?? {}}
          tabs={pane.tabs}
        />
        <div
          className="desktop-workbench-pane-body"
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setDropTarget(null);
            }
          }}
        >
          {paneContent}
          {draggingTabId ? (
            <div className="desktop-pane-drop-zones">
              {paneBodyDropTargets.map((placement) => {
                const target: WorkbenchDropTarget = {
                  paneId: pane.id,
                  index: pane.tabs.length,
                  placement,
                };

                return (
                  <div
                    key={`${pane.id}:${placement}`}
                    data-pane-id={pane.id}
                    data-pane-zone={placement}
                    className={cn(
                      "desktop-pane-drop-zone",
                      `is-${placement}`,
                      dropTarget?.paneId === pane.id &&
                        dropTarget.placement === placement &&
                        "is-active",
                    )}
                    onDragOver={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      event.dataTransfer.dropEffect = "move";
                      setDropTarget(target);
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      handleDropTarget(target);
                    }}
                  />
                );
              })}
            </div>
          ) : null}
        </div>
        {paneDropTargetActive ? (
          <div
            className={cn(
              "desktop-pane-drop-indicator",
              `is-${dropTarget?.placement ?? "center"}`,
            )}
          />
        ) : null}
      </div>
    );
  }, [
    activeThreadId,
    activePaneId,
    buildSurfacePropsForTab,
    handleCloseTab,
    handleCycleTabsInPane,
    handleDropTarget,
    handleFocusPane,
    handleOpenPreviewTargetInPane,
    handleSelectTab,
    handleTabDragEnd,
    handleTabDragStart,
    draggingTabId,
    dropTarget,
    snapshot?.threadRuntimeById,
  ]);

  const renderPaneNode = useCallback((node: DesktopPaneNode): ReactNode => {
    if (node.kind === "pane") {
      const pane = paneById.get(node.id);
      if (!pane) {
        return null;
      }

      return renderWorkbenchPane(pane);
    }

    return (
      <Group
        key={node.id}
        orientation={node.direction}
        className="desktop-pane-group"
      >
        {node.children.flatMap((child, index) => [
          index > 0 ? (
            <Separator
              key={`${node.id}:separator:${child.id}`}
              className="desktop-pane-resize-handle"
            />
          ) : null,
          <Panel key={child.id} className="flex h-full min-h-0 min-w-0">
            {renderPaneNode(child)}
          </Panel>,
        ])}
      </Group>
    );
  }, [paneById, renderWorkbenchPane]);

  const handleSubmitGroupEditor = useCallback(() => {
    const title = groupEditor.title.trim();
    if (!title) {
      return;
    }

    if (groupEditor.mode === "create") {
      handleCreateGroup(title);
    } else {
      handleRenameGroup(groupEditor.groupId, title);
    }

    setGroupEditor((current) => ({
      ...current,
      open: false,
    }));
  }, [groupEditor, handleCreateGroup, handleRenameGroup]);

  const handleConfirmDeleteGroup = useCallback(() => {
    if (!groupDeleteState) {
      return;
    }

    sendEvent({
      type: "delete_group",
      groupId: groupDeleteState.groupId,
    });
    setGroupDeleteState(null);
  }, [groupDeleteState, sendEvent]);

  return (
    <TooltipProvider>
      <>
      <Dialog
        open={groupEditor.open}
        onOpenChange={(open) => {
          setGroupEditor((current) => ({ ...current, open }));
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {groupEditor.mode === "create" ? "Create Group" : "Rename Group"}
            </DialogTitle>
            <DialogDescription>
              {groupEditor.mode === "create"
                ? "Name the new group."
                : "Choose a new name for this group."}
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={groupEditor.title}
            onChange={(event) => {
              const title = event.target.value;
              setGroupEditor((current) => ({ ...current, title }));
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                handleSubmitGroupEditor();
              }
            }}
            placeholder="Group name"
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setGroupEditor((current) => ({ ...current, open: false }));
              }}
            >
              Cancel
            </Button>
            <Button onClick={handleSubmitGroupEditor} disabled={!groupEditor.title.trim()}>
              {groupEditor.mode === "create" ? "Create" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={groupDeleteState?.open === true}
        onOpenChange={(open) => {
          if (!open) {
            setGroupDeleteState(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Group</DialogTitle>
            <DialogDescription>
              {groupBeingDeleted
                ? `Delete "${groupBeingDeleted.title}"? ${deletedGroupThreadCount > 0 ? `Its ${deletedGroupThreadCount} chat${deletedGroupThreadCount === 1 ? "" : "s"} will be moved to ${snapshot?.threadGroups[0]?.title ?? "the default group"}.` : "This cannot be undone."}`
                : "This cannot be undone."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGroupDeleteState(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleConfirmDeleteGroup}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="desktop-shell text-foreground">
        <header className="desktop-titlebar desktop-drag">
          <div className="desktop-titlebar-inner">
            <div className="desktop-traffic-spacer" />
          </div>
          {shouldShowRuntimeNotice(snapshot) ? (
            <div className="desktop-no-drag border-t border-border/50 px-4 py-2">
              <p
                className={`line-clamp-2 text-xs leading-relaxed ${
                  snapshot?.runtimeStatus.state === "error"
                    ? "text-destructive"
                    : "text-muted-foreground"
                }`}
                title={runtimeDetail(snapshot) ?? undefined}
              >
                {runtimeDetail(snapshot)}
              </p>
            </div>
          ) : null}
        </header>

        <div className="desktop-shell-body">
          <SidebarProvider defaultOpen>
            <DesktopSidebar
              activeThreadId={activeThreadId}
              activeViewId={activeViewId}
              connectionState={connectionState}
              onRequestCreateGroup={handleRequestCreateGroup}
              onCreateThread={handleCreateThread}
              onOpenSettings={handleOpenSettings}
              onRequestDeleteGroup={handleRequestDeleteGroup}
              onRequestRenameGroup={handleRequestRenameGroup}
              onSelectGroup={handleSelectGroup}
              onSelectThread={(threadId) => { setShowSettings(false); handleSelectThread(threadId); }}
              onSelectView={(viewId) => { setShowSettings(false); handleSelectView(viewId); }}
              sidebarPanels={snapshot?.sidebarPanels ?? []}
              showSettings={showSettings}
              snapshot={snapshot}
              threads={snapshot?.threads ?? []}
              views={snapshot?.views ?? []}
            />
            <SidebarInset className="overflow-hidden flex flex-col">
              <div className="flex flex-1 min-h-0 flex-col">
                {showSettings ? (
                  <SettingsPage />
                ) : paneModels.length > 0 && paneLayout ? (
                  <div className="desktop-workbench-layout">
                    {renderPaneNode(paneLayout)}
                  </div>
                ) : (
                  <div className="flex flex-1 items-center justify-center p-6">
                    <Alert className="max-w-xl">
                      <AlertTitle>No active view</AlertTitle>
                      <AlertDescription>
                        No workbench view is available yet. Install or activate a
                        builtin extension that contributes one.
                      </AlertDescription>
                    </Alert>
                  </div>
                )}
              </div>
            </SidebarInset>
          </SidebarProvider>
        </div>
      </div>
      </>
    </TooltipProvider>
  );
}
