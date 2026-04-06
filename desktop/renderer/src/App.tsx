import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AlertCircle, Loader2, Plus } from "lucide-react";
import { ContentBlockRenderer } from "@/components/message-bubble";
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
import { PageHeader } from "@/components/page-header";
import { Progress } from "@/components/ui/progress";
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
import {
  mergeTaskNotifications,
  mergeTeammateMessages,
  normalizeToolResultMessages,
} from "@/lib/streaming";
import type { ContentBlock, Message } from "@/types";
import type {
  DesktopClientEvent,
  DesktopModel,
  DesktopPage,
  DesktopProvider,
  DesktopServerEvent,
  DesktopSnapshot,
  DesktopThread,
} from "../../shared/protocol";
import {
  applyRuntimeEventToMessages,
  mergeSnapshotMessages,
} from "../../shared/message-state";
import { DesktopSidebar } from "./desktop-sidebar";
import { getDesktopIcon } from "./desktop-icons";

const desktopShell = window.desktopShell;
const fallbackBackendUrl = "http://127.0.0.1:4315";
const RUNTIME_BOOT_SCREEN_DELAY_MS = 450;
const EMPTY_THREAD_DRAFT_KEY = "__no_thread__";
function getActiveThread(
  snapshot: DesktopSnapshot | null,
  threadId: string | null,
): DesktopThread | null {
  if (!snapshot || !threadId) return null;
  return snapshot.threads.find((thread) => thread.id === threadId) ?? null;
}

function getPluginPage(
  snapshot: DesktopSnapshot | null,
  pageId: string | null,
): DesktopPage | null {
  if (!snapshot || !pageId) {
    return null;
  }

  return snapshot.pages.find((page) => page.id === pageId) ?? null;
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
    threadId?: string | null;
    pluginId?: string | null;
    pageId?: string | null;
    mode: "full" | "companion";
  },
): string {
  try {
    const url = new URL(source);
    const params = new URLSearchParams();
    if (context.threadId) {
      params.set("threadId", context.threadId);
    }
    if (context.pluginId) {
      params.set("pluginId", context.pluginId);
    }
    if (context.pageId) {
      params.set("pageId", context.pageId);
    }
    params.set("surface", context.mode);

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

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function authBadgeLabel(snapshot: DesktopSnapshot | null): string {
  if (!snapshot) {
    return "Checking auth";
  }
  if (!snapshot.auth.available) {
    return snapshot.auth.label;
  }
  return `${snapshot.auth.label} · ${snapshot.model}`;
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

  return (
    snapshot.runtimeStatus.state !== "running" &&
    Boolean(runtimeDetail(snapshot))
  );
}

function shouldBlockOnRuntime(
  snapshot: DesktopSnapshot | null,
  connectionState: "connecting" | "open" | "closed",
): boolean {
  if (connectionState === "connecting") {
    return true;
  }
  if (!snapshot) {
    return true;
  }
  return snapshot.runtimeStatus.state !== "running";
}

function getRuntimeBootProgress(snapshot: DesktopSnapshot | null): number {
  if (!snapshot) {
    return 10;
  }

  if (snapshot.runtimeStatus.state === "running") {
    return 100;
  }
  if (snapshot.runtimeStatus.state === "error") {
    return 100;
  }
  if (snapshot.runtimeStatus.state === "starting") {
    return 60;
  }
  return 20;
}

function getRuntimeBootTitle(
  snapshot: DesktopSnapshot | null,
  connectionState: "connecting" | "open" | "closed",
): string {
  if (connectionState === "connecting") {
    return "Connecting desktop runtime";
  }
  if (!snapshot) {
    return "Preparing desktop runtime";
  }
  if (snapshot.runtimeStatus.state === "error") {
    return "Runtime failed to start";
  }
  if (snapshot.runtimeStatus.state === "running") {
    return "Runtime ready";
  }
  return "Starting local runtime";
}

function getRuntimeBootCaption(
  snapshot: DesktopSnapshot | null,
  connectionState: "connecting" | "open" | "closed",
): string {
  if (connectionState === "connecting") {
    return "Connecting the desktop shell to the local backend.";
  }
  if (!snapshot) {
    return "Preparing the local runtime.";
  }

  if (snapshot.runtimeStatus.state === "error") {
    return "The local runtime did not finish booting.";
  }
  if (snapshot.runtimeStatus.state === "starting") {
    return "Starting the local runtime.";
  }
  return "Preparing the local runtime.";
}

function RuntimeBootScreen({
  snapshot,
  connectionState,
}: {
  snapshot: DesktopSnapshot | null;
  connectionState: "connecting" | "open" | "closed";
}) {
  const isError = snapshot?.runtimeStatus.state === "error";
  const detail = runtimeDetail(snapshot);
  const progress = getRuntimeBootProgress(snapshot);

  return (
    <div className="flex flex-1 items-center justify-center px-6 py-10">
      <div className="w-full max-w-xl rounded-3xl border border-border/70 bg-card/85 p-8 shadow-sm backdrop-blur-xl">
        <div className="flex items-center gap-3">
          <div
            className={`flex size-10 items-center justify-center rounded-2xl border ${
              isError
                ? "border-destructive/30 bg-destructive/10 text-destructive"
                : "border-border bg-background text-foreground"
            }`}
          >
            {isError ? (
              <AlertCircle className="size-5" />
            ) : (
              <Loader2 className="size-5 animate-spin" />
            )}
          </div>
          <div className="min-w-0">
            <h2 className="text-xl font-semibold">
              {getRuntimeBootTitle(snapshot, connectionState)}
            </h2>
            <p className="text-sm text-muted-foreground">
              {getRuntimeBootCaption(snapshot, connectionState)}
            </p>
          </div>
        </div>

        <div className="mt-6 space-y-3">
          <div className="flex items-center justify-between text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            <span>Runtime boot</span>
            <span>{isError ? "Error" : `${progress}%`}</span>
          </div>
          <Progress value={progress} className="h-2 rounded-full" />
        </div>

        {detail ? (
          <Alert
            variant={isError ? "destructive" : "default"}
            className="mt-6 bg-background/70"
          >
            <AlertTitle>
              {isError ? "Runtime error" : "Current step"}
            </AlertTitle>
            <AlertDescription>{detail}</AlertDescription>
          </Alert>
        ) : null}
      </div>
    </div>
  );
}

function coerceTextContent(content: string | ContentBlock[]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter(
      (block): block is Extract<ContentBlock, { type: "text" }> =>
        block.type === "text",
    )
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
                This desktop renderer now uses the same sidebar, header, and
                composer primitives as the web app. The remaining gap is deeper
                message rendering parity for SDK tool events.
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

function ChatPane({
  rawMessages,
  activeThreadId,
  initialDraft,
  isStreaming,
  onDraftChange,
  onSubmitMessage,
}: {
  rawMessages: Message[];
  activeThreadId: string | null;
  initialDraft: string;
  isStreaming: boolean;
  onDraftChange: (threadId: string | null, draft: string) => void;
  onSubmitMessage: (threadId: string, content: string) => void;
}) {
  return (
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
              <MemoizedComposer
                activeThreadId={activeThreadId}
                initialDraft={initialDraft}
                isStreaming={isStreaming}
                onDraftChange={onDraftChange}
                onSubmitMessage={onSubmitMessage}
              />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function Composer({
  activeThreadId,
  initialDraft,
  isStreaming,
  onDraftChange,
  onSubmitMessage,
}: {
  activeThreadId: string | null;
  initialDraft: string;
  isStreaming: boolean;
  onDraftChange: (threadId: string | null, draft: string) => void;
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
    if (!activeThreadId || !draft.trim() || isStreaming) return;
    onSubmitMessage(activeThreadId, draft);
    setDraft("");
    onDraftChange(activeThreadId, "");
  }, [activeThreadId, draft, isStreaming, onDraftChange, onSubmitMessage]);

  return (
    <PromptInput
      className="shrink-0"
      value={draft}
      onChange={handleChange}
      onSubmit={handleSubmit}
      placeholder="Type a message..."
      isAssistantRunning={isStreaming}
      textareaRef={composerTextareaRef}
    />
  );
}

const MemoizedComposer = memo(
  Composer,
  (prev, next) =>
    prev.activeThreadId === next.activeThreadId &&
    prev.initialDraft === next.initialDraft &&
    prev.isStreaming === next.isStreaming &&
    prev.onDraftChange === next.onDraftChange &&
    prev.onSubmitMessage === next.onSubmitMessage,
);

function capabilityLabel(
  label: string,
  count: number,
): string {
  if (count === 1) {
    return `1 ${label}`;
  }

  return `${count} ${label}s`;
}

function PluginCatalogPane({
  snapshot,
  mode = "full",
}: {
  snapshot: DesktopSnapshot;
  mode?: "full" | "companion";
}) {
  return (
    <div className="flex flex-1 overflow-y-auto">
      <div
        className={`flex w-full flex-col gap-4 px-4 pb-8 pt-5 md:px-6 ${
          mode === "companion" ? "" : "mx-auto max-w-5xl"
        }`}
      >
        <Card className="border-dashed">
          <CardHeader>
            <CardTitle>Extension Lab</CardTitle>
            <CardDescription>
              The desktop host now discovers lightweight `camelai` manifests and
              lets plugins imperatively register pages, preview panes, commands,
              tools, and runtime hooks.
            </CardDescription>
          </CardHeader>
        </Card>

        {snapshot.plugins.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>No plugins installed</CardTitle>
              <CardDescription>
                Builtin plugins will appear here, and user-installed plugins
                will be read from the desktop data directory.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <div
            className={`grid gap-4 ${
              mode === "companion" ? "grid-cols-1" : "md:grid-cols-2 xl:grid-cols-3"
            }`}
          >
            {snapshot.plugins.map((plugin) => (
              <Card key={plugin.id} className="h-full">
                <CardHeader className="gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">{plugin.source}</Badge>
                    <Badge variant={plugin.runtime.activated ? "secondary" : "outline"}>
                      {plugin.runtime.activated ? "activated" : "discovered"}
                    </Badge>
                    {plugin.runtime.activationError ? (
                      <Badge variant="destructive">activation error</Badge>
                    ) : null}
                  </div>
                  <div>
                    <CardTitle className="text-base">{plugin.name}</CardTitle>
                    <CardDescription>
                      {plugin.description ?? "No plugin description yet."}
                    </CardDescription>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex flex-wrap gap-2 text-xs">
                    <Badge variant="outline">
                      {capabilityLabel("page", plugin.capabilities.pages.length)}
                    </Badge>
                    <Badge variant="outline">
                      {capabilityLabel(
                        "preview",
                        plugin.capabilities.previewPanes.length,
                      )}
                    </Badge>
                    <Badge variant="outline">
                      {capabilityLabel(
                        "command",
                        plugin.capabilities.commands.length,
                      )}
                    </Badge>
                    <Badge variant="outline">
                      {capabilityLabel("tool", plugin.capabilities.tools.length)}
                    </Badge>
                  </div>

                  <div className="space-y-2 text-sm text-muted-foreground">
                    <p className="font-medium text-foreground">
                      {plugin.id}
                    </p>
                    <p>{plugin.path}</p>
                  </div>

                  {plugin.capabilities.tools.length > 0 ? (
                    <div className="space-y-2">
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                        Tools
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {plugin.capabilities.tools.map((tool) => (
                          <Badge key={tool.id} variant="secondary">
                            {tool.id}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {plugin.runtime.subscribedEvents.length > 0 ? (
                    <div className="space-y-2">
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                        Hooks
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {plugin.runtime.subscribedEvents.map((eventName) => (
                          <Badge key={eventName} variant="outline">
                            {eventName}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {plugin.runtime.activationError ? (
                    <Alert variant="destructive">
                      <AlertTitle>Activation failed</AlertTitle>
                      <AlertDescription>
                        {plugin.runtime.activationError}
                      </AlertDescription>
                    </Alert>
                  ) : null}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PluginDetailPane({
  snapshot,
  page,
  activeThreadId = null,
  mode = "full",
}: {
  snapshot: DesktopSnapshot;
  page: DesktopPage;
  activeThreadId?: string | null;
  mode?: "full" | "companion";
}) {
  const [resolvedWebviewSrc, setResolvedWebviewSrc] = useState<string | null>(null);
  const [webviewError, setWebviewError] = useState<string | null>(null);
  const plugin = snapshot.plugins.find((item) => item.id === page.pluginId);
  const ViewIcon = getDesktopIcon(page.icon);
  const webviewEntrypoint =
    page.render.kind === "webview" ? page.render.entrypoint : null;

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
        threadId: mode === "companion" ? activeThreadId : null,
        pluginId: page.pluginId,
        pageId: page.id,
        mode,
      })
    : null;

  if (page.hostData) {
    return (
      <div className="flex flex-1 overflow-y-auto">
        <div
          className={`flex w-full flex-col gap-4 px-4 pb-8 pt-5 md:px-6 ${
            mode === "companion" ? "" : "mx-auto max-w-4xl"
          }`}
        >
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="flex size-10 items-center justify-center rounded-2xl border border-border bg-muted/40">
                  <ViewIcon className="size-5" />
                </div>
                <div>
                  <CardTitle>{page.title}</CardTitle>
                  <CardDescription>
                    {page.description ??
                      "Plugin-provided data for the current AgentOS context."}
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
          </Card>

          {page.hostData.sections.map((section) => (
            <Card key={section.id}>
              <CardHeader>
                <CardTitle className="text-base">{section.title}</CardTitle>
                <CardDescription>
                  {section.description ?? "Plugin-provided section"}
                </CardDescription>
              </CardHeader>
              <CardContent
                className={`grid gap-3 ${
                  mode === "companion" ? "grid-cols-1" : "md:grid-cols-2"
                }`}
              >
                {section.items.map((item) => (
                  <div
                    key={`${section.id}:${item.label}`}
                    className="rounded-lg border border-border/60 bg-background/70 px-3 py-3"
                  >
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
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

  if (
    mode === "companion" &&
    page.render.kind === "webview" &&
    isSupportedPluginWebviewEntrypoint(webviewEntrypoint)
  ) {
    return (
      <div className="flex min-h-0 flex-1 bg-background">
        {webviewError ? (
          <Alert className="m-4 self-start">
            <AlertTitle>Webview failed to load</AlertTitle>
            <AlertDescription>{webviewError}</AlertDescription>
          </Alert>
        ) : contextualWebviewSrc ? (
          <iframe
            title={`${page.title} plugin webview`}
            src={contextualWebviewSrc}
            className="min-h-0 w-full flex-1 bg-white"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center bg-muted/10">
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              <span>Loading plugin surface…</span>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-1 overflow-y-auto">
      <div
        className={`flex w-full flex-col gap-4 px-4 pb-8 pt-5 md:px-6 ${
          mode === "companion" ? "" : "mx-auto max-w-4xl"
        }`}
      >
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-2xl border border-border bg-muted/40">
                <ViewIcon className="size-5" />
              </div>
              <div>
                <CardTitle>{page.title}</CardTitle>
                <CardDescription>
                  {page.description ?? "This plugin page does not have a description yet."}
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {plugin ? (
              <>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="secondary">{plugin.name}</Badge>
                  <Badge variant="outline">{plugin.source}</Badge>
                  <Badge variant={plugin.runtime.activated ? "secondary" : "outline"}>
                    {plugin.runtime.activated ? "activated" : "discovered"}
                  </Badge>
                </div>

                <p className="text-sm leading-relaxed text-muted-foreground">
                  {plugin.description ??
                    "The plugin was discovered from its manifest, but it has not registered a richer page yet."}
                </p>
              </>
            ) : null}

            {page.render.kind === "webview" ? (
              isSupportedPluginWebviewEntrypoint(webviewEntrypoint) ? (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/60 bg-muted/20 px-4 py-3">
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-foreground">
                        Plugin webview
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Rendering plugin-owned web content in the companion pane.
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
                        title={`${page.title} plugin webview`}
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
                </div>
              ) : (
                <Alert>
                  <AlertTitle>Unsupported webview entrypoint</AlertTitle>
                  <AlertDescription>
                    Plugin webviews currently support `https:`, `http:`, `data:`,
                    and plugin-local HTML entrypoints.
                  </AlertDescription>
                </Alert>
              )
            ) : (
              <Alert>
                <AlertTitle>Host-rendered fallback</AlertTitle>
                <AlertDescription>
                  This view currently uses a host-rendered surface. Plugin-owned
                  React/webview rendering can layer on top of the same manifest
                  and activation model later.
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

const MemoizedCompanionWebviewPane = memo(
  function CompanionWebviewPane({
    title,
    entrypoint,
    activeThreadId,
    pluginId,
    pageId,
  }: {
    title: string;
    entrypoint: string;
    activeThreadId: string | null;
    pluginId: string | null;
    pageId: string;
  }) {
    const [resolvedWebviewSrc, setResolvedWebviewSrc] = useState<string | null>(null);
    const [webviewError, setWebviewError] = useState<string | null>(null);

    useEffect(() => {
      let cancelled = false;

      async function resolveWebviewSource() {
        if (!isSupportedPluginWebviewEntrypoint(entrypoint)) {
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

    const contextualWebviewSrc = resolvedWebviewSrc
      ? withPluginWebviewContext(resolvedWebviewSrc, {
          threadId: activeThreadId,
          pluginId,
          pageId,
          mode: "companion",
        })
      : null;

    return (
      <div className="flex min-h-0 flex-1 bg-background">
        {webviewError ? (
          <Alert className="m-4 self-start">
            <AlertTitle>Webview failed to load</AlertTitle>
            <AlertDescription>{webviewError}</AlertDescription>
          </Alert>
        ) : contextualWebviewSrc ? (
          <iframe
            title={`${title} plugin webview`}
            src={contextualWebviewSrc}
            className="min-h-0 w-full flex-1 bg-white"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center bg-muted/10">
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              <span>Loading plugin surface…</span>
            </div>
          </div>
        )}
      </div>
    );
  },
  (prev, next) =>
    prev.title === next.title &&
    prev.entrypoint === next.entrypoint &&
    prev.activeThreadId === next.activeThreadId &&
    prev.pluginId === next.pluginId &&
    prev.pageId === next.pageId,
);

function PluginPane({
  snapshot,
  page,
  activeThreadId = null,
  mode = "full",
}: {
  snapshot: DesktopSnapshot;
  page: DesktopPage;
  activeThreadId?: string | null;
  mode?: "full" | "companion";
}) {
  if (page.render.kind === "host" && page.render.component === "extension-catalog") {
    return <PluginCatalogPane snapshot={snapshot} mode={mode} />;
  }

  return (
    <PluginDetailPane
      snapshot={snapshot}
      page={page}
      activeThreadId={activeThreadId}
      mode={mode}
    />
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState<DesktopSnapshot | null>(null);
  const [uiMessagesByThread, setUiMessagesByThread] = useState<
    Record<string, Message[]>
  >({});
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [activePluginPageId, setActivePluginPageId] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<
    "connecting" | "open" | "closed"
  >("connecting");
  const [runtimeBootDelayElapsed, setRuntimeBootDelayElapsed] = useState(false);
  const composerDraftsRef = useRef<Record<string, string>>({});
  const fallbackSocketRef = useRef<WebSocket | null>(null);
  const streamingMessageIdsRef = useRef<Record<string, string | null>>({});
  const reportedReadyRef = useRef(false);

  const activeThread = useMemo(
    () => getActiveThread(snapshot, activeThreadId),
    [snapshot, activeThreadId],
  );
  const activePluginPage = useMemo(
    () => getPluginPage(snapshot, activePluginPageId),
    [snapshot, activePluginPageId],
  );
  const activeThreadPreviewState = useMemo(() => {
    if (!snapshot || !activeThreadId) {
      return null;
    }

    return (
      snapshot.threadPreviewStateById[activeThreadId] ?? {
        pageId: null,
        visible: false,
      }
    );
  }, [snapshot, activeThreadId]);
  const activeThreadPreviewPage = useMemo(
    () =>
      activeThreadPreviewState?.visible
        ? getPluginPage(snapshot, activeThreadPreviewState.pageId)
        : null,
    [activeThreadPreviewState, snapshot],
  );
  const rawMessages = useMemo(() => {
    if (!activeThreadId) return [];
    return uiMessagesByThread[activeThreadId] ?? [];
  }, [activeThreadId, uiMessagesByThread]);
  const isStreaming = rawMessages.some(
    (message) => message.role === "assistant" && message.isStreaming,
  );
  const shouldDelayRuntimeBootScreen =
    connectionState === "open" &&
    snapshot !== null &&
    snapshot.runtimeStatus.state !== "running" &&
    snapshot.runtimeStatus.state !== "error";
  const shouldBlockRuntime =
    shouldBlockOnRuntime(snapshot, connectionState) &&
    (!shouldDelayRuntimeBootScreen || runtimeBootDelayElapsed);

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
        setActiveThreadId(next.activeThreadId ?? next.threads[0]?.id ?? null);
        setActivePluginPageId(next.activePluginPageId ?? null);
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
        setActiveThreadId(
          event.snapshot.activeThreadId ??
            event.snapshot.threads[0]?.id ??
            null,
        );
        setActivePluginPageId(event.snapshot.activePluginPageId ?? null);
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
    if (!shouldDelayRuntimeBootScreen) {
      setRuntimeBootDelayElapsed(false);
      return;
    }

    setRuntimeBootDelayElapsed(false);
    const timeoutId = window.setTimeout(() => {
      setRuntimeBootDelayElapsed(true);
    }, RUNTIME_BOOT_SCREEN_DELAY_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [shouldDelayRuntimeBootScreen, snapshot?.runtimeStatus.state]);

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
    setActivePluginPageId(null);
    sendEvent({ type: "create_thread" });
  }, [sendEvent]);

  const handleSelectThread = useCallback((threadId: string) => {
    setActiveThreadId(threadId);
    setActivePluginPageId(null);
    sendEvent({ type: "select_thread", threadId });
  }, [sendEvent]);

  const handleShowChat = useCallback(() => {
    setActivePluginPageId(null);
    if (activeThreadId) {
      sendEvent({ type: "select_thread", threadId: activeThreadId });
    }
  }, [activeThreadId, sendEvent]);

  const handleSelectPluginPage = useCallback((pageId: string) => {
    setActivePluginPageId(pageId);
    sendEvent({ type: "select_plugin_page", pageId });
  }, [sendEvent]);

  const handleSetModel = useCallback((model: string) => {
    if (!snapshot?.availableModels.some((option) => option.id === model)) {
      return;
    }
    sendEvent({ type: "set_model", model: model as DesktopModel });
  }, [sendEvent, snapshot?.availableModels]);

  const handleSetProvider = useCallback((provider: string) => {
    if (!snapshot?.availableProviders.some((option) => option.id === provider)) {
      return;
    }
    sendEvent({ type: "set_provider", provider: provider as DesktopProvider });
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

  return (
    <TooltipProvider>
      <div className="desktop-shell text-foreground">
        <header className="desktop-titlebar desktop-drag">
          <div className="desktop-titlebar-inner">
            <div className="desktop-traffic-spacer" />
            <div className="min-w-0">
              <p className="truncate text-[0.7rem] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                camelAI Desktop
              </p>
            </div>
            <div className="desktop-no-drag ml-auto flex items-center gap-2">
              {snapshot && snapshot.availableProviders.length > 1 ? (
                <Select
                  value={snapshot.provider}
                  onValueChange={handleSetProvider}
                >
                  <SelectTrigger
                    size="sm"
                    className="w-[118px] bg-background/70 backdrop-blur"
                    aria-label="Provider"
                  >
                    <SelectValue placeholder="Provider" />
                  </SelectTrigger>
                  <SelectContent>
                    {snapshot.availableProviders.map((provider) => (
                      <SelectItem key={provider.id} value={provider.id}>
                        {provider.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
              <Select
                value={snapshot?.model ?? ""}
                onValueChange={handleSetModel}
              >
                <SelectTrigger
                  size="sm"
                  className="w-[118px] bg-background/70 backdrop-blur"
                  aria-label="Model"
                >
                  <SelectValue placeholder="Model" />
                </SelectTrigger>
                <SelectContent>
                  {(snapshot?.availableModels ?? []).map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Badge
                variant={snapshot?.auth.available ? "secondary" : "destructive"}
              >
                {authBadgeLabel(snapshot)}
              </Badge>
              <Button variant="outline" size="sm" onClick={handleCreateThread}>
                <Plus />
                New thread
              </Button>
            </div>
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
              activePluginPageId={activePluginPageId}
              connectionState={connectionState}
              onCreateThread={handleCreateThread}
              onShowChat={handleShowChat}
              onSelectThread={handleSelectThread}
              onSelectPluginPage={handleSelectPluginPage}
              snapshot={snapshot}
              threads={snapshot?.threads ?? []}
              pluginPages={snapshot?.pages ?? []}
            />
            <SidebarInset className="overflow-hidden flex flex-col">
              <PageHeader
                breadcrumbs={
                  activePluginPage
                    ? [{ label: activePluginPage.title }]
                    : [
                        { label: "Chat" },
                        { label: activeThread?.title ?? "New Chat" },
                      ]
                }
                className="border-b border-border/60"
              />

              <div className="flex flex-1 min-h-0 flex-col">
                {shouldBlockRuntime ? (
                  <RuntimeBootScreen
                    snapshot={snapshot}
                    connectionState={connectionState}
                  />
                ) : (
                  <>
                    {snapshot && activePluginPage ? (
                      <PluginPane
                        snapshot={snapshot}
                        page={activePluginPage}
                        activeThreadId={activeThreadId}
                        mode="full"
                      />
                    ) : (
                      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
                        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                          <ChatPane
                            rawMessages={rawMessages}
                            activeThreadId={activeThreadId}
                            initialDraft={initialDraft}
                            isStreaming={isStreaming}
                            onDraftChange={handleDraftChange}
                            onSubmitMessage={handleSubmitMessage}
                          />
                        </div>

                        {snapshot && activeThreadPreviewPage ? (
                          <aside className="flex min-h-[320px] w-full min-w-0 border-t border-border/60 bg-muted/10 lg:min-h-0 lg:w-[420px] lg:border-l lg:border-t-0 xl:w-[480px] 2xl:w-[560px]">
                            {activeThreadPreviewPage.render.kind === "webview" ? (
                              <MemoizedCompanionWebviewPane
                                title={activeThreadPreviewPage.title}
                                entrypoint={
                                  activeThreadPreviewPage.render.kind === "webview"
                                    ? (activeThreadPreviewPage.render.entrypoint ?? "")
                                    : ""
                                }
                                activeThreadId={activeThreadId}
                                pluginId={activeThreadPreviewPage.pluginId}
                                pageId={activeThreadPreviewPage.id}
                              />
                            ) : (
                              <PluginPane
                                snapshot={snapshot}
                                page={activeThreadPreviewPage}
                                activeThreadId={activeThreadId}
                                mode="companion"
                              />
                            )}
                          </aside>
                        ) : null}
                      </div>
                    )}
                  </>
                )}
              </div>
            </SidebarInset>
          </SidebarProvider>
        </div>
      </div>
    </TooltipProvider>
  );
}
