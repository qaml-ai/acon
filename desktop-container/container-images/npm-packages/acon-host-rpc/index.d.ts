export const DEFAULT_HOST_RPC_SOCKET_PATH: "/data/host-rpc/bridge.sock";
export const DEFAULT_HOST_RPC_TIMEOUT_MS: 30000;
export const DEFAULT_MCP_PROTOCOL_VERSION: "2025-03-26";
export const DEFAULT_MCP_CLIENT_INFO: Readonly<{
  name: "@acon/host-rpc";
  version: "1.0.0";
}>;

export type JsonRpcId = string | number | null;

export interface JsonRpcErrorObject {
  code?: string | number | null;
  message?: string;
  data?: unknown;
}

export interface JsonRpcRequestMessage {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcResultMessage<TResult = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: TResult;
}

export interface JsonRpcErrorMessage {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export type JsonRpcMessage =
  | JsonRpcRequestMessage
  | JsonRpcResultMessage
  | JsonRpcErrorMessage;

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

export interface HostRpcMcpCloseResponse {
  ok: boolean;
}

export interface HostRpcMcpClientInfo {
  name?: string;
  version?: string;
}

export interface HostRpcListMcpToolsOptions {
  sessionId?: string;
  protocolVersion?: string;
  clientInfo?: HostRpcMcpClientInfo;
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
  readonly socketPath: string;
  readonly timeoutMs: number;
  request<TResult = unknown>(method: string, params?: unknown): Promise<TResult>;
  ping(params?: unknown): Promise<HostRpcPingResponse>;
  fetch(params: HostRpcFetchRequest): Promise<HostRpcFetchResponse>;
  listMcpServers(): Promise<HostMcpServerSummary[]>;
  mcpRequest(
    serverId: string,
    sessionId: string,
    message: JsonRpcMessage,
  ): Promise<JsonRpcMessage[]>;
  closeMcpSession(
    serverId: string,
    sessionId: string,
  ): Promise<HostRpcMcpCloseResponse>;
  listMcpTools(
    serverId: string,
    options?: HostRpcListMcpToolsOptions,
  ): Promise<HostMcpToolSummary[]>;
}
