import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { DesktopRuntimeStatus } from "../../desktop/shared/protocol";
import { logDesktop } from "../../desktop/backend/log";
import type { HostMcpServerRegistration } from "./host-mcp";
import type { DesktopProviderDefinition } from "./provider-types";
import { RuntimeHostBridge } from "./runtime-host-bridge";
import {
  ACON_RUNTIME_PROTOCOL_VERSION,
  RuntimeProtocolClient,
  type RuntimeHostToRuntimeMethod,
  type RuntimeHostToRuntimeParamsMap,
  type RuntimeHostToRuntimeResultsMap,
  type RuntimeNotificationEnvelope,
  type RuntimeNotificationParamsMap,
  type RuntimeProtocolEnvelope,
  type RuntimeRequestEnvelope,
  type RuntimeResponseEnvelope,
  type RuntimeRuntimeToHostMethod,
} from "./runtime-protocol";
import type {
  CancelContainerPromptOptions,
  RuntimeManager,
  StreamContainerPromptOptions,
  StreamContainerPromptResult,
} from "./container-runtime";

const DEFAULT_RUNTIME_DIRECTORY = resolve(process.cwd(), "desktop-container/.local/runtime");
const DEFAULT_WORKSPACE_DIRECTORY = resolve(process.cwd());
const DEFAULT_REMOTE_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_REMOTE_REQUEST_TIMEOUT_MS = 30_000;

interface ActivePromptListener {
  onDelta?: (delta: string) => void;
  onRuntimeEvent?: (event: unknown) => void;
}

interface RemotePendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
}

interface RemoteRuntimeConnection {
  socket: WebSocket;
  readyPromise: Promise<void>;
  pendingRequests: Map<string, RemotePendingRequest>;
}

export interface RemoteRuntimeManagerOptions {
  resolveRuntimeProviderTarget?: (
    runtimeProviderId: string,
  ) => Promise<{ url: string } | null>;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function parseTimeoutMs(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function normalizeRemoteRuntimeUrl(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(
      "Remote runtime mode requires DESKTOP_REMOTE_RUNTIME_URL to be set.",
    );
  }
  const parsed = new URL(normalized);
  if (parsed.protocol === "http:") {
    parsed.protocol = "ws:";
  } else if (parsed.protocol === "https:") {
    parsed.protocol = "wss:";
  } else if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(
      `Remote runtime URL must use ws:, wss:, http:, or https:. Received ${parsed.protocol || "<missing>"}.`,
    );
  }
  return parsed.toString();
}

function isRecoverableRemoteRuntimeError(error: unknown): boolean {
  const message = formatError(error);
  return /socket|websocket|timed out|timeout|closed|close|connection|network|ECONN|ENOTFOUND|EPIPE/i.test(
    message,
  );
}

async function coerceWebSocketMessageData(data: unknown): Promise<string> {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return await data.text();
  }
  return String(data);
}

export class RemoteRuntimeManager implements RuntimeManager {
  private lastRuntimeStatus: DesktopRuntimeStatus | null = null;
  private readonly runtimeDirectory =
    process.env.DESKTOP_RUNTIME_DIR || DEFAULT_RUNTIME_DIRECTORY;
  private readonly dataDirectory =
    process.env.DESKTOP_DATA_DIR?.trim() || resolve(this.runtimeDirectory, "..", "data");
  private readonly workspaceDirectory =
    process.env.DESKTOP_WORKSPACE_DIR?.trim() ||
    process.env.DESKTOP_CONTAINER_WORKSPACE_DIR?.trim() ||
    DEFAULT_WORKSPACE_DIRECTORY;
  private readonly runtimeProviderId =
    process.env.DESKTOP_RUNTIME_PROVIDER?.trim() || null;
  private resolvedAdapterUrl: string | null = null;
  private readonly hostBridge = new RuntimeHostBridge();
  private readonly activePromptListeners = new Map<string, Set<ActivePromptListener>>();
  private readonly ensuredSessions = new Map<string, string>();
  private connection: RemoteRuntimeConnection | null = null;
  private connectionPromise: Promise<RemoteRuntimeConnection> | null = null;
  private disposed = false;

  constructor(
    private readonly options: RemoteRuntimeManagerOptions = {},
  ) {}

  getWorkspaceDirectory(): string {
    return this.workspaceDirectory;
  }

  getManagedWorkspaceDirectory(): string {
    return this.workspaceDirectory;
  }

  getUserUploadsDirectory(): string {
    return this.ensureTransferDirectory("uploads");
  }

  getUserOutputsDirectory(): string {
    return this.ensureTransferDirectory("outputs");
  }

  getRuntimeDirectory(): string {
    return this.runtimeDirectory;
  }

  getThreadStateDirectory(threadId: string): string {
    return resolve(this.runtimeDirectory, "thread-state", threadId);
  }

  getCachedStatus(): DesktopRuntimeStatus {
    return (
      this.lastRuntimeStatus ?? {
        state: "stopped",
        detail: "Remote runtime adapter is idle.",
        helperPath: this.getAdapterLabel(),
        runtimeDirectory: this.runtimeDirectory,
        controlPlaneAddress: this.getControlPlaneAddress(),
        controlPlanePort: this.getControlPlanePort(),
      }
    );
  }

  registerHostMcpServer(registration: HostMcpServerRegistration): void {
    this.hostBridge.registerHostMcpServer(registration);
  }

  unregisterHostMcpServer(serverId: string): void {
    this.hostBridge.unregisterHostMcpServer(serverId);
  }

  dispose(): void {
    this.disposed = true;
    this.hostBridge.dispose();
    this.ensuredSessions.clear();
    this.activePromptListeners.clear();
    this.resetConnection("Remote runtime manager disposed.");
    this.lastRuntimeStatus = {
      state: "stopped",
      detail: "Remote runtime adapter stopped.",
      helperPath: this.getAdapterLabel(),
      runtimeDirectory: this.runtimeDirectory,
      controlPlaneAddress: this.getControlPlaneAddress(),
      controlPlanePort: this.getControlPlanePort(),
    };
  }

  async ensureRuntime(
    provider: DesktopProviderDefinition,
    onStatus?: (status: DesktopRuntimeStatus) => void,
  ): Promise<DesktopRuntimeStatus> {
    const startingStatus: DesktopRuntimeStatus = {
      state: "starting",
      detail: `Connecting to the remote ${provider.label} runtime adapter.`,
      helperPath: this.getAdapterLabel(),
      runtimeDirectory: this.runtimeDirectory,
      controlPlaneAddress: this.getControlPlaneAddress(),
      controlPlanePort: this.getControlPlanePort(),
    };
    this.lastRuntimeStatus = startingStatus;
    onStatus?.(startingStatus);

    try {
      mkdirSync(this.runtimeDirectory, { recursive: true });
      await this.requestWithReconnectRetry((client) =>
        client.ping({ provider: provider.id }),
      );
      const readyStatus: DesktopRuntimeStatus = {
        state: "running",
        detail: `${provider.label} is ready via remote runtime adapter.`,
        helperPath: this.getAdapterLabel(),
        runtimeDirectory: this.runtimeDirectory,
        controlPlaneAddress: this.getControlPlaneAddress(),
        controlPlanePort: this.getControlPlanePort(),
      };
      this.lastRuntimeStatus = readyStatus;
      onStatus?.(readyStatus);
      return readyStatus;
    } catch (error) {
      const failedStatus: DesktopRuntimeStatus = {
        state: "error",
        detail: formatError(error),
        helperPath: this.getAdapterLabel(),
        runtimeDirectory: this.runtimeDirectory,
        controlPlaneAddress: this.getControlPlaneAddress(),
        controlPlanePort: this.getControlPlanePort(),
      };
      this.lastRuntimeStatus = failedStatus;
      onStatus?.(failedStatus);
      throw error;
    }
  }

  async cancelPrompt({
    provider,
    threadId,
    model,
  }: CancelContainerPromptOptions): Promise<void> {
    await this.ensureRuntime(provider);
    await this.requestWithReconnectRetry((client) =>
      client.cancelSession(
        {
          provider: provider.id,
          sessionName: `${provider.id}-${threadId}`,
          model,
        },
        {
          timeoutMs: parseTimeoutMs(
            process.env.DESKTOP_REMOTE_RUNTIME_REQUEST_TIMEOUT_MS,
            DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
          ),
        },
      ),
    );
  }

  async streamPrompt({
    provider,
    threadId,
    content,
    model,
    sessionId,
    onSessionId,
    onDelta,
    onRuntimeEvent,
  }: StreamContainerPromptOptions): Promise<StreamContainerPromptResult> {
    await this.ensureRuntime(provider);
    await this.ensurePromptSession(provider, threadId, model, sessionId);

    const sessionName = `${provider.id}-${threadId}`;
    const promptListener =
      onDelta || onRuntimeEvent
        ? {
            onDelta,
            onRuntimeEvent,
          }
        : null;
    if (promptListener) {
      this.addActivePromptListener(sessionName, promptListener);
    }

    try {
      const result = await this.requestWithReconnectRetry((client) =>
        client.promptSession(
          {
            provider: provider.id,
            sessionName,
            content,
            model,
            sessionId: sessionId ?? null,
          },
          {
            timeoutMs: 0,
          },
        ),
      );
      const resolvedSessionId =
        typeof result.sessionId === "string" && result.sessionId.trim()
          ? result.sessionId.trim()
          : typeof sessionId === "string" && sessionId.trim()
            ? sessionId.trim()
            : `${provider.id}-${threadId}-${Date.now()}`;
      onSessionId?.(resolvedSessionId);
      return {
        finalText: typeof result.finalText === "string" ? result.finalText : "",
        model,
        sessionId: resolvedSessionId,
        stopReason:
          typeof result.stopReason === "string" ? result.stopReason : null,
      };
    } finally {
      if (promptListener) {
        this.removeActivePromptListener(sessionName, promptListener);
      }
    }
  }

  private async ensurePromptSession(
    provider: DesktopProviderDefinition,
    threadId: string,
    model: string,
    sessionId?: string | null,
  ): Promise<void> {
    mkdirSync(this.getThreadStateDirectory(threadId), { recursive: true });
    const sessionName = `${provider.id}-${threadId}`;
    const sessionKey = `${model}:${sessionId?.trim() || ""}`;
    if (this.ensuredSessions.get(sessionName) === sessionKey) {
      return;
    }

    await this.requestWithReconnectRetry((client) =>
      client.ensureSession(
        {
          provider: provider.id,
          sessionName,
          model,
          sessionId: sessionId ?? null,
        },
        {
          timeoutMs: parseTimeoutMs(
            process.env.DESKTOP_REMOTE_RUNTIME_REQUEST_TIMEOUT_MS,
            DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
          ),
        },
      ),
    );
    this.ensuredSessions.set(sessionName, sessionKey);
  }

  private async requestWithReconnectRetry<T>(
    callback: (client: RuntimeProtocolClient) => Promise<T>,
  ): Promise<T> {
    try {
      const connection = await this.ensureConnection();
      return await callback(this.createRuntimeProtocolClient(connection));
    } catch (error) {
      if (!isRecoverableRemoteRuntimeError(error)) {
        throw error;
      }
      this.resetConnection(formatError(error));
      const connection = await this.ensureConnection();
      return await callback(this.createRuntimeProtocolClient(connection));
    }
  }

  private createRuntimeProtocolClient(
    connection: RemoteRuntimeConnection,
  ): RuntimeProtocolClient {
    return new RuntimeProtocolClient({
      request: async (method, params, options) =>
        await this.requestRemoteRuntime(connection, method, params, options),
    });
  }

  private async ensureConnection(): Promise<RemoteRuntimeConnection> {
    if (this.disposed) {
      throw new Error("Remote runtime manager has been disposed.");
    }
    if (this.connection) {
      return this.connection;
    }
    if (this.connectionPromise) {
      return await this.connectionPromise;
    }
    this.connectionPromise = this.openConnection();
    try {
      const connection = await this.connectionPromise;
      this.connection = connection;
      return connection;
    } finally {
      this.connectionPromise = null;
    }
  }

  private async openConnection(): Promise<RemoteRuntimeConnection> {
    if (typeof WebSocket !== "function") {
      throw new Error("Remote runtime requires a global WebSocket implementation.");
    }

    const adapterUrl = await this.resolveAdapterUrl();
    const socket = new WebSocket(adapterUrl);
    const connection: RemoteRuntimeConnection = {
      socket,
      readyPromise: Promise.resolve(),
      pendingRequests: new Map(),
    };

    connection.readyPromise = new Promise<void>((resolvePromise, rejectPromise) => {
      let settled = false;
      const timeoutMs = parseTimeoutMs(
        process.env.DESKTOP_REMOTE_RUNTIME_CONNECT_TIMEOUT_MS,
        DEFAULT_REMOTE_CONNECT_TIMEOUT_MS,
      );
      const readyTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        rejectPromise(
          new Error(
            `Remote runtime adapter timed out after ${timeoutMs}ms waiting for ready.`,
          ),
        );
        try {
          socket.close();
        } catch {}
      }, timeoutMs);

      const settleReady = (error?: Error | null) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(readyTimer);
        if (error) {
          rejectPromise(error);
          return;
        }
        resolvePromise();
      };

      socket.addEventListener("message", (event) => {
        void this.handleSocketMessage(connection, event.data, settleReady);
      });
      socket.addEventListener("error", () => {
        settleReady(new Error("Remote runtime WebSocket connection failed."));
      });
      socket.addEventListener("close", (event) => {
        this.handleSocketClose(
          connection,
          `Remote runtime connection closed (code=${event.code}, reason=${event.reason || "none"}).`,
        );
        if (!settled) {
          settleReady(
            new Error(
              `Remote runtime connection closed before ready (code=${event.code}, reason=${event.reason || "none"}).`,
            ),
          );
        }
      });
    });

    await connection.readyPromise;
    return connection;
  }

  private async handleSocketMessage(
    connection: RemoteRuntimeConnection,
    rawData: unknown,
    settleReady: (error?: Error | null) => void,
  ): Promise<void> {
    const rawText = await coerceWebSocketMessageData(rawData);
    const line = rawText.trim();
    if (!line) {
      return;
    }

    let message: RuntimeProtocolEnvelope;
    try {
      message = JSON.parse(line) as RuntimeProtocolEnvelope;
    } catch {
      settleReady(new Error(`Remote runtime returned invalid JSON: ${line}`));
      return;
    }

    if (message.type === "ready") {
      if (message.protocolVersion !== ACON_RUNTIME_PROTOCOL_VERSION) {
        settleReady(
          new Error(
            `Remote runtime protocol mismatch. Expected v${ACON_RUNTIME_PROTOCOL_VERSION}, received v${message.protocolVersion}.`,
          ),
        );
        return;
      }
      settleReady();
      return;
    }

    if (message.type === "request") {
      await this.handleRuntimeRequest(connection, message as RuntimeRequestEnvelope);
      return;
    }

    if (message.type === "response") {
      const response = message as RuntimeResponseEnvelope;
      const requestId = typeof response.id === "string" ? response.id : null;
      if (!requestId) {
        return;
      }
      const pending = connection.pendingRequests.get(requestId);
      if (!pending) {
        return;
      }
      connection.pendingRequests.delete(requestId);
      pending.timer && clearTimeout(pending.timer);
      if (response.error?.message) {
        pending.reject(new Error(response.error.message));
      } else {
        pending.resolve(response.result ?? null);
      }
      return;
    }

    if (message.type === "notification") {
      this.handleRuntimeNotification(message as RuntimeNotificationEnvelope);
    }
  }

  private async handleRuntimeRequest(
    connection: RemoteRuntimeConnection,
    message: RuntimeRequestEnvelope,
  ): Promise<void> {
    const requestId = typeof message.id === "string" ? message.id : null;
    if (!requestId) {
      return;
    }

    let response: RuntimeProtocolEnvelope;
    try {
      const result = await this.hostBridge.execute(
        typeof message.method === "string"
          ? (message.method as RuntimeRuntimeToHostMethod)
          : "",
        message.params,
        {
          runtimeLabel: this.getAdapterLabel(),
          pid: process.pid,
        },
      );
      response = {
        type: "response",
        id: requestId,
        result,
      };
    } catch (error) {
      response = {
        type: "response",
        id: requestId,
        error: {
          code: "RPC_ERROR",
          message: formatError(error),
        },
      };
    }

    this.sendEnvelope(connection, response);
  }

  private handleRuntimeNotification(message: RuntimeNotificationEnvelope): void {
    if (message.method === "session.runtime_event") {
      const { sessionName, event } =
        message.params as RuntimeNotificationParamsMap["session.runtime_event"];
      for (const listener of this.activePromptListeners.get(sessionName) ?? []) {
        listener.onRuntimeEvent?.(event);
      }
      return;
    }

    if (message.method === "session.delta") {
      const { sessionName, delta } =
        message.params as RuntimeNotificationParamsMap["session.delta"];
      if (!delta) {
        return;
      }
      for (const listener of this.activePromptListeners.get(sessionName) ?? []) {
        listener.onDelta?.(delta);
      }
    }
  }

  private async requestRemoteRuntime<TMethod extends RuntimeHostToRuntimeMethod>(
    connection: RemoteRuntimeConnection,
    method: TMethod,
    params: RuntimeHostToRuntimeParamsMap[TMethod],
    options: {
      timeoutMs?: number;
    } = {},
  ): Promise<RuntimeHostToRuntimeResultsMap[TMethod]> {
    if (connection.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Remote runtime connection is not open.");
    }

    const requestId = randomUUID();
    return await new Promise<RuntimeHostToRuntimeResultsMap[TMethod]>(
      (resolvePromise, rejectPromise) => {
        const timeoutMs =
          typeof options.timeoutMs === "number"
            ? options.timeoutMs
            : DEFAULT_REMOTE_REQUEST_TIMEOUT_MS;
        const timer =
          timeoutMs > 0
            ? setTimeout(() => {
                connection.pendingRequests.delete(requestId);
                rejectPromise(
                  new Error(
                    `Remote runtime ${method} timed out after ${timeoutMs}ms.`,
                  ),
                );
              }, timeoutMs)
            : null;
        connection.pendingRequests.set(requestId, {
          resolve: (value) => {
            resolvePromise(value as RuntimeHostToRuntimeResultsMap[TMethod]);
          },
          reject: rejectPromise,
          timer,
        });
        this.sendEnvelope(connection, {
          type: "request",
          id: requestId,
          method,
          params,
        });
      },
    );
  }

  private sendEnvelope(
    connection: RemoteRuntimeConnection,
    envelope: RuntimeProtocolEnvelope,
  ): void {
    if (connection.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Remote runtime connection is not open.");
    }
    connection.socket.send(JSON.stringify(envelope));
  }

  private addActivePromptListener(
    sessionName: string,
    listener: ActivePromptListener,
  ): void {
    const listeners = this.activePromptListeners.get(sessionName) ?? new Set();
    listeners.add(listener);
    this.activePromptListeners.set(sessionName, listeners);
  }

  private removeActivePromptListener(
    sessionName: string,
    listener: ActivePromptListener,
  ): void {
    const listeners = this.activePromptListeners.get(sessionName);
    if (!listeners) {
      return;
    }
    listeners.delete(listener);
    if (listeners.size === 0) {
      this.activePromptListeners.delete(sessionName);
    }
  }

  private handleSocketClose(
    connection: RemoteRuntimeConnection,
    detail: string,
  ): void {
    if (this.connection === connection) {
      this.connection = null;
    }
    for (const [requestId, pending] of connection.pendingRequests.entries()) {
      pending.timer && clearTimeout(pending.timer);
      pending.reject(new Error(detail));
      connection.pendingRequests.delete(requestId);
    }
    this.ensuredSessions.clear();
    if (!this.disposed) {
      this.lastRuntimeStatus = {
        state: "error",
        detail,
        helperPath: this.getAdapterLabel(),
        runtimeDirectory: this.runtimeDirectory,
        controlPlaneAddress: this.getControlPlaneAddress(),
        controlPlanePort: this.getControlPlanePort(),
      };
      logDesktop("desktop-runtime", "remote_runtime:closed", {
        detail,
        adapterUrl: this.resolvedAdapterUrl,
        runtimeProviderId: this.runtimeProviderId,
      }, "warn");
    }
  }

  private resetConnection(detail: string): void {
    const connection = this.connection;
    this.connection = null;
    this.connectionPromise = null;
    if (!connection) {
      return;
    }
    this.handleSocketClose(connection, detail);
    try {
      connection.socket.close();
    } catch {}
  }

  private async resolveAdapterUrl(): Promise<string> {
    if (this.resolvedAdapterUrl) {
      return this.resolvedAdapterUrl;
    }

    const directUrl = process.env.DESKTOP_REMOTE_RUNTIME_URL?.trim();
    if (directUrl) {
      this.resolvedAdapterUrl = normalizeRemoteRuntimeUrl(directUrl);
      return this.resolvedAdapterUrl;
    }

    if (this.runtimeProviderId) {
      const target = await this.options.resolveRuntimeProviderTarget?.(
        this.runtimeProviderId,
      );
      const resolvedUrl = target?.url?.trim();
      if (resolvedUrl) {
        this.resolvedAdapterUrl = normalizeRemoteRuntimeUrl(resolvedUrl);
        return this.resolvedAdapterUrl;
      }
      throw new Error(
        `Runtime provider '${this.runtimeProviderId}' did not resolve a remote runtime URL.`,
      );
    }

    throw new Error(
      "Remote runtime mode requires DESKTOP_REMOTE_RUNTIME_URL or DESKTOP_RUNTIME_PROVIDER to be set.",
    );
  }

  private getAdapterLabel(): string | null {
    return this.resolvedAdapterUrl ?? this.runtimeProviderId ?? null;
  }

  private getControlPlaneAddress(): string | null {
    if (!this.resolvedAdapterUrl) {
      return null;
    }
    return new URL(this.resolvedAdapterUrl).hostname;
  }

  private getControlPlanePort(): number | null {
    if (!this.resolvedAdapterUrl) {
      return null;
    }
    const parsed = new URL(this.resolvedAdapterUrl);
    if (parsed.port) {
      return Number.parseInt(parsed.port, 10);
    }
    return parsed.protocol === "wss:" ? 443 : 80;
  }

  private ensureTransferDirectory(kind: "uploads" | "outputs"): string {
    const directory = resolve(this.dataDirectory, "transfers", kind);
    mkdirSync(directory, { recursive: true });
    return directory;
  }
}
