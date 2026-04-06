import type { ContentBlock } from "../../src/types";

export type DesktopProvider = "claude" | "codex" | "agentos";
export type DesktopModel = string;
export type DesktopAuthSource = "provider-account" | "api-key" | "missing";
export type DesktopHarness = "pi" | "opencode" | "claude-code" | "codex";

export interface DesktopPluginSurfaceRender {
  kind: "host" | "webview";
  component?: string;
  entrypoint?: string;
}

export interface DesktopPluginHostPanelItem {
  label: string;
  value: string;
}

export interface DesktopPluginHostPanelSection {
  id: string;
  title: string;
  description: string | null;
  items: DesktopPluginHostPanelItem[];
}

export interface DesktopPluginHostPanelData {
  sections: DesktopPluginHostPanelSection[];
}

export interface DesktopPluginPageContribution {
  id: string;
  title: string;
  description: string | null;
  icon: string | null;
}

export interface DesktopPluginPreviewContribution
  extends DesktopPluginPageContribution {
  autoOpen: "never" | "new-thread" | "all-threads";
}

export interface DesktopPluginCommandContribution {
  id: string;
  title: string;
  description: string | null;
}

export interface DesktopPluginToolContribution {
  id: string;
  title: string | null;
  description: string | null;
  schema: string | null;
  availableTo: Array<DesktopHarness | "*">;
}

export interface DesktopPluginWebviewContribution {
  id: string;
  entrypoint: string;
}

export interface DesktopPluginRecord {
  id: string;
  name: string;
  version: string;
  description: string | null;
  source: "builtin" | "user";
  enabled: boolean;
  path: string;
  main: string | null;
  webviews: DesktopPluginWebviewContribution[];
  capabilities: {
    pages: DesktopPluginPageContribution[];
    previewPanes: DesktopPluginPreviewContribution[];
    commands: DesktopPluginCommandContribution[];
    tools: DesktopPluginToolContribution[];
  };
  runtime: {
    activated: boolean;
    activationError: string | null;
    subscribedEvents: string[];
    registeredPageIds: string[];
    registeredPreviewPaneIds: string[];
    registeredCommandIds: string[];
    registeredToolIds: string[];
  };
}

export interface DesktopPage {
  id: string;
  title: string;
  description: string | null;
  icon: string | null;
  pluginId: string | null;
  surface: "page" | "preview";
  render: DesktopPluginSurfaceRender;
  hostData?: DesktopPluginHostPanelData | null;
}

export interface DesktopThreadPreviewPaneState {
  pageId: string | null;
  visible: boolean;
}

export interface DesktopProviderOption {
  id: DesktopProvider;
  label: string;
}

export interface DesktopModelOption {
  id: DesktopModel;
  label: string;
  provider: DesktopProvider;
}

export interface DesktopAuthState {
  provider: DesktopProvider;
  available: boolean;
  source: DesktopAuthSource;
  label: string;
}

export interface DesktopThread {
  id: string;
  provider: DesktopProvider;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastMessagePreview: string | null;
}

export interface DesktopMessage {
  id: string;
  threadId: string;
  role: "user" | "assistant" | "system";
  content: string | ContentBlock[];
  createdAt: number;
  status: "done" | "streaming" | "error";
  isMeta?: boolean;
  sourceToolUseID?: string;
}

export interface DesktopRuntimeStatus {
  state: "unavailable" | "stopped" | "starting" | "running" | "error";
  detail: string;
  helperPath: string | null;
  prepared?: boolean;
  runtimeDirectory?: string | null;
  containerID?: string | null;
  controlPlaneAddress?: string | null;
  controlPlanePort?: number | null;
  imageReference?: string | null;
}

export interface DesktopSnapshot {
  threads: DesktopThread[];
  messagesByThread: Record<string, DesktopMessage[]>;
  activeThreadId: string | null;
  activePluginPageId: string | null;
  threadPreviewStateById: Record<string, DesktopThreadPreviewPaneState>;
  provider: DesktopProvider;
  availableProviders: DesktopProviderOption[];
  model: DesktopModel;
  availableModels: DesktopModelOption[];
  auth: DesktopAuthState;
  runtimeStatus: DesktopRuntimeStatus;
  pages: DesktopPage[];
  plugins: DesktopPluginRecord[];
}

export interface DesktopStartupDiagnostic {
  at: number;
  stage: string;
  detail?: string;
}

export type DesktopClientEvent =
  | {
      type: "create_thread";
      title?: string;
    }
  | {
      type: "select_thread";
      threadId: string;
    }
  | {
      type: "select_plugin_page";
      pageId: string;
    }
  | {
      type: "open_thread_preview";
      threadId: string;
      pageId: string;
    }
  | {
      type: "close_thread_preview";
      threadId: string;
    }
  | {
      type: "send_message";
      threadId: string;
      content: string;
    }
  | {
      type: "set_provider";
      provider: DesktopProvider;
    }
  | {
      type: "set_model";
      model: DesktopModel;
    }
  | {
      type: "ping";
    };

export type DesktopServerEvent =
  | {
      type: "snapshot";
      snapshot: DesktopSnapshot;
    }
  | {
      type: "diagnostic";
      diagnostic: DesktopStartupDiagnostic;
    }
  | {
      type: "assistant_delta";
      threadId: string;
      messageId: string;
      delta: string;
    }
  | {
      type: "runtime_event";
      threadId: string;
      provider: DesktopProvider;
      event: unknown;
    }
  | {
      type: "error";
      message: string;
      threadId?: string;
    }
  | {
      type: "pong";
      now: number;
    };
