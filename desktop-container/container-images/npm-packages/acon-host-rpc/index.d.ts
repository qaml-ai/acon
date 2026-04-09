export const DEFAULT_HOST_RPC_SOCKET_PATH: "/data/host-rpc/bridge.sock";
export const DEFAULT_HOST_RPC_TIMEOUT_MS: 30000;
export const DEFAULT_MCP_PROTOCOL_VERSION: "2025-03-26";
export const DEFAULT_MCP_CLIENT_VERSION: "0.1.0";
export const DEFAULT_MCP_CLIENT_INFO: Readonly<{
  name: "@acon/host-rpc";
  version: typeof DEFAULT_MCP_CLIENT_VERSION;
}>;

export interface HostRpcClientOptions {
  env?: NodeJS.ProcessEnv;
  socketPath?: string;
  timeoutMs?: number;
}

export interface HostRpcPingResponse {
  ok: boolean;
  now: string;
  pid: number;
  params?: unknown;
}

export interface HostRpcFetchRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBodyBytes?: number;
}

export interface HostRpcFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
}

export interface HostMcpServerSummary {
  id: string;
  name: string | null;
  version: string | null;
  description: string | null;
  pluginId: string | null;
  source: "host" | "plugin";
}

export interface HostMcpToolSummary {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface HostRpcMcpClientInfo {
  name?: string;
  version?: string;
}

export interface HostRpcMcpRequestOptions {
  protocolVersion?: string;
  clientInfo?: HostRpcMcpClientInfo;
}

export type HostRpcListMcpToolsOptions = HostRpcMcpRequestOptions;
export type HostRpcCallMcpToolOptions = HostRpcMcpRequestOptions;
export type HostRpcListMcpPromptsOptions = HostRpcMcpRequestOptions;
export type HostRpcGetMcpPromptOptions = HostRpcMcpRequestOptions;
export type HostRpcListMcpResourcesOptions = HostRpcMcpRequestOptions;
export type HostRpcListMcpResourceTemplatesOptions = HostRpcMcpRequestOptions;
export type HostRpcReadMcpResourceOptions = HostRpcMcpRequestOptions;

export interface HostMcpPromptArgumentSummary {
  name: string;
  title?: string;
  description?: string;
  required?: boolean;
}

export interface HostMcpPromptSummary {
  name: string;
  title?: string;
  description?: string;
  arguments?: HostMcpPromptArgumentSummary[];
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface HostMcpContentBlock {
  type: string;
  [key: string]: unknown;
}

export interface HostMcpPromptMessage {
  role: string;
  content: HostMcpContentBlock;
}

export interface HostMcpPromptResult {
  description?: string;
  messages: HostMcpPromptMessage[];
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface HostMcpResourceSummary {
  name: string;
  title?: string;
  uri: string;
  description?: string;
  mimeType?: string;
  annotations?: Record<string, unknown>;
  size?: number;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface HostMcpResourceTemplateSummary {
  name: string;
  title?: string;
  uriTemplate: string;
  description?: string;
  mimeType?: string;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface HostMcpTextResourceContents {
  uri: string;
  mimeType?: string;
  text: string;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface HostMcpBlobResourceContents {
  uri: string;
  mimeType?: string;
  blob: string;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface HostMcpReadResourceResult {
  contents: Array<HostMcpTextResourceContents | HostMcpBlobResourceContents>;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface HostRpcMcpSession {
  serverId: string;
  listTools(): Promise<HostMcpToolSummary[]>;
  callTool<TResult = unknown>(
    toolName: string,
    toolArguments?: unknown,
  ): Promise<TResult | null>;
  listPrompts(): Promise<HostMcpPromptSummary[]>;
  getPrompt(
    promptName: string,
    promptArguments?: Record<string, string>,
  ): Promise<HostMcpPromptResult | null>;
  listResources(): Promise<HostMcpResourceSummary[]>;
  listResourceTemplates(): Promise<HostMcpResourceTemplateSummary[]>;
  readResource(uri: string): Promise<HostMcpReadResourceResult | null>;
}

export class HostRpcError extends Error {
  code: string | null;
  method: string | null;
  constructor(
    message: string,
    options?: {
      code?: string | null;
      method?: string | null;
    },
  );
}

export function resolveHostRpcSocketPath(env?: NodeJS.ProcessEnv): string;
export function resolveHostRpcTimeoutMs(env?: NodeJS.ProcessEnv): number;
export function createHostRpcClient(options?: HostRpcClientOptions): HostRpcClient;

export class HostRpcClient {
  constructor(options?: HostRpcClientOptions);
  socketPath: string;
  timeoutMs: number;
  request<TResult = unknown>(method: string, params?: unknown): Promise<TResult>;
  ping(params?: unknown): Promise<HostRpcPingResponse>;
  fetch(params: HostRpcFetchRequest): Promise<HostRpcFetchResponse>;
  listMcpServers(): Promise<HostMcpServerSummary[]>;
  withMcpSession<TResult = unknown>(
    serverId: string,
    callback: (session: HostRpcMcpSession) => Promise<TResult> | TResult,
    options?: HostRpcMcpRequestOptions,
  ): Promise<TResult>;
  listMcpTools(
    serverId: string,
    options?: HostRpcListMcpToolsOptions,
  ): Promise<HostMcpToolSummary[]>;
  callMcpTool<TResult = unknown>(
    serverId: string,
    toolName: string,
    toolArguments?: unknown,
    options?: HostRpcCallMcpToolOptions,
  ): Promise<TResult | null>;
  listMcpPrompts(
    serverId: string,
    options?: HostRpcListMcpPromptsOptions,
  ): Promise<HostMcpPromptSummary[]>;
  getMcpPrompt(
    serverId: string,
    promptName: string,
    promptArguments?: Record<string, string>,
    options?: HostRpcGetMcpPromptOptions,
  ): Promise<HostMcpPromptResult | null>;
  listMcpResources(
    serverId: string,
    options?: HostRpcListMcpResourcesOptions,
  ): Promise<HostMcpResourceSummary[]>;
  listMcpResourceTemplates(
    serverId: string,
    options?: HostRpcListMcpResourceTemplatesOptions,
  ): Promise<HostMcpResourceTemplateSummary[]>;
  readMcpResource(
    serverId: string,
    uri: string,
    options?: HostRpcReadMcpResourceOptions,
  ): Promise<HostMcpReadResourceResult | null>;
}
