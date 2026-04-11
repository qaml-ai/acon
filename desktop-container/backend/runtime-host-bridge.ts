import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  HostMcpRegistry,
  type HostMcpBridgeRequest,
  type HostMcpServerRegistration,
} from "./host-mcp";
import type {
  RuntimeHostFetchResult,
  RuntimeRuntimeToHostMethod,
  RuntimeRuntimeToHostResultsMap,
} from "./runtime-protocol";

const DEFAULT_HOST_RPC_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_HOST_RPC_FETCH_MAX_BODY_BYTES = 256 * 1024;

export interface RuntimeHostBridgePingMetadata {
  runtimeLabel?: string | null;
  pid?: number;
  params?: unknown;
}

export class RuntimeHostBridge {
  private readonly hostMcpRegistry = new HostMcpRegistry();

  registerHostMcpServer(registration: HostMcpServerRegistration): void {
    this.hostMcpRegistry.registerServer(registration);
  }

  unregisterHostMcpServer(serverId: string): void {
    this.hostMcpRegistry.unregisterServer(serverId);
  }

  dispose(): void {
    this.hostMcpRegistry.dispose();
  }

  async execute(
    method: RuntimeRuntimeToHostMethod | "",
    params: unknown,
    metadata: RuntimeHostBridgePingMetadata = {},
  ): Promise<RuntimeRuntimeToHostResultsMap[RuntimeRuntimeToHostMethod] | unknown> {
    switch (method) {
      case "ping": {
        return {
          ok: true,
          containerName: metadata.runtimeLabel ?? undefined,
          now: new Date().toISOString(),
          pid: metadata.pid ?? process.pid,
          params: metadata.params ?? params ?? null,
        };
      }
      case "fetch":
        return await this.executeFetch(params);
      case "mcp.request":
        return await this.executeMcpRequest(params);
      case "mcp.close":
        return await this.executeMcpClose(params);
      case "mcp.list_servers":
        return this.hostMcpRegistry.listServers();
      default:
        throw new Error(`Unknown host RPC method: ${method || "<missing>"}.`);
    }
  }

  private async executeMcpRequest(params: unknown): Promise<unknown> {
    if (!params || typeof params !== "object") {
      throw new Error("mcp.request params must be an object.");
    }

    const record = params as Record<string, unknown>;
    if (!record.message || typeof record.message !== "object") {
      throw new Error("mcp.request params.message must be an object.");
    }

    return await this.hostMcpRegistry.dispatchRequest({
      serverId: typeof record.serverId === "string" ? record.serverId : "",
      sessionId: typeof record.sessionId === "string" ? record.sessionId : "",
      message: record.message as HostMcpBridgeRequest["message"],
    });
  }

  private async executeMcpClose(params: unknown): Promise<{ ok: true }> {
    if (!params || typeof params !== "object") {
      throw new Error("mcp.close params must be an object.");
    }

    const record = params as Record<string, unknown>;
    await this.hostMcpRegistry.closeSession(
      typeof record.serverId === "string" ? record.serverId : "",
      typeof record.sessionId === "string" ? record.sessionId : "",
    );
    return { ok: true };
  }

  private async executeFetch(params: unknown): Promise<RuntimeHostFetchResult> {
    if (!params || typeof params !== "object") {
      throw new Error("fetch params must be an object.");
    }

    const record = params as Record<string, unknown>;
    const url = typeof record.url === "string" ? record.url.trim() : "";
    if (!url) {
      throw new Error("fetch params.url must be a non-empty string.");
    }

    const method =
      typeof record.method === "string" && record.method.trim()
        ? record.method.trim().toUpperCase()
        : "GET";
    const timeoutMs =
      typeof record.timeoutMs === "number" && Number.isFinite(record.timeoutMs)
        ? Math.max(1, Math.trunc(record.timeoutMs))
        : DEFAULT_HOST_RPC_FETCH_TIMEOUT_MS;
    const maxBodyBytes =
      typeof record.maxBodyBytes === "number" && Number.isFinite(record.maxBodyBytes)
        ? Math.max(1, Math.trunc(record.maxBodyBytes))
        : DEFAULT_HOST_RPC_FETCH_MAX_BODY_BYTES;
    const body = typeof record.body === "string" ? record.body : undefined;
    const targetUrl = new URL(url);
    if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
      throw new Error(
        `fetch only supports http/https URLs. Received ${targetUrl.protocol || "<missing>"}.`,
      );
    }

    const headers: Record<string, string> = {};
    if (record.headers && typeof record.headers === "object") {
      for (const [key, value] of Object.entries(record.headers as Record<string, unknown>)) {
        if (typeof value === "string") {
          headers[key] = value;
        }
      }
    }
    if (
      body !== undefined &&
      !Object.keys(headers).some((key) => key.toLowerCase() === "content-length")
    ) {
      headers["content-length"] = Buffer.byteLength(body).toString();
    }

    return await new Promise<RuntimeHostFetchResult>((resolvePromise, rejectPromise) => {
      const requestFn = targetUrl.protocol === "https:" ? httpsRequest : httpRequest;
      let abortedForTruncation = false;
      const request = requestFn(
        targetUrl,
        {
          method,
          headers,
        },
        (incomingResponse) => {
          const chunks: Buffer[] = [];
          let totalBytes = 0;
          let truncated = false;
          let settled = false;

          const buildResponse = (): RuntimeHostFetchResult => ({
            ok:
              typeof incomingResponse.statusCode === "number" &&
              incomingResponse.statusCode >= 200 &&
              incomingResponse.statusCode < 300,
            status: incomingResponse.statusCode ?? 0,
            statusText: incomingResponse.statusMessage ?? "",
            url: targetUrl.toString(),
            headers: Object.fromEntries(
              Object.entries(incomingResponse.headers).flatMap(([key, value]) => {
                if (Array.isArray(value)) {
                  return [[key, value.join(", ")]];
                }
                return typeof value === "string" ? [[key, value]] : [];
              }),
            ),
            body: Buffer.concat(chunks).toString("utf8"),
            truncated,
          });

          const finish = (error?: Error | null) => {
            if (settled) {
              return;
            }
            settled = true;
            if (error) {
              rejectPromise(error);
              return;
            }
            resolvePromise(buildResponse());
          };

          incomingResponse.on("data", (chunk: string | Buffer) => {
            const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (totalBytes >= maxBodyBytes) {
              truncated = true;
              abortedForTruncation = true;
              incomingResponse.destroy();
              request.destroy();
              finish(null);
              return;
            }

            if (totalBytes + chunkBuffer.length > maxBodyBytes) {
              const remainingBytes = maxBodyBytes - totalBytes;
              if (remainingBytes > 0) {
                chunks.push(chunkBuffer.subarray(0, remainingBytes));
                totalBytes += remainingBytes;
              }
              truncated = true;
              abortedForTruncation = true;
              incomingResponse.destroy();
              request.destroy();
              finish(null);
              return;
            }

            chunks.push(chunkBuffer);
            totalBytes += chunkBuffer.length;
          });

          incomingResponse.on("end", () => {
            finish(null);
          });

          incomingResponse.on("error", (error) => {
            if (truncated) {
              return;
            }
            finish(error instanceof Error ? error : new Error(String(error)));
          });
        },
      );

      request.setTimeout(timeoutMs, () => {
        request.destroy(new Error(`Host RPC request timed out after ${timeoutMs}ms.`));
      });
      request.on("error", (error) => {
        if (abortedForTruncation) {
          return;
        }
        rejectPromise(error instanceof Error ? error : new Error(String(error)));
      });
      if (body !== undefined) {
        request.write(body);
      }
      request.end();
    });
  }
}
