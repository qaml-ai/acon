import type { DesktopProvider } from "../../desktop/shared/protocol";

export const ACON_RUNTIME_PROTOCOL_VERSION = 2;

export type RuntimeHostToRuntimeMethod =
  | "ping"
  | "session.ensure"
  | "session.prompt"
  | "session.cancel";

export type RuntimeRuntimeToHostMethod =
  | "ping"
  | "fetch"
  | "mcp.request"
  | "mcp.close"
  | "mcp.list_servers";

export type RuntimeNotificationMethod = "session.delta" | "session.runtime_event";

export interface RuntimePingParams {
  [key: string]: unknown;
}

export interface RuntimePingResult {
  ok: true;
  now: string;
  pid?: number;
  containerName?: string;
  params?: unknown;
}

export interface RuntimeSessionEnsureParams {
  provider: DesktopProvider;
  sessionName: string;
  model: string;
  sessionId: string | null;
}

export interface RuntimeSessionEnsureResult {
  ok?: boolean;
}

export interface RuntimeSessionPromptParams {
  provider: DesktopProvider;
  sessionName: string;
  content: string;
  model: string;
  sessionId: string | null;
}

export interface RuntimeSessionPromptResult {
  sessionId?: string;
  finalText?: string;
  stopReason?: string | null;
}

export interface RuntimeSessionCancelParams {
  provider: DesktopProvider;
  sessionName: string;
  model: string;
}

export interface RuntimeSessionCancelResult {
  ok?: boolean;
}

export interface RuntimeSessionDeltaNotificationParams {
  sessionName: string;
  delta: string;
}

export interface RuntimeSessionRuntimeEventNotificationParams {
  sessionName: string;
  event: unknown;
}

export interface RuntimeHostFetchParams {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBodyBytes?: number;
}

export interface RuntimeHostFetchResult {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
}

export interface RuntimeHostMcpRequestParams {
  serverId: string;
  sessionId: string;
  message: Record<string, unknown>;
}

export interface RuntimeHostMcpCloseParams {
  serverId: string;
  sessionId: string;
}

export interface RuntimeHostMcpListServersResult {
  id: string;
  name: string;
  version: string | null;
  description: string | null;
}

export interface RuntimeReadyEnvelope {
  type: "ready";
  protocolVersion: number;
  socketPath?: string;
}

export interface RuntimeRequestEnvelope<
  TMethod extends string = string,
  TParams = unknown,
> {
  type: "request";
  id: string;
  method: TMethod;
  params?: TParams;
}

export interface RuntimeResponseEnvelope<TResult = unknown> {
  type: "response";
  id: string;
  result?: TResult;
  error?: {
    code?: string;
    message?: string;
  };
}

export interface RuntimeNotificationEnvelope<
  TMethod extends RuntimeNotificationMethod = RuntimeNotificationMethod,
  TParams = unknown,
> {
  type: "notification";
  method: TMethod;
  params?: TParams;
}

export type RuntimeProtocolEnvelope =
  | RuntimeReadyEnvelope
  | RuntimeRequestEnvelope
  | RuntimeResponseEnvelope
  | RuntimeNotificationEnvelope;

export interface RuntimeHostToRuntimeParamsMap {
  ping: RuntimePingParams;
  "session.ensure": RuntimeSessionEnsureParams;
  "session.prompt": RuntimeSessionPromptParams;
  "session.cancel": RuntimeSessionCancelParams;
}

export interface RuntimeHostToRuntimeResultsMap {
  ping: RuntimePingResult;
  "session.ensure": RuntimeSessionEnsureResult;
  "session.prompt": RuntimeSessionPromptResult;
  "session.cancel": RuntimeSessionCancelResult;
}

export interface RuntimeRuntimeToHostParamsMap {
  ping: RuntimePingParams;
  fetch: RuntimeHostFetchParams;
  "mcp.request": RuntimeHostMcpRequestParams;
  "mcp.close": RuntimeHostMcpCloseParams;
  "mcp.list_servers": Record<string, never>;
}

export interface RuntimeRuntimeToHostResultsMap {
  ping: RuntimePingResult;
  fetch: RuntimeHostFetchResult;
  "mcp.request": unknown;
  "mcp.close": { ok: true };
  "mcp.list_servers": RuntimeHostMcpListServersResult[];
}

export interface RuntimeNotificationParamsMap {
  "session.delta": RuntimeSessionDeltaNotificationParams;
  "session.runtime_event": RuntimeSessionRuntimeEventNotificationParams;
}

export interface RuntimeProtocolRequestOptions {
  timeoutMs?: number;
}

export interface RuntimeProtocolTransport {
  request<TMethod extends RuntimeHostToRuntimeMethod>(
    method: TMethod,
    params: RuntimeHostToRuntimeParamsMap[TMethod],
    options?: RuntimeProtocolRequestOptions,
  ): Promise<RuntimeHostToRuntimeResultsMap[TMethod]>;
  close?(): Promise<void> | void;
}

export class RuntimeProtocolClient {
  constructor(private readonly transport: RuntimeProtocolTransport) {}

  async ping(params: RuntimePingParams = {}): Promise<RuntimePingResult> {
    return await this.transport.request("ping", params);
  }

  async ensureSession(
    params: RuntimeSessionEnsureParams,
    options?: RuntimeProtocolRequestOptions,
  ): Promise<RuntimeSessionEnsureResult> {
    return await this.transport.request("session.ensure", params, options);
  }

  async promptSession(
    params: RuntimeSessionPromptParams,
    options?: RuntimeProtocolRequestOptions,
  ): Promise<RuntimeSessionPromptResult> {
    return await this.transport.request("session.prompt", params, options);
  }

  async cancelSession(
    params: RuntimeSessionCancelParams,
    options?: RuntimeProtocolRequestOptions,
  ): Promise<RuntimeSessionCancelResult> {
    return await this.transport.request("session.cancel", params, options);
  }
}
