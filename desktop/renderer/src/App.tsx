import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { ExternalLink, Loader2, PanelRightClose, X } from "lucide-react";
import { ChatPreviewProvider } from "@/components/chat-preview/preview-context";
import { FilePreviewContent } from "@/components/chat-file-preview";
import { ContentBlockRenderer } from "@/components/message-bubble";
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
import type { ContentBlock, Message, PreviewTarget } from "@/types";
import type {
  DesktopClientEvent,
  DesktopModel,
  DesktopPreviewTarget,
  DesktopThreadPreviewState,
  DesktopProvider,
  DesktopServerEvent,
  DesktopSnapshot,
  DesktopTab,
  DesktopThread,
  DesktopView,
} from "../../shared/protocol";
import {
  applyRuntimeEventToMessages,
  mergeSnapshotMessages,
} from "../../shared/message-state";
import { getDesktopPreviewItemId } from "../../shared/preview";
import { DesktopSidebar } from "./desktop-sidebar";
import { SettingsPage } from "./settings-page";
import { getDesktopIcon } from "./desktop-icons";

const desktopShell = window.desktopShell;
const fallbackBackendUrl = "http://127.0.0.1:4315";
const EMPTY_THREAD_DRAFT_KEY = "__no_thread__";

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
  onStopThread: (threadId: string) => void;
  onSubmitMessage: (threadId: string, content: string) => void;
  onSendEvent: (event: DesktopClientEvent) => void;
  onOpenPreviewTarget: (target: PreviewTarget) => void;
  onSetPreviewTargets: (
    targets: PreviewTarget[],
    options?: { activeTarget?: PreviewTarget | null },
  ) => void;
  onClearPreviewTargets: () => void;
};

function getActiveThread(
  snapshot: DesktopSnapshot | null,
  threadId: string | null,
): DesktopThread | null {
  if (!snapshot || !threadId) return null;
  return snapshot.threads.find((thread) => thread.id === threadId) ?? null;
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

function MessageRow({ message }: { message: Message }) {
  if (message.isMeta || message.sourceToolUseID) {
    return null;
  }

  if (message.role === "user") {
    const content = coerceTextContent(message.content);
    if (!content) {
      return null;
    }

    return (
      <div className="group flex flex-col items-end gap-2 py-3">
        <div className="max-w-[85%] rounded-3xl border border-border bg-muted/30 px-4 py-3 text-foreground">
          <div className="max-w-none">
            <MarkdownRenderer content={content} variant="user" />
          </div>
        </div>
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

function Composer({
  availableProviders,
  availableModels,
  activeThreadId,
  initialDraft,
  isStreaming,
  provider,
  model,
  onDraftChange,
  onSetProvider,
  onSetModel,
  onStopThread,
  onSubmitMessage,
}: {
  availableProviders: DesktopSnapshot["availableProviders"];
  availableModels: DesktopSnapshot["availableModels"];
  activeThreadId: string | null;
  initialDraft: string;
  isStreaming: boolean;
  provider: DesktopProvider;
  model: DesktopModel;
  onDraftChange: (threadId: string | null, draft: string) => void;
  onSetProvider: (provider: DesktopProvider) => void;
  onSetModel: (model: string) => void;
  onStopThread: (threadId: string) => void;
  onSubmitMessage: (threadId: string, content: string) => void;
}) {
  const [draft, setDraft] = useState(initialDraft);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setDraft(initialDraft);
  }, [activeThreadId, initialDraft]);

  const handleChange = useCallback((value: string) => {
    setDraft(value);
    onDraftChange(activeThreadId, value);
  }, [activeThreadId, onDraftChange]);

  const handleSubmit = useCallback(() => {
    if (!activeThreadId || !draft.trim()) return;
    onSubmitMessage(activeThreadId, draft);
    setDraft("");
    onDraftChange(activeThreadId, "");
  }, [activeThreadId, draft, onDraftChange, onSubmitMessage]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-end gap-2">
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
        <Select value={model} onValueChange={onSetModel}>
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
      <PromptInput
        className="shrink-0"
        value={draft}
        onChange={handleChange}
        onSubmit={handleSubmit}
        onStop={activeThreadId ? () => onStopThread(activeThreadId) : undefined}
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
    prev.activeThreadId === next.activeThreadId &&
    prev.initialDraft === next.initialDraft &&
    prev.isStreaming === next.isStreaming &&
    prev.provider === next.provider &&
    prev.model === next.model &&
    prev.onDraftChange === next.onDraftChange &&
    prev.onSetProvider === next.onSetProvider &&
    prev.onSetModel === next.onSetModel &&
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
                  activeThreadId={activeThreadId}
                  initialDraft={initialDraft}
                  isStreaming={isStreaming}
                  provider={snapshot.provider}
                  model={snapshot.model}
                  onDraftChange={onDraftChange}
                  onSetProvider={onSetProvider}
                  onSetModel={onSetModel}
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
  "chat-thread": ChatThreadView,
  "extension-catalog": ExtensionCatalogPane,
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
  const [resolvedWebviewSrc, setResolvedWebviewSrc] = useState<string | null>(null);
  const [webviewError, setWebviewError] = useState<string | null>(null);
  const webviewEntrypoint =
    surface.render.kind === "webview" ? surface.render.entrypoint : null;

  useEffect(() => {
    let cancelled = false;

    async function resolveWebviewSource() {
      if (!webviewEntrypoint || !isSupportedPluginWebviewEntrypoint(webviewEntrypoint)) {
        setResolvedWebviewSrc(null);
        setWebviewError(null);
        return;
      }

      if (desktopShell?.resolveWebviewSrc) {
        try {
          const nextSrc = await desktopShell.resolveWebviewSrc(webviewEntrypoint);
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
        setResolvedWebviewSrc(webviewEntrypoint);
        setWebviewError(null);
      }
    }

    void resolveWebviewSource();

    return () => {
      cancelled = true;
    };
  }, [webviewEntrypoint]);

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
    const HostComponent = surface.render.component
      ? HOST_SURFACE_COMPONENTS[surface.render.component]
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

function ThreadPreviewPane({
  previewState,
  onClear,
  onCloseItem,
  onSelectItem,
  onSetVisible,
}: {
  previewState: DesktopThreadPreviewState;
  onClear: () => void;
  onCloseItem: (itemId: string) => void;
  onSelectItem: (itemId: string) => void;
  onSetVisible: (visible: boolean) => void;
}) {
  const activeItem =
    previewState.items.find((item) => item.id === previewState.activeItemId) ??
    previewState.items[0] ??
    null;
  const activePreviewUrl = activeItem?.src ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex items-center justify-between gap-2 border-b border-border/70 px-3 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">Preview</p>
          <p className="truncate text-xs text-muted-foreground">
            {previewState.items.length === 1
              ? "1 item"
              : `${previewState.items.length} items`}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Clear preview items"
            onClick={onClear}
          >
            <X className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Hide preview pane"
            onClick={() => onSetVisible(false)}
          >
            <PanelRightClose className="size-4" />
          </Button>
        </div>
      </div>

      <div className="border-b border-border/70 px-2 py-2">
        <div className="flex gap-2 overflow-x-auto">
          {previewState.items.map((item) => {
            const isActive = item.id === activeItem?.id;
            return (
              <div
                key={item.id}
                className={cn(
                  "group flex min-w-0 max-w-[220px] items-center gap-1 rounded-md border px-2 py-1.5 text-xs",
                  isActive
                    ? "border-border bg-background text-foreground"
                    : "border-transparent bg-muted/40 text-muted-foreground hover:text-foreground",
                )}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left"
                  onClick={() => onSelectItem(item.id)}
                >
                  {item.title}
                </button>
                <button
                  type="button"
                  className="shrink-0 rounded-sm p-0.5 opacity-60 hover:opacity-100"
                  aria-label={`Close ${item.title}`}
                  onClick={() => onCloseItem(item.id)}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden bg-muted/10">
        {!activeItem ? (
          <div className="flex h-full items-center justify-center p-6">
            <p className="text-sm text-muted-foreground">No preview selected.</p>
          </div>
        ) : activeItem.target.kind === "file" ? (
          activePreviewUrl ? (
            <FilePreviewContent
              filename={activeItem.title}
              previewUrl={activePreviewUrl}
              contentType={activeItem.contentType ?? undefined}
              layout="panel"
            />
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
        ) : activePreviewUrl ? (
          (() => {
            const targetUrl = activeItem.target.url;
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
                  title={activeItem.title}
                  src={activePreviewUrl}
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
    </div>
  );
}

function WorkbenchTabStrip({
  activeTabId,
  onCycleTabs,
  onCloseTab,
  onSelectTab,
  tabs,
}: {
  activeTabId: string | null;
  onCycleTabs: (offset: -1 | 1) => void;
  onCloseTab: (tabId: string) => void;
  onSelectTab: (tabId: string) => void;
  tabs: DesktopTab[];
}) {
  if (tabs.length === 0) {
    return null;
  }

  return (
    <div
      role="tablist"
      aria-label="Open workbench tabs"
      className="desktop-workbench-tablist desktop-no-drag"
    >
      {tabs.map((tab) => {
        const TabIcon = getDesktopIcon(tab.icon);
        const isActive = tab.id === activeTabId;
        const closeLabel =
          tab.kind === "thread"
            ? `Close ${tab.title} chat tab`
            : `Close ${tab.title} tab`;

        return (
          <div
            key={tab.id}
            className={cn("desktop-workbench-tab group/tab", isActive && "is-active")}
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
              <span className="desktop-workbench-tab-title">{tab.title}</span>
              {tab.subtitle ? (
                <span className="desktop-workbench-tab-subtitle">
                  {tab.subtitle}
                </span>
              ) : null}
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
        );
      })}
    </div>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState<DesktopSnapshot | null>(null);
  const [uiMessagesByThread, setUiMessagesByThread] = useState<
    Record<string, Message[]>
  >({});
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<
    "connecting" | "open" | "closed"
  >("connecting");
  const [showSettings, setShowSettings] = useState(false);
  const composerDraftsRef = useRef<Record<string, string>>({});
  const fallbackSocketRef = useRef<WebSocket | null>(null);
  const streamingMessageIdsRef = useRef<Record<string, string | null>>({});
  const reportedReadyRef = useRef(false);

  const activeThread = useMemo(
    () => getActiveThread(snapshot, activeThreadId),
    [snapshot, activeThreadId],
  );
  const activeView = useMemo(
    () => getView(snapshot, activeViewId),
    [snapshot, activeViewId],
  );
  const activeThreadPreviewState = useMemo(() => {
    if (!snapshot || !activeThreadId) {
      return null;
    }

    return (
      snapshot.threadPreviewStateById[activeThreadId] ?? {
        visible: false,
        activeItemId: null,
        items: [],
      }
    );
  }, [snapshot, activeThreadId]);
  const rawMessages = useMemo(() => {
    if (!activeThreadId) return [];
    return uiMessagesByThread[activeThreadId] ?? [];
  }, [activeThreadId, uiMessagesByThread]);
  const isStreaming = rawMessages.some(
    (message) => message.role === "assistant" && message.isStreaming,
  );
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
        setActiveTabId(next.activeTabId);
        setActiveThreadId(next.activeThreadId ?? next.threads[0]?.id ?? null);
        setActiveViewId(
          next.activeViewId ??
            next.views.find((view) => view.isDefault)?.id ??
            next.views[0]?.id ??
            null,
        );
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
        setActiveTabId(event.snapshot.activeTabId);
        setActiveThreadId(
          event.snapshot.activeThreadId ??
            event.snapshot.threads[0]?.id ??
            null,
        );
        setActiveViewId(
          event.snapshot.activeViewId ??
            event.snapshot.views.find((view) => view.isDefault)?.id ??
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

  const handleCreateThread = useCallback(() => {
    const defaultThreadViewId =
      snapshot?.views.find((view) => view.scope === "thread" && view.isDefault)?.id ??
      snapshot?.views.find((view) => view.scope === "thread")?.id ??
      null;
    setActiveTabId(null);
    if (defaultThreadViewId) {
      setActiveViewId(defaultThreadViewId);
    }
    sendEvent({ type: "create_thread" });
  }, [sendEvent, snapshot?.views]);

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
    setActiveThreadId(threadId);
    if (defaultThreadViewId) {
      setActiveViewId(defaultThreadViewId);
    }
    setActiveTabId(existingTab?.id ?? null);
    sendEvent({ type: "select_thread", threadId });
  }, [sendEvent, snapshot?.tabs, snapshot?.views]);

  const handleSelectView = useCallback((viewId: string) => {
    const existingTab =
      snapshot?.tabs.find(
        (tab) => tab.kind === "workspace" && tab.viewId === viewId,
      ) ?? null;
    setActiveViewId(viewId);
    setActiveTabId(existingTab?.id ?? null);
    sendEvent({ type: "select_view", viewId });
  }, [sendEvent, snapshot?.tabs]);

  const handleSelectTab = useCallback((tabId: string) => {
    const tab = snapshot?.tabs.find((entry) => entry.id === tabId) ?? null;
    if (!tab) {
      return;
    }

    setActiveTabId(tab.id);
    setActiveViewId(tab.viewId);
    if (tab.kind === "thread" && tab.threadId) {
      setActiveThreadId(tab.threadId);
    }
    sendEvent({ type: "select_tab", tabId });
  }, [sendEvent, snapshot?.tabs]);

  const handleCloseTab = useCallback((tabId: string) => {
    const tabs = snapshot?.tabs ?? [];
    const index = tabs.findIndex((tab) => tab.id === tabId);
    if (index === -1) {
      return;
    }

    const nextTabs = tabs.filter((tab) => tab.id !== tabId);
    if (activeTabId === tabId) {
      const fallback = nextTabs[index] ?? nextTabs[index - 1] ?? nextTabs[0] ?? null;
      setActiveTabId(fallback?.id ?? null);
      setActiveViewId(fallback?.viewId ?? null);
      if (fallback?.kind === "thread" && fallback.threadId) {
        setActiveThreadId(fallback.threadId);
      }
      if (fallback?.id) {
        focusWorkbenchTab(fallback.id);
      }
    }
    sendEvent({ type: "close_tab", tabId });
  }, [activeTabId, sendEvent, snapshot?.tabs]);

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

    handleSelectTab(nextTab.id);
    focusWorkbenchTab(nextTab.id);
  }, [activeTabId, handleSelectTab, snapshot?.tabs]);

  const handleSetModel = useCallback((model: string) => {
    if (!snapshot?.availableModels.some((option) => option.id === model)) {
      return;
    }
    sendEvent({ type: "set_model", model: model as DesktopModel });
  }, [sendEvent, snapshot?.availableModels]);

  const handleSetProvider = useCallback((provider: DesktopProvider) => {
    if (!snapshot?.availableProviders.some((option) => option.id === provider)) {
      return;
    }
    sendEvent({ type: "set_provider", provider });
  }, [sendEvent, snapshot?.availableProviders]);

  const initialDraft = composerDraftsRef.current[getDraftKey(activeThreadId)] ?? "";

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

  const handleSelectPreviewItem = useCallback((itemId: string) => {
    if (!activeThreadId) {
      return;
    }

    sendEvent({
      type: "preview_select_item",
      threadId: activeThreadId,
      itemId,
    });
  }, [activeThreadId, sendEvent]);

  const handleClosePreviewItem = useCallback((itemId: string) => {
    if (!activeThreadId) {
      return;
    }

    sendEvent({
      type: "preview_close_item",
      threadId: activeThreadId,
      itemId,
    });
  }, [activeThreadId, sendEvent]);

  const handleSetPreviewVisible = useCallback((visible: boolean) => {
    if (!activeThreadId) {
      return;
    }

    sendEvent({
      type: "preview_set_visibility",
      threadId: activeThreadId,
      visible,
    });
  }, [activeThreadId, sendEvent]);

  useEffect(() => {
    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) {
        return;
      }

      if (!(event.metaKey || event.ctrlKey) || event.altKey) {
        return;
      }

      if (event.key === "w") {
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

  const activeSurfaceProps = snapshot && activeView ? {
    snapshot,
    surface: activeView,
    activeThreadId,
    rawMessages,
    initialDraft,
    isStreaming,
    onDraftChange: handleDraftChange,
    onSetProvider: handleSetProvider,
    onSetModel: handleSetModel,
    onStopThread: handleStopThread,
    onSubmitMessage: handleSubmitMessage,
    onSendEvent: sendEvent,
    onOpenPreviewTarget: handleOpenPreviewTarget,
    onSetPreviewTargets: handleSetPreviewTargets,
    onClearPreviewTargets: handleClearPreviewTargets,
  } : null;

  return (
    <TooltipProvider>
      <div className="desktop-shell text-foreground">
        <header className="desktop-titlebar desktop-drag">
          <div className="desktop-titlebar-inner">
            <div className="desktop-traffic-spacer" />
            <WorkbenchTabStrip
              activeTabId={activeTabId}
              onCycleTabs={handleCycleTabs}
              onCloseTab={handleCloseTab}
              onSelectTab={handleSelectTab}
              tabs={snapshot?.tabs ?? []}
            />
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
              onCreateThread={handleCreateThread}
              onOpenSettings={() => setShowSettings(true)}
              onSelectThread={(threadId) => { setShowSettings(false); handleSelectThread(threadId); }}
              onSelectView={(viewId) => { setShowSettings(false); handleSelectView(viewId); }}
              showSettings={showSettings}
              snapshot={snapshot}
              threads={snapshot?.threads ?? []}
              views={snapshot?.views ?? []}
            />
            <SidebarInset className="overflow-hidden flex flex-col">
              <div className="flex flex-1 min-h-0 flex-col">
                {showSettings ? (
                  <SettingsPage />
                ) : activeSurfaceProps ? (
                  <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
                    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                      <WorkbenchSurfacePane {...activeSurfaceProps} />
                    </div>

                    {activeThreadPreviewState?.visible &&
                    activeThreadPreviewState.items.length > 0 ? (
                      <aside className="flex min-h-[320px] w-full min-w-0 border-t border-border/60 bg-muted/10 lg:min-h-0 lg:w-[420px] lg:border-l lg:border-t-0 xl:w-[480px] 2xl:w-[560px]">
                        <ThreadPreviewPane
                          previewState={activeThreadPreviewState}
                          onClear={handleClearPreviewTargets}
                          onCloseItem={handleClosePreviewItem}
                          onSelectItem={handleSelectPreviewItem}
                          onSetVisible={handleSetPreviewVisible}
                        />
                      </aside>
                    ) : null}
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
    </TooltipProvider>
  );
}
