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

export interface DesktopPluginSidebarPanelContribution {
  id: string;
  title: string;
  description: string | null;
  icon: string | null;
  placement: "content" | "footer";
  order: number;
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

export type DesktopPluginPermission =
  | "host-mcp"
  | "host-agent-assets"
  | "host-plugins"
  | "serve-mcp"
  | "thread-preview";

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
    sidebarPanels: DesktopPluginSidebarPanelContribution[];
    commands: DesktopPluginCommandContribution[];
    tools: DesktopPluginToolContribution[];
  };
  runtime: {
    activated: boolean;
    activationError: string | null;
    subscribedEvents: string[];
    registeredViewIds: string[];
    registeredSidebarPanelIds: string[];
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

export interface DesktopSidebarPanel {
  id: string;
  title: string;
  description: string | null;
  icon: string | null;
  pluginId: string | null;
  placement: "content" | "footer";
  order: number;
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

export interface DesktopPreviewRenderer {
  pluginId: string;
  providerId: string;
  title: string | null;
  render: DesktopPluginSurfaceRender;
}

export interface DesktopPreviewItem {
  id: string;
  title: string;
  target: DesktopPreviewTarget;
  src: string | null;
  contentType: string | null;
  renderer?: DesktopPreviewRenderer | null;
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

export interface DesktopThreadGroup {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface DesktopThread {
  id: string;
  groupId: string;
  provider: DesktopProvider;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastMessagePreview: string | null;
  status: string | null;
  lane: string | null;
  archivedAt: number | null;
}

export interface DesktopThreadRuntimeState {
  active: boolean;
  hasMessages: boolean;
  sessionId: string | null;
  isRunning: boolean;
  stopRequested: boolean;
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

export interface DesktopPermissionRequestSecretPrompt {
  kind: "secret_prompt";
  id: string;
  threadId: string | null;
  pluginId: string;
  harness: DesktopHarness;
  secretRef: string;
  title: string;
  message: string | null;
  fieldLabel: string | null;
}

export interface DesktopPermissionRequestPluginMutation {
  kind: "plugin_mutation";
  id: string;
  threadId: string | null;
  pluginId: string;
  harness: DesktopHarness;
  action: "install" | "update";
  targetPluginId: string;
  targetPluginName: string | null;
  sourcePath: string;
  version: string | null;
}

export interface DesktopPermissionRequestAgentAssetMutation {
  kind: "agent_asset_mutation";
  id: string;
  threadId: string | null;
  pluginId: string;
  harness: DesktopHarness;
  action: "install" | "update" | "delete";
  targetPluginId: string;
  targetPluginName: string | null;
  provider: DesktopProvider;
  installSkills: boolean;
  installMcpServers: boolean;
  skillIds: string[];
  mcpServerIds: string[];
}

export type DesktopPermissionRequest =
  | DesktopPermissionRequestHostMcpMutation
  | DesktopPermissionRequestSecretPrompt
  | DesktopPermissionRequestPluginMutation
  | DesktopPermissionRequestAgentAssetMutation;

export interface DesktopSnapshot {
  threadGroups: DesktopThreadGroup[];
  threads: DesktopThread[];
  messagesByThread: Record<string, DesktopMessage[]>;
  tabs: DesktopTab[];
  activeTabId: string | null;
  activeThreadId: string | null;
  activeGroupId: string | null;
  activeViewId: string | null;
  threadPreviewStateById: Record<string, DesktopThreadPreviewState>;
  threadRuntimeById: Record<string, DesktopThreadRuntimeState>;
  provider: DesktopProvider;
  availableProviders: DesktopProviderOption[];
  model: DesktopModel;
  availableModels: DesktopModelOption[];
  auth: DesktopAuthState;
  runtimeStatus: DesktopRuntimeStatus;
  views: DesktopView[];
  sidebarPanels: DesktopSidebarPanel[];
  plugins: DesktopPluginRecord[];
  pendingPermissionRequest: DesktopPermissionRequest | null;
}

export interface DesktopStartupDiagnostic {
  at: number;
  stage: string;
  detail?: string;
}

export type DesktopShellCommand =
  | "new_chat"
  | "open_settings"
  | "toggle_sidebar"
  | "close_tab"
  | "next_tab"
  | "previous_tab";

export type DesktopClientEvent =
  | {
      type: "create_group";
      title?: string;
    }
  | {
      type: "select_group";
      groupId: string;
    }
  | {
      type: "update_group";
      groupId: string;
      title: string;
    }
  | {
      type: "delete_group";
      groupId: string;
    }
  | {
      type: "create_thread";
      title?: string;
      groupId?: string;
      status?: string | null;
      lane?: string | null;
      archivedAt?: number | null;
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
      type: "update_thread";
      threadId: string;
      updates: {
        title?: string | null;
        groupId?: string | null;
        status?: string | null;
        lane?: string | null;
        archivedAt?: number | null;
      };
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
      secretValue?: string | null;
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
