import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopServerEvent,
  DesktopSnapshot,
} from "../desktop/shared/protocol";
import type { ContentBlock } from "@/types";

vi.mock("@/components/message-bubble", () => ({
  ContentBlockRenderer: ({
    content,
  }: {
    content: string | ContentBlock[];
  }) => {
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
    return (
      <div data-testid="content-blocks">
        {blocks.map((block, index) => {
          if (block.type === "text") {
            return (
              <div key={index} data-kind="text" data-testid="text-block">
                {block.text}
              </div>
            );
          }
          if (block.type === "thinking") {
            return (
              <div key={index} data-kind="thinking" data-testid="thinking-block">
                {block.thinking}
              </div>
            );
          }
          if (block.type === "tool_use") {
            return (
              <div key={index} data-kind="tool_use" data-testid="tool-use-block">
                {block.name}:{JSON.stringify(block.input)}
              </div>
            );
          }
          if (block.type === "tool_result") {
            const resultContent =
              typeof block.content === "string"
                ? block.content
                : JSON.stringify(block.content);
            return (
              <div key={index} data-kind="tool_result" data-testid="tool-result-block">
                {resultContent}
              </div>
            );
          }
          return (
            <div key={index} data-kind={block.type} data-testid="other-block">
              {JSON.stringify(block)}
            </div>
          );
        })}
      </div>
    );
  },
}));

vi.mock("@/components/markdown-renderer", () => ({
  MarkdownRenderer: ({
    content,
  }: {
    content: string;
  }) => <div data-testid="markdown">{content}</div>,
}));

vi.mock("@/components/loading-dots", () => ({
  LoadingDots: () => <div data-testid="loading-dots">loading</div>,
}));

vi.mock("@/components/page-header", () => ({
  PageHeader: ({ breadcrumbs }: { breadcrumbs?: Array<{ label: string }> }) => (
    <div data-testid="page-header">
      {breadcrumbs?.map((crumb) => crumb.label).join(" / ")}
    </div>
  ),
}));

vi.mock("@/components/prompt-input", () => ({
  PromptInput: ({
    value,
    onChange,
    onSubmit,
    onStop,
    placeholder,
    isAssistantRunning,
    textareaRef,
  }: {
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    onStop?: () => void;
    placeholder?: string;
    isAssistantRunning?: boolean;
    textareaRef?: { current: HTMLTextAreaElement | null };
  }) => (
    <div>
      <textarea
        aria-label="Prompt input"
        placeholder={placeholder}
        value={value}
        ref={textareaRef ?? undefined}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      <button onClick={onSubmit} type="button">
        Send
      </button>
      {isAssistantRunning && onStop ? (
        <button onClick={onStop} type="button">
          Stop
        </button>
      ) : null}
    </div>
  ),
}));

vi.mock("@/components/ui/alert", () => ({
  Alert: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
  }: {
    children: ReactNode;
    onClick?: () => void;
  }) => (
    <button onClick={onClick} type="button">
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/progress", () => ({
  Progress: ({ value }: { value: number }) => <div data-testid="progress">{value}</div>,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/avatar", () => ({
  Avatar: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AvatarFallback: ({
    children,
    content,
  }: {
    children?: ReactNode;
    content?: string;
  }) => <div>{children ?? content}</div>,
}));

vi.mock("@/components/ui/sidebar", () => ({
  SidebarProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarInset: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Sidebar: ({ children }: { children: ReactNode }) => <aside>{children}</aside>,
  SidebarContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarGroupAction: ({
    children,
    onClick,
  }: {
    children: ReactNode;
    onClick?: () => void;
  }) => (
    <button onClick={onClick} type="button">
      {children}
    </button>
  ),
  SidebarGroupContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarGroupLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarMenuButton: ({
    children,
    onClick,
  }: {
    children: ReactNode;
    onClick?: () => void;
  }) => (
    <button onClick={onClick} type="button">
      {children}
    </button>
  ),
  SidebarMenuItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarRail: () => null,
  SidebarSeparator: () => <hr />,
  useSidebar: () => ({ state: "expanded" }),
}));

type DesktopShellListener = (event: DesktopServerEvent) => void;

type MockDesktopShell = {
  platform: string;
  versions: {
    chrome: string;
    electron: string;
    node: string;
  };
  getSnapshot: ReturnType<typeof vi.fn>;
  resolveWebviewSrc: ReturnType<typeof vi.fn>;
  sendEvent: ReturnType<typeof vi.fn>;
  reportReady: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
};

function createSnapshot(): DesktopSnapshot {
  const now = Date.now();
  const groupId = "group-1";
  return {
    threadGroups: [
      {
        id: groupId,
        title: "Default Group",
        createdAt: now,
        updatedAt: now,
      },
    ],
    threads: [
      {
        id: "thread-1",
        groupId,
        provider: "claude",
        title: "Claude test thread",
        createdAt: now,
        updatedAt: now,
        lastMessagePreview: null,
        status: null,
        lane: null,
        archivedAt: null,
        hasUnreadUpdate: false,
      },
    ],
    messagesByThread: {
      "thread-1": [],
    },
    tabs: [
      {
        id: "tab-thread-1",
        kind: "thread",
        threadId: "thread-1",
        viewId: "plugin:chat:chat.thread",
        title: "Claude test thread",
        subtitle: null,
        icon: "MessagesSquare",
        closable: true,
      },
    ],
    activeTabId: "tab-thread-1",
    activeThreadId: "thread-1",
    activeGroupId: groupId,
    activeViewId: "plugin:chat:chat.thread",
    threadPreviewStateById: {
      "thread-1": {
        visible: false,
        activeItemId: null,
        items: [],
      },
    },
    threadRuntimeById: {
      "thread-1": {
        active: true,
        hasMessages: false,
        sessionId: null,
        isRunning: false,
        stopRequested: false,
      },
    },
    provider: "claude",
    availableProviders: [{ id: "claude", label: "Claude" }],
    model: "sonnet",
    availableModels: [
      {
        id: "sonnet",
        label: "Claude Sonnet",
        provider: "claude",
      },
      {
        id: "opus",
        label: "Claude Opus",
        provider: "claude",
      },
    ],
    modelSource: "default",
    availableModelSources: [
      {
        id: "default",
        label: "Default",
        provider: "claude",
      },
    ],
    auth: {
      provider: "claude",
      available: true,
      source: "provider-account",
      label: "Claude Code OAuth",
    },
    runtimeStatus: {
      state: "running",
      detail: "Runtime ready",
      helperPath: null,
    },
    views: [
      {
        id: "plugin:chat:chat.thread",
        title: "Chat",
        description: "Thread-focused chat workspace.",
        icon: "MessagesSquare",
        pluginId: "chat",
        scope: "thread",
        isDefault: true,
        render: {
          kind: "host",
          component: "thread-view",
        },
        hostData: null,
      },
      {
        id: "plugin:extension-lab:extension-lab.home",
        title: "Extension Lab",
        description: "Inspect the new V2 extension runtime and installed plugins.",
        icon: "Blocks",
        pluginId: "extension-lab",
        scope: "workspace",
        isDefault: false,
        render: {
          kind: "host",
          component: "catalog",
        },
        hostData: null,
      },
      {
        id: "plugin:kanban:kanban.board",
        title: "Kanban",
        description: "Manage local chat threads across workflow lanes.",
        icon: "KanbanSquare",
        pluginId: "kanban",
        scope: "workspace",
        isDefault: false,
        render: {
          kind: "host",
          component: "board",
        },
        hostData: null,
      },
    ],
    sidebarPanels: [
      {
        id: "plugin:chat:chat.recent-threads",
        title: "Recent Chats",
        description: "Browse and resume local chat threads.",
        icon: "MessagesSquare",
        pluginId: "chat",
        placement: "content",
        order: 100,
        render: {
          kind: "host",
          component: "recent-threads",
        },
        hostData: null,
      },
    ],
    plugins: [
      {
        id: "kanban",
        name: "Kanban",
        version: "0.1.0",
        description: "Provides a board view for organizing local chat threads.",
        source: "builtin",
        enabled: true,
        disableable: false,
        path: "/tmp/kanban",
        main: "/tmp/kanban/index.ts",
        webviews: [],
        permissions: [],
        settings: null,
        compatibility: {
          currentApiVersion: 1,
          declaredApiVersion: 1,
          minApiVersion: 1,
          compatible: true,
          reason: null,
        },
        capabilities: {
          views: [
            {
              id: "kanban.board",
              title: "Kanban",
              description: "Manage local chat threads across workflow lanes.",
              icon: "KanbanSquare",
              scope: "workspace",
              default: false,
            },
          ],
          sidebarPanels: [],
          commands: [],
          tools: [],
        },
        runtime: {
          activated: true,
          activationError: null,
          subscribedEvents: [],
          registeredViewIds: ["kanban.board"],
          registeredSidebarPanelIds: [],
          registeredCommandIds: [],
          registeredToolIds: [],
        },
      },
      {
        id: "extension-lab",
        name: "Extension Lab",
        version: "0.1.0",
        description: "Inspect the live extension runtime and installed extensions.",
        source: "builtin",
        enabled: true,
        disableable: false,
        path: "/tmp/extension-lab",
        main: "/tmp/extension-lab/index.ts",
        webviews: [],
        permissions: [],
        settings: null,
        compatibility: {
          currentApiVersion: 1,
          declaredApiVersion: 1,
          minApiVersion: 1,
          compatible: true,
          reason: null,
        },
        capabilities: {
          views: [
            {
              id: "extension-lab.home",
              title: "Extension Lab",
              description: "Inspect the new V2 extension runtime and installed plugins.",
              icon: "Blocks",
              scope: "workspace",
              default: false,
            },
          ],
          sidebarPanels: [],
          commands: [],
          tools: [],
        },
        runtime: {
          activated: true,
          activationError: null,
          subscribedEvents: [],
          registeredViewIds: ["extension-lab.home"],
          registeredSidebarPanelIds: [],
          registeredCommandIds: [],
          registeredToolIds: [],
        },
      },
      {
        id: "random-site-preview",
        name: "Random Site Preview",
        version: "0.1.0",
        description: "Pins a stable random site to each chat thread's right preview pane.",
        source: "builtin",
        enabled: true,
        disableable: false,
        path: "/tmp/random-site-preview",
        main: "/tmp/random-site-preview/index.ts",
        webviews: [
          {
            id: "random-site-frame",
            entrypoint: "/tmp/random-site-preview/site/index.html",
          },
        ],
        permissions: [],
        settings: null,
        compatibility: {
          currentApiVersion: 1,
          declaredApiVersion: 1,
          minApiVersion: 1,
          compatible: true,
          reason: null,
        },
        capabilities: {
          views: [],
          sidebarPanels: [],
          commands: [],
          tools: [],
        },
        runtime: {
          activated: true,
          activationError: null,
          subscribedEvents: [],
          registeredViewIds: [],
          registeredSidebarPanelIds: [],
          registeredCommandIds: [],
          registeredToolIds: [],
        },
      },
      {
        id: "thread-journal",
        name: "Thread Journal",
        version: "0.1.0",
        description: "Tracks thread-level extension state through runtime hooks.",
        source: "builtin",
        enabled: true,
        disableable: false,
        path: "/tmp/thread-journal",
        main: "/tmp/thread-journal/index.ts",
        webviews: [],
        permissions: [],
        settings: null,
        compatibility: {
          currentApiVersion: 1,
          declaredApiVersion: 1,
          minApiVersion: 1,
          compatible: true,
          reason: null,
        },
        capabilities: {
          views: [],
          sidebarPanels: [],
          commands: [
            {
              id: "thread-journal.reset",
              title: "Reset Thread Journal",
              description: "Clear stored prompt history for the active thread.",
            },
          ],
          tools: [
            {
              id: "thread-journal.snapshot",
              title: "Thread Journal Snapshot",
              description: "Return the current thread journal snapshot.",
              schema: null,
              availableTo: ["*"],
            },
          ],
        },
        runtime: {
          activated: true,
          activationError: null,
          subscribedEvents: ["before_prompt"],
          registeredViewIds: [],
          registeredSidebarPanelIds: [],
          registeredCommandIds: ["thread-journal.reset"],
          registeredToolIds: ["thread-journal.snapshot"],
        },
      },
    ],
    pendingPermissionRequest: null,
  } as DesktopSnapshot;
}

function createAcpRuntimeEvent(update: Record<string, unknown>): DesktopServerEvent {
  return {
    type: "runtime_event",
    threadId: "thread-1",
    provider: "claude",
    event: {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update,
      },
    },
  };
}

function installDesktopShell(snapshot: DesktopSnapshot) {
  let listener: DesktopShellListener | null = null;
  const shell: MockDesktopShell = {
    platform: "darwin",
    versions: {
      chrome: "1",
      electron: "1",
      node: "1",
    },
    getSnapshot: vi.fn(async () => snapshot),
    resolveWebviewSrc: vi.fn(async (entrypoint: string) =>
      entrypoint.startsWith("/") ? `desktop-plugin://local${entrypoint}` : entrypoint,
    ),
    sendEvent: vi.fn(),
    reportReady: vi.fn(),
    onEvent: vi.fn((nextListener: DesktopShellListener) => {
      listener = nextListener;
      return () => {
        if (listener === nextListener) {
          listener = null;
        }
      };
    }),
  };

  Object.defineProperty(window, "desktopShell", {
    configurable: true,
    writable: true,
    value: shell,
  });

  return {
    shell,
    emit: async (event: DesktopServerEvent) => {
      if (!listener) {
        throw new Error("desktopShell listener is not registered");
      }
      await act(async () => {
        listener?.(event);
        await Promise.resolve();
      });
    },
  };
}

async function renderAppWithShell(snapshot: DesktopSnapshot) {
  vi.resetModules();
  const { shell, emit } = installDesktopShell(snapshot);
  const { App } = await import("../desktop/renderer/src/App");

  render(<App />);

  await waitFor(() => {
    expect(shell.getSnapshot).toHaveBeenCalledTimes(1);
    expect(shell.onEvent).toHaveBeenCalledTimes(1);
  });

  await emit({
    type: "snapshot",
    snapshot,
  });

  await waitFor(() => {
    expect(shell.reportReady).toHaveBeenCalled();
  });

  return { shell, emit };
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    writable: true,
    value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0),
  });
  Object.defineProperty(window, "cancelAnimationFrame", {
    configurable: true,
    writable: true,
    value: (handle: number) => window.clearTimeout(handle),
  });
});

afterEach(() => {
  delete window.desktopShell;
});

describe("desktop container renderer streaming", () => {
  it("does not show the thread chat view as a separate workbench button", async () => {
    const snapshot = createSnapshot();

    await renderAppWithShell(snapshot);

    expect(screen.queryByRole("button", { name: /^Chat$/ })).toBeNull();
    expect(
      screen.getByRole("button", { name: /Extension Lab/ }),
    ).toBeInTheDocument();
  });

  it("focuses the prompt input when the active chat is shown", async () => {
    const snapshot = createSnapshot();

    await renderAppWithShell(snapshot);

    await waitFor(() => {
      expect(screen.getByLabelText("Prompt input")).toHaveFocus();
    });
  });

  it("opens workbench views as a full-page surface with chat hidden", async () => {
    const snapshot = createSnapshot();
    snapshot.tabs.push({
      id: "tab-extension-lab",
      kind: "workspace",
      threadId: null,
      viewId: "plugin:extension-lab:extension-lab.home",
      title: "Extension Lab",
      subtitle: null,
      icon: "Blocks",
      closable: true,
    });
    snapshot.activeTabId = "tab-extension-lab";
    snapshot.activeViewId = "plugin:extension-lab:extension-lab.home";
    snapshot.messagesByThread["thread-1"] = [
      {
        id: "message-1",
        threadId: "thread-1",
        role: "assistant",
        content: "Chat stays visible while the plugin pane is open.",
        createdAt: Date.now(),
        status: "done",
      },
    ];

    await renderAppWithShell(snapshot);

    await waitFor(() => {
      expect(
        screen.getByText("Inspect the live extension runtime and installed extensions."),
      ).toBeInTheDocument();
    });

    expect(screen.queryByText("Chat stays visible while the plugin pane is open.")).toBeNull();
    expect(screen.queryByLabelText("Prompt input")).toBeNull();
  });

  it("renders the kanban workspace view with thread lanes", async () => {
    const snapshot = createSnapshot();
    snapshot.tabs.push({
      id: "tab-kanban",
      kind: "workspace",
      threadId: null,
      viewId: "plugin:kanban:kanban.board",
      title: "Kanban",
      subtitle: null,
      icon: "KanbanSquare",
      closable: true,
    });
    snapshot.activeTabId = "tab-kanban";
    snapshot.activeViewId = "plugin:kanban:kanban.board";

    await renderAppWithShell(snapshot);

    expect(
      screen.getByRole("heading", { name: "Kanban" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Drafts")).toBeInTheDocument();
    expect(screen.getByText("Ready for Review")).toBeInTheDocument();
    expect(screen.getAllByText("Claude test thread").length).toBeGreaterThan(0);
  });

  it("shows running indicators in the sidebar and tab strip for active chats", async () => {
    const snapshot = createSnapshot();
    snapshot.threadRuntimeById["thread-1"] = {
      active: true,
      hasMessages: true,
      sessionId: "session-1",
      isRunning: true,
      stopRequested: false,
    };

    await renderAppWithShell(snapshot);

    expect(screen.getAllByLabelText("Chat running")).toHaveLength(2);
  });

  it("shows unread review indicators in the sidebar and kanban view", async () => {
    const snapshot = createSnapshot();
    snapshot.threads[0] = {
      ...snapshot.threads[0],
      hasUnreadUpdate: true,
      status: "ready_for_review",
      lane: "ready_for_review",
    };
    snapshot.threadRuntimeById["thread-1"] = {
      ...snapshot.threadRuntimeById["thread-1"],
      hasMessages: true,
    };
    snapshot.tabs.push({
      id: "tab-kanban",
      kind: "workspace",
      threadId: null,
      viewId: "plugin:kanban:kanban.board",
      title: "Kanban",
      subtitle: null,
      icon: "KanbanSquare",
      closable: true,
    });
    snapshot.activeTabId = "tab-kanban";
    snapshot.activeViewId = "plugin:kanban:kanban.board";

    await renderAppWithShell(snapshot);

    expect(screen.getByLabelText("New update to review")).toBeInTheDocument();
    expect(screen.getByText("New review")).toBeInTheDocument();
  });

  it("switches back to the default thread view when a chat thread is selected", async () => {
    const snapshot = createSnapshot();
    snapshot.tabs.push({
      id: "tab-extension-lab",
      kind: "workspace",
      threadId: null,
      viewId: "plugin:extension-lab:extension-lab.home",
      title: "Extension Lab",
      subtitle: null,
      icon: "Blocks",
      closable: true,
    });
    snapshot.activeTabId = "tab-extension-lab";
    snapshot.activeViewId = "plugin:extension-lab:extension-lab.home";
    snapshot.messagesByThread["thread-1"] = [
      {
        id: "message-1",
        threadId: "thread-1",
        role: "assistant",
        content: "Chat returns when the thread is selected.",
        createdAt: Date.now(),
        status: "done",
      },
    ];

    const { shell, emit } = await renderAppWithShell(snapshot);

    const sidebarThreadLabel = within(screen.getByRole("complementary")).getByText(
      "Claude test thread",
    );
    const sidebarThreadButton = sidebarThreadLabel.closest("button");
    expect(sidebarThreadButton).not.toBeNull();
    fireEvent.click(sidebarThreadButton!);

    expect(shell.sendEvent).toHaveBeenCalledWith({
      type: "select_thread",
      threadId: "thread-1",
    });

    await emit({
      type: "snapshot",
      snapshot: {
        ...snapshot,
        activeTabId: "tab-thread-1",
        activeViewId: "plugin:chat:chat.thread",
      },
    });

    await waitFor(() => {
      expect(
        screen.getByText("Chat returns when the thread is selected."),
      ).toBeInTheDocument();
    });

    expect(screen.getByLabelText("Prompt input")).toBeInTheDocument();
    expect(
      screen.queryByText("Inspect the live extension runtime and installed extensions."),
    ).toBeNull();
  });

  it("focuses the prompt input after switching from a workspace view back to chat", async () => {
    const snapshot = createSnapshot();
    snapshot.tabs.push({
      id: "tab-extension-lab",
      kind: "workspace",
      threadId: null,
      viewId: "plugin:extension-lab:extension-lab.home",
      title: "Extension Lab",
      subtitle: null,
      icon: "Blocks",
      closable: true,
    });
    snapshot.activeTabId = "tab-extension-lab";
    snapshot.activeViewId = "plugin:extension-lab:extension-lab.home";

    const { emit } = await renderAppWithShell(snapshot);

    const nextSnapshot = {
      ...snapshot,
      activeTabId: "tab-thread-1",
      activeViewId: "plugin:chat:chat.thread",
      activeThreadId: "thread-1",
    };

    await emit({
      type: "snapshot",
      snapshot: nextSnapshot,
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Prompt input")).toHaveFocus();
    });
  });

  it("switches between open tabs from the tab strip", async () => {
    const snapshot = createSnapshot();
    snapshot.tabs.push({
      id: "tab-extension-lab",
      kind: "workspace",
      threadId: null,
      viewId: "plugin:extension-lab:extension-lab.home",
      title: "Extension Lab",
      subtitle: null,
      icon: "Blocks",
      closable: true,
    });
    snapshot.activeTabId = "tab-extension-lab";
    snapshot.activeViewId = "plugin:extension-lab:extension-lab.home";
    snapshot.messagesByThread["thread-1"] = [
      {
        id: "message-1",
        threadId: "thread-1",
        role: "assistant",
        content: "Tab strip switches back to chat.",
        createdAt: Date.now(),
        status: "done",
      },
    ];

    const { shell, emit } = await renderAppWithShell(snapshot);

    fireEvent.click(screen.getByRole("tab", { name: /Claude test thread/ }));

    expect(shell.sendEvent).toHaveBeenCalledWith({
      type: "select_tab",
      tabId: "tab-thread-1",
    });

    await emit({
      type: "snapshot",
      snapshot: {
        ...snapshot,
        activeTabId: "tab-thread-1",
        activeViewId: "plugin:chat:chat.thread",
      },
    });

    await waitFor(() => {
      expect(screen.getByText("Tab strip switches back to chat.")).toBeInTheDocument();
    });
  });

  it("switches tabs with the primary number shortcut", async () => {
    const snapshot = createSnapshot();
    snapshot.tabs.push({
      id: "tab-extension-lab",
      kind: "workspace",
      threadId: null,
      viewId: "plugin:extension-lab:extension-lab.home",
      title: "Extension Lab",
      subtitle: null,
      icon: "Blocks",
      closable: true,
    });

    const { shell } = await renderAppWithShell(snapshot);

    fireEvent.keyDown(window, { key: "2", metaKey: true });

    expect(shell.sendEvent).toHaveBeenCalledWith({
      type: "select_tab",
      tabId: "tab-extension-lab",
    });
  });

  it("cycles tabs with the editor tab shortcut", async () => {
    const snapshot = createSnapshot();
    snapshot.tabs.push({
      id: "tab-extension-lab",
      kind: "workspace",
      threadId: null,
      viewId: "plugin:extension-lab:extension-lab.home",
      title: "Extension Lab",
      subtitle: null,
      icon: "Blocks",
      closable: true,
    });

    const { shell } = await renderAppWithShell(snapshot);

    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });

    expect(shell.sendEvent).toHaveBeenCalledWith({
      type: "select_tab",
      tabId: "tab-extension-lab",
    });
  });

  it("closes the active tab with the primary close shortcut", async () => {
    const snapshot = createSnapshot();
    snapshot.tabs.push({
      id: "tab-extension-lab",
      kind: "workspace",
      threadId: null,
      viewId: "plugin:extension-lab:extension-lab.home",
      title: "Extension Lab",
      subtitle: null,
      icon: "Blocks",
      closable: true,
    });
    snapshot.activeTabId = "tab-extension-lab";
    snapshot.activeViewId = "plugin:extension-lab:extension-lab.home";
    snapshot.messagesByThread["thread-1"] = [
      {
        id: "message-1",
        threadId: "thread-1",
        role: "assistant",
        content: "Close tab returns to the remaining chat tab.",
        createdAt: Date.now(),
        status: "done",
      },
    ];

    const { shell, emit } = await renderAppWithShell(snapshot);

    fireEvent.keyDown(window, { key: "w", metaKey: true });

    expect(shell.sendEvent).toHaveBeenCalledWith({
      type: "close_tab",
      tabId: "tab-extension-lab",
    });

    await emit({
      type: "snapshot",
      snapshot: {
        ...snapshot,
        tabs: [snapshot.tabs[0]],
        activeTabId: "tab-thread-1",
        activeViewId: "plugin:chat:chat.thread",
      },
    });

    await waitFor(() => {
      expect(
        screen.getByText("Close tab returns to the remaining chat tab."),
      ).toBeInTheDocument();
    });
  });

  it("renders the right panel from thread-owned state while chat stays visible", async () => {
    const snapshot = createSnapshot();
    snapshot.threadPreviewStateById["thread-1"] = {
      visible: true,
      activeItemId: "url:https://example.com/preview",
      items: [
        {
          id: "url:https://example.com/preview",
          title: "Random Site Preview",
          target: {
            kind: "url",
            url: "https://example.com/preview",
            title: "Random Site Preview",
          },
          src: "https://example.com/preview",
          contentType: null,
        },
      ],
    };
    snapshot.messagesByThread["thread-1"] = [
      {
        id: "message-1",
        threadId: "thread-1",
        role: "assistant",
        content: "Chat stays visible while the plugin pane is open.",
        createdAt: Date.now(),
        status: "done",
      },
    ];

    await renderAppWithShell(snapshot);

    await waitFor(() => {
      expect(screen.getByTitle("Random Site Preview")).toBeInTheDocument();
    });

    expect(
      screen.getByText("Chat stays visible while the plugin pane is open."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Prompt input")).toBeInTheDocument();
    expect(screen.getByTitle("Random Site Preview")).toHaveAttribute(
      "src",
      "https://example.com/preview",
    );
  });

  it("can render a thread-specific random-site panel in the right pane", async () => {
    const snapshot = createSnapshot();
    snapshot.threadPreviewStateById["thread-1"] = {
      visible: true,
      activeItemId: "url:https://example.com/preview",
      items: [
        {
          id: "url:https://example.com/preview",
          title: "Random Site Preview",
          target: {
            kind: "url",
            url: "https://example.com/preview",
            title: "Random Site Preview",
          },
          src: "https://example.com/preview",
          contentType: null,
        },
      ],
    };

    await renderAppWithShell(snapshot);

    await waitFor(() => {
      expect(
        screen.getByTitle("Random Site Preview"),
      ).toBeInTheDocument();
    });

    expect(
      screen.getByTitle("Random Site Preview"),
    ).toHaveAttribute(
      "src",
      "https://example.com/preview",
    );
  });

  it("renders a plugin-owned custom preview renderer for spreadsheet files", async () => {
    const snapshot = createSnapshot();
    snapshot.threadPreviewStateById["thread-1"] = {
      visible: true,
      activeItemId: "file:workspace:/reports/data.csv",
      items: [
        {
          id: "file:workspace:/reports/data.csv",
          title: "data.csv",
          target: {
            kind: "file",
            source: "workspace",
            path: "/reports/data.csv",
            filename: "data.csv",
            title: "data.csv",
            contentType: "text/csv",
            workspaceId: null,
          },
          src: "desktop-plugin://local/tmp/reports/data.csv",
          contentType: "text/csv",
          renderer: {
            pluginId: "spreadsheet-preview",
            providerId: "plugin:spreadsheet-preview:spreadsheet.table",
            title: "Spreadsheet Preview",
            render: {
              kind: "webview",
              entrypoint: "/tmp/spreadsheet-preview/webviews/spreadsheet-preview.html",
            },
          },
        },
      ],
    };

    await renderAppWithShell(snapshot);

    await waitFor(() => {
      expect(screen.getByTitle("data.csv custom preview")).toBeInTheDocument();
    });

    expect(screen.getByText("Spreadsheet Preview")).toBeInTheDocument();
    expect(screen.getByTitle("data.csv custom preview")).toHaveAttribute(
      "src",
      expect.stringContaining(
        "desktop-plugin://local/tmp/spreadsheet-preview/webviews/spreadsheet-preview.html",
      ),
    );
    expect(screen.getByTitle("data.csv custom preview")).toHaveAttribute(
      "src",
      expect.stringContaining("previewSrc=desktop-plugin%3A%2F%2Flocal%2Ftmp%2Freports%2Fdata.csv"),
    );
  });

  it("keeps the preview iframe mounted while chat messages stream", async () => {
    const snapshot = createSnapshot();
    snapshot.threadPreviewStateById["thread-1"] = {
      visible: true,
      activeItemId: "url:https://example.com/preview",
      items: [
        {
          id: "url:https://example.com/preview",
          title: "Random Site Preview",
          target: {
            kind: "url",
            url: "https://example.com/preview",
            title: "Random Site Preview",
          },
          src: "https://example.com/preview",
          contentType: null,
        },
      ],
    };

    const { emit } = await renderAppWithShell(snapshot);

    await waitFor(() => {
      expect(
        screen.getByTitle("Random Site Preview"),
      ).toBeInTheDocument();
    });

    const iframeBefore = screen.getByTitle("Random Site Preview");

    await emit(
      createAcpRuntimeEvent({
        sessionUpdate: "agent_message_chunk",
        content: "Streaming without replacing the preview.",
      }),
    );

    await waitFor(() => {
      expect(
        screen.getByText("Streaming without replacing the preview."),
      ).toBeInTheDocument();
    });

    expect(screen.getByTitle("Random Site Preview")).toBe(
      iframeBefore,
    );
  });

  it("renders streamed ACP text chunks before the turn finishes", async () => {
    const { emit } = await renderAppWithShell(createSnapshot());

    expect(screen.queryByTestId("text-block")).toBeNull();

    await emit(
      createAcpRuntimeEvent({
        sessionUpdate: "agent_message_chunk",
        content: "Checking now.",
      }),
    );

    await waitFor(() => {
      expect(screen.getByText("Checking now.")).toBeInTheDocument();
      expect(screen.getByTestId("loading-dots")).toBeInTheDocument();
    });

    const textBlocks = screen.getAllByTestId("text-block");
    expect(textBlocks).toHaveLength(1);
    expect(textBlocks[0]).toHaveTextContent("Checking now.");
  });

  it("renders ACP thinking chunks as thinking blocks", async () => {
    const { emit } = await renderAppWithShell(createSnapshot());

    expect(screen.queryByTestId("thinking-block")).toBeNull();

    await emit(
      createAcpRuntimeEvent({
        sessionUpdate: "agent_thought_chunk",
        content: {
          type: "text",
          text: "Comparing tradeoffs before answering.",
        },
      }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("thinking-block")).toHaveTextContent(
        "Comparing tradeoffs before answering.",
      );
    });
  });

  it("keeps later text in a new section after tool activity", async () => {
    const { emit } = await renderAppWithShell(createSnapshot());

    await emit(
      createAcpRuntimeEvent({
        sessionUpdate: "agent_message_chunk",
        content: "Checking now.",
      }),
    );

    await emit(
      createAcpRuntimeEvent({
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "ls",
        rawInput: { path: "." },
      }),
    );

    await emit(
      createAcpRuntimeEvent({
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        rawOutput: "alpha\nbeta",
        status: "completed",
      }),
    );

    await emit(
      createAcpRuntimeEvent({
        sessionUpdate: "agent_message_chunk",
        content: "Done checking.",
      }),
    );

    await waitFor(() => {
      expect(screen.getByText("Done checking.")).toBeInTheDocument();
    });

    const contentBlocks = Array.from(
      screen.getByTestId("content-blocks").children,
    ).map((element) => ({
      kind: element.getAttribute("data-kind"),
      text: element.textContent,
    }));

    expect(contentBlocks).toEqual([
      { kind: "text", text: "Checking now." },
      { kind: "tool_use", text: 'ls:{"path":"."}' },
      { kind: "tool_result", text: "alpha\nbeta" },
      { kind: "text", text: "Done checking." },
    ]);

    const textBlocks = screen.getAllByTestId("text-block");
    expect(textBlocks).toHaveLength(2);
    expect(textBlocks[0]).toHaveTextContent("Checking now.");
    expect(textBlocks[1]).toHaveTextContent("Done checking.");
  });

  it("renders ACP plan session updates as a TodoWrite tool block", async () => {
    const { emit } = await renderAppWithShell(createSnapshot());

    await emit(
      createAcpRuntimeEvent({
        sessionUpdate: "plan",
        entries: [
          { content: "Investigate", status: "in_progress", priority: "medium" },
          { content: "Fix it", status: "pending", priority: "medium" },
        ],
      }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("tool-use-block")).toBeInTheDocument();
    });

    const toolUse = screen.getByTestId("tool-use-block");
    expect(toolUse.textContent).toContain("TodoWrite");
    expect(toolUse.textContent).toContain("Investigate");
    expect(toolUse.textContent).toContain("Fix it");
  });

  it("sends a normal message even while a turn is streaming", async () => {
    const snapshot = createSnapshot();
    snapshot.messagesByThread["thread-1"] = [
      {
        id: "assistant-streaming",
        threadId: "thread-1",
        role: "assistant",
        content: "Working...",
        createdAt: Date.now(),
        status: "streaming",
      },
    ];

    const { shell } = await renderAppWithShell(snapshot);

    fireEvent.change(screen.getByLabelText("Prompt input"), {
      target: { value: "follow up after this" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(shell.sendEvent).toHaveBeenCalledWith({
      type: "send_message",
      threadId: "thread-1",
      content: "follow up after this",
    });
  });

  it("sends /steer content as a normal message", async () => {
    const snapshot = createSnapshot();
    snapshot.messagesByThread["thread-1"] = [
      {
        id: "assistant-streaming",
        threadId: "thread-1",
        role: "assistant",
        content: "Working...",
        createdAt: Date.now(),
        status: "streaming",
      },
    ];

    const { shell } = await renderAppWithShell(snapshot);

    fireEvent.change(screen.getByLabelText("Prompt input"), {
      target: { value: "/steer focus on the failing login test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(shell.sendEvent).toHaveBeenCalledWith({
      type: "send_message",
      threadId: "thread-1",
      content: "/steer focus on the failing login test",
    });
  });

  it("sends stop_thread when the composer stop button is pressed", async () => {
    const snapshot = createSnapshot();
    snapshot.messagesByThread["thread-1"] = [
      {
        id: "assistant-streaming",
        threadId: "thread-1",
        role: "assistant",
        content: "Working...",
        createdAt: Date.now(),
        status: "streaming",
      },
    ];

    const { shell } = await renderAppWithShell(snapshot);

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    expect(shell.sendEvent).toHaveBeenCalledWith({
      type: "stop_thread",
      threadId: "thread-1",
    });
  });
});
