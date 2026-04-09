import type { ContentBlock } from "../../src/types";

export type DesktopProvider = "claude" | "codex";
export type DesktopModel = string;
export type DesktopAuthSource = "provider-account" | "api-key" | "missing";
export type DesktopHarness = "opencode" | "claude-code" | "codex";

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

export interface DesktopPluginViewContribution {
  id: string;
  title: string;
  description: string | null;
  icon: string | null;
  scope: "thread" | "workspace";
  default: boolean;
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

export type DesktopPluginPermission = "host-mcp" | "serve-mcp" | "thread-preview";

export type DesktopPluginSettingFieldType =
  | "boolean"
  | "number"
  | "secret"
  | "select"
  | "string";

export interface DesktopPluginSettingFieldOption {
  label: string;
  value: string;
}

export interface DesktopPluginSettingFieldRecord {
  id: string;
  type: DesktopPluginSettingFieldType;
  label: string;
  description: string | null;
  required: boolean;
  options: DesktopPluginSettingFieldOption[];
}

export interface DesktopPluginSettingsRecord {
  description: string | null;
  fields: DesktopPluginSettingFieldRecord[];
}

export interface DesktopPluginCompatibility {
  currentApiVersion: number;
  declaredApiVersion: number;
  minApiVersion: number;
  compatible: boolean;
  reason: string | null;
}

export interface DesktopPluginRecord {
  id: string;
  name: string;
  version: string;
  description: string | null;
  source: "builtin" | "user";
  enabled: boolean;
  disableable: boolean;
  path: string;
  main: string | null;
  webviews: DesktopPluginWebviewContribution[];
  permissions: DesktopPluginPermission[];
  settings: DesktopPluginSettingsRecord | null;
  compatibility: DesktopPluginCompatibility;
  capabilities: {
    views: DesktopPluginViewContribution[];
    commands: DesktopPluginCommandContribution[];
    tools: DesktopPluginToolContribution[];
  };
  runtime: {
    activated: boolean;
    activationError: string | null;
    subscribedEvents: string[];
    registeredViewIds: string[];
    registeredCommandIds: string[];
    registeredToolIds: string[];
  };
}

export interface DesktopPluginInstallResult {
  status: "installed" | "cancelled";
  pluginId: string | null;
  pluginName: string | null;
  installPath: string | null;
  replaced: boolean;
}

export interface DesktopView {
  id: string;
  title: string;
  description: string | null;
  icon: string | null;
  pluginId: string | null;
  scope: "thread" | "workspace";
  isDefault: boolean;
  render: DesktopPluginSurfaceRender;
  hostData?: DesktopPluginHostPanelData | null;
}

export type DesktopPreviewTarget =
  | {
      kind: "file";
      source: "workspace" | "upload" | "output";
      workspaceId?: string | null;
      path: string;
      filename?: string | null;
      title?: string | null;
      contentType?: string | null;
    }
  | {
      kind: "url";
      url: string;
      title?: string | null;
    };

export interface DesktopPreviewItem {
  id: string;
  title: string;
  target: DesktopPreviewTarget;
  src: string | null;
  contentType: string | null;
}

export interface DesktopThreadPreviewState {
  visible: boolean;
  activeItemId: string | null;
  items: DesktopPreviewItem[];
}

export interface DesktopTab {
  id: string;
  kind: "thread" | "workspace";
  threadId: string | null;
  viewId: string;
  title: string;
  subtitle: string | null;
  icon: string | null;
  closable: boolean;
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

export interface DesktopThreadMetadata {
  status: string | null;
  lane: string | null;
  archived: boolean;
  archivedAt: number | null;
}

export interface DesktopThread {
  id: string;
  provider: DesktopProvider;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastMessagePreview: string | null;
  metadata: DesktopThreadMetadata;
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

export interface DesktopPermissionRequestHostMcpMutation {
  kind: "host_mcp_mutation";
  id: string;
  threadId: string | null;
  pluginId: string;
  harness: DesktopHarness;
  action: "create" | "update" | "delete";
  serverId: string;
  transport: "stdio" | "streamable-http" | "sse";
  command: string | null;
  args: string[];
  cwd: string | null;
  url: string | null;
  name: string | null;
  version: string | null;
}

export type DesktopPermissionRequest = DesktopPermissionRequestHostMcpMutation;

export interface DesktopSnapshot {
  threads: DesktopThread[];
  messagesByThread: Record<string, DesktopMessage[]>;
  tabs: DesktopTab[];
  activeTabId: string | null;
  activeThreadId: string | null;
  activeViewId: string | null;
  threadPreviewStateById: Record<string, DesktopThreadPreviewState>;
  provider: DesktopProvider;
  availableProviders: DesktopProviderOption[];
  model: DesktopModel;
  availableModels: DesktopModelOption[];
  auth: DesktopAuthState;
  runtimeStatus: DesktopRuntimeStatus;
  views: DesktopView[];
  plugins: DesktopPluginRecord[];
  pendingPermissionRequest: DesktopPermissionRequest | null;
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
      type: "select_view";
      viewId: string;
    }
  | {
      type: "select_tab";
      tabId: string;
    }
  | {
      type: "close_tab";
      tabId: string;
    }
  | {
      type: "preview_open_item";
      threadId: string;
      item: DesktopPreviewTarget;
    }
  | {
      type: "preview_set_items";
      threadId: string;
      items: DesktopPreviewTarget[];
      activeItemId?: string | null;
    }
  | {
      type: "preview_select_item";
      threadId: string;
      itemId: string;
    }
  | {
      type: "preview_close_item";
      threadId: string;
      itemId: string;
    }
  | {
      type: "preview_clear";
      threadId: string;
    }
  | {
      type: "preview_set_visibility";
      threadId: string;
      visible: boolean;
    }
  | {
      type: "send_message";
      threadId: string;
      content: string;
    }
  | {
      type: "stop_thread";
      threadId: string;
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
      type: "refresh_plugins";
    }
  | {
      type: "set_plugin_enabled";
      pluginId: string;
      enabled: boolean;
    }
  | {
      type: "ping";
    }
  | {
      type: "respond_permission_request";
      requestId: string;
      decision: "approve" | "deny";
    };

export type DesktopServerEvent =
  | {
      type: "snapshot";
      snapshot: DesktopSnapshot;
    }
  | {
      type: "permission_request";
      request: DesktopPermissionRequest;
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
