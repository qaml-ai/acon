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
  }: {
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    onStop?: () => void;
    placeholder?: string;
    isAssistantRunning?: boolean;
  }) => (
    <div>
      <textarea
        aria-label="Prompt input"
        placeholder={placeholder}
        value={value}
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
  return {
    threads: [
      {
        id: "thread-1",
        provider: "claude",
        title: "Claude test thread",
        createdAt: now,
        updatedAt: now,
        lastMessagePreview: null,
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
        viewId: "plugin:chat-core:chat-core.thread",
        title: "Claude test thread",
        subtitle: null,
        icon: "MessagesSquare",
        closable: true,
      },
    ],
    activeTabId: "tab-thread-1",
    activeThreadId: "thread-1",
    activeViewId: "plugin:chat-core:chat-core.thread",
    threadPanelStateById: {
      "thread-1": {
        panelId: null,
        visible: false,
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
        id: "plugin:chat-core:chat-core.thread",
        title: "Chat",
        description: "Thread-focused chat workspace.",
        icon: "MessagesSquare",
        pluginId: "chat-core",
        scope: "thread",
        isDefault: true,
        render: {
          kind: "host",
          component: "chat-thread",
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
          component: "extension-catalog",
        },
        hostData: null,
      },
    ],
    panels: [
      {
        id: "plugin:random-site-preview:random-site-preview.frame",
        title: "Random Site Preview",
        description: "Shows a thread-specific random website.",
        icon: "Globe",
        pluginId: "random-site-preview",
        autoOpen: "all-threads",
        render: {
          kind: "webview",
          entrypoint: "/tmp/random-site-preview/site/index.html",
        },
        hostData: null,
      },
    ],
    plugins: [
      {
        id: "chat-core",
        name: "Chat",
        version: "0.1.0",
        description: "Provides the primary thread chat workbench view.",
        source: "builtin",
        enabled: true,
        path: "/tmp/chat-core",
        main: "/tmp/chat-core/index.ts",
        webviews: [],
        capabilities: {
          views: [
            {
              id: "chat-core.thread",
              title: "Chat",
              description: "Thread-focused chat workspace.",
              icon: "MessagesSquare",
              scope: "thread",
              default: true,
            },
          ],
          panels: [],
          commands: [],
          tools: [],
        },
        runtime: {
          activated: true,
          activationError: null,
          subscribedEvents: [],
          registeredViewIds: ["chat-core.thread"],
          registeredPanelIds: [],
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
        path: "/tmp/extension-lab",
        main: "/tmp/extension-lab/index.ts",
        webviews: [],
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
          panels: [],
          commands: [],
          tools: [],
        },
        runtime: {
          activated: true,
          activationError: null,
          subscribedEvents: [],
          registeredViewIds: ["extension-lab.home"],
          registeredPanelIds: [],
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
        path: "/tmp/random-site-preview",
        main: "/tmp/random-site-preview/index.ts",
        webviews: [
          {
            id: "random-site-frame",
            entrypoint: "/tmp/random-site-preview/site/index.html",
          },
        ],
        capabilities: {
          views: [],
          panels: [
            {
              id: "random-site-preview.frame",
              title: "Random Site Preview",
              description: "Shows a thread-specific random website.",
              icon: "Globe",
              autoOpen: "all-threads",
            },
          ],
          commands: [],
          tools: [],
        },
        runtime: {
          activated: true,
          activationError: null,
          subscribedEvents: [],
          registeredViewIds: [],
          registeredPanelIds: ["random-site-preview.frame"],
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
        path: "/tmp/thread-journal",
        main: "/tmp/thread-journal/index.ts",
        webviews: [],
        capabilities: {
          views: [],
          panels: [],
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
          registeredPanelIds: [],
          registeredCommandIds: ["thread-journal.reset"],
          registeredToolIds: ["thread-journal.snapshot"],
        },
      },
    ],
    pendingPermissionRequest: null,
  };
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
        activeViewId: "plugin:chat-core:chat-core.thread",
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
        activeViewId: "plugin:chat-core:chat-core.thread",
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
        activeViewId: "plugin:chat-core:chat-core.thread",
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
    snapshot.threadPanelStateById["thread-1"] = {
      panelId: "plugin:random-site-preview:random-site-preview.frame",
      visible: true,
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
      expect(screen.getByTitle("Random Site Preview plugin webview")).toBeInTheDocument();
    });

    expect(
      screen.getByText("Chat stays visible while the plugin pane is open."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Prompt input")).toBeInTheDocument();
    expect(screen.getByTitle("Random Site Preview plugin webview")).toHaveAttribute(
      "src",
      "desktop-plugin://local/tmp/random-site-preview/site/index.html?threadId=thread-1&pluginId=random-site-preview&surfaceId=plugin%3Arandom-site-preview%3Arandom-site-preview.frame&surface=companion",
    );
  });

  it("can render a thread-specific random-site panel in the right pane", async () => {
    const snapshot = createSnapshot();
    snapshot.threadPanelStateById["thread-1"] = {
      panelId: "plugin:random-site-preview:random-site-preview.frame",
      visible: true,
    };

    await renderAppWithShell(snapshot);

    await waitFor(() => {
      expect(
        screen.getByTitle("Random Site Preview plugin webview"),
      ).toBeInTheDocument();
    });

    expect(
      screen.getByTitle("Random Site Preview plugin webview"),
    ).toHaveAttribute(
      "src",
      "desktop-plugin://local/tmp/random-site-preview/site/index.html?threadId=thread-1&pluginId=random-site-preview&surfaceId=plugin%3Arandom-site-preview%3Arandom-site-preview.frame&surface=companion",
    );
  });

  it("keeps the companion webview mounted while chat messages stream", async () => {
    const snapshot = createSnapshot();
    snapshot.threadPanelStateById["thread-1"] = {
      panelId: "plugin:random-site-preview:random-site-preview.frame",
      visible: true,
    };

    const { emit } = await renderAppWithShell(snapshot);

    await waitFor(() => {
      expect(
        screen.getByTitle("Random Site Preview plugin webview"),
      ).toBeInTheDocument();
    });

    const iframeBefore = screen.getByTitle("Random Site Preview plugin webview");

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

    expect(screen.getByTitle("Random Site Preview plugin webview")).toBe(
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
