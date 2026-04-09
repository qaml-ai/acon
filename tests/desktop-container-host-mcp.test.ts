// @vitest-environment node

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { HostMcpRegistry, createRemoteProxyHostMcpServer } from "../desktop-container/backend/host-mcp";
import {
  createHttpWrapperHostMcpServer,
  setPersistedHttpWrapperSecret,
} from "../desktop-container/backend/http-wrapper-mcp";
import { setPersistedHostSecret } from "../desktop-container/backend/host-secrets";
import {
  HostMcpOAuthManager,
  PersistedHostMcpOAuthProvider,
} from "../desktop-container/backend/host-mcp-oauth";
import { createPersistedHostMcpServerRegistration } from "../desktop-container/backend/persisted-host-mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

function createEchoServer(transportLabel: string): McpServer {
  const server = new McpServer({
    name: `remote-${transportLabel}-server`,
    version: "1.0.0",
  });

  server.registerTool(
    "remote_echo",
    {
      description: "Echoes a string from a remote MCP server.",
      inputSchema: z.object({
        text: z.string(),
      }),
      outputSchema: z.object({
        echoedText: z.string(),
        transport: z.string(),
      }),
    },
    async ({ text }) => ({
      content: [
        {
          type: "text",
          text: `${transportLabel}:${text}`,
        },
      ],
      structuredContent: {
        echoedText: text,
        transport: transportLabel,
      },
    }),
  );

  return server;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString("utf8").trim();
  return body ? (JSON.parse(body) as unknown) : null;
}

async function startStreamableHttpServer(): Promise<{
  close: () => Promise<void>;
  url: string;
}> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const sessions = new Map<string, McpServer>();
  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    if (requestUrl.pathname !== "/mcp") {
      response.writeHead(404).end();
      return;
    }

    if (request.method === "GET") {
      response.writeHead(405, { Allow: "POST" }).end("Method Not Allowed");
      return;
    }

    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST" }).end("Method Not Allowed");
      return;
    }

    const body = await readJsonBody(request);
    const existingSessionId =
      typeof request.headers["mcp-session-id"] === "string"
        ? request.headers["mcp-session-id"]
        : null;
    let transport = existingSessionId ? transports.get(existingSessionId) ?? null : null;

    if (!transport) {
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        (body as { method?: unknown }).method !== "initialize"
      ) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              code: -32000,
              message: "Bad Request: No valid session ID provided",
            },
            id: null,
            jsonrpc: "2.0",
          }),
        );
        return;
      }

      transport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => {
          transports.set(sessionId, transport!);
        },
      });
      const sessionServer = createEchoServer("streamable-http");
      await sessionServer.connect(transport);
      sessions.set(transport.sessionId, sessionServer);
      transport.onclose = () => {
        transports.delete(transport!.sessionId);
        sessions.delete(transport!.sessionId);
      };
    }

    await transport.handleRequest(request, response, body);
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Streamable HTTP test server did not expose a TCP port.");
  }

  return {
    close: async () => {
      for (const sessionServer of sessions.values()) {
        await sessionServer.close();
      }
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => {
          if (error) {
            rejectPromise(error);
            return;
          }
          resolvePromise();
        });
      });
    },
    url: `http://127.0.0.1:${address.port}/mcp`,
  };
}

async function startSseServer(): Promise<{
  close: () => Promise<void>;
  url: string;
}> {
  const transports = new Map<string, SSEServerTransport>();
  const sessions = new Map<string, McpServer>();
  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && requestUrl.pathname === "/mcp") {
      const transport = new SSEServerTransport("/messages", response);
      transports.set(transport.sessionId, transport);
      const sessionServer = createEchoServer("sse");
      sessions.set(transport.sessionId, sessionServer);
      transport.onclose = () => {
        transports.delete(transport.sessionId);
        sessions.delete(transport.sessionId);
      };
      await sessionServer.connect(transport);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/messages") {
      const sessionId = requestUrl.searchParams.get("sessionId");
      const transport = sessionId ? transports.get(sessionId) ?? null : null;
      if (!transport) {
        response.writeHead(404).end("Session not found");
        return;
      }

      const body = await readJsonBody(request);
      await transport.handlePostMessage(request, response, body);
      return;
    }

    response.writeHead(404).end();
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("SSE test server did not expose a TCP port.");
  }

  return {
    close: async () => {
      for (const transport of transports.values()) {
        await transport.close();
      }
      for (const sessionServer of sessions.values()) {
        await sessionServer.close();
      }
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => {
          if (error) {
            rejectPromise(error);
            return;
          }
          resolvePromise();
        });
      });
    },
    url: `http://127.0.0.1:${address.port}/mcp`,
  };
}

async function initializeRegistryServer(
  registry: HostMcpRegistry,
  serverId: string,
  sessionId: string,
): Promise<void> {
  await registry.dispatchRequest({
    serverId,
    sessionId,
    message: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: {
          name: "test-client",
          version: "1.0.0",
        },
      },
    },
  });
  await registry.dispatchRequest({
    serverId,
    sessionId,
    message: {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    },
  });
}

async function callRemoteEcho(
  registry: HostMcpRegistry,
  serverId: string,
  sessionId: string,
  text: string,
): Promise<{
  result: unknown;
  tools: string[];
}> {
  const toolListResponse = await registry.dispatchRequest({
    serverId,
    sessionId,
    message: {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    },
  });
  const toolListError = toolListResponse.messages.find(
    (message) =>
      "id" in message &&
      message.id === 2 &&
      "error" in message,
  );
  if (
    toolListError &&
    "error" in toolListError &&
    toolListError.error &&
    typeof toolListError.error === "object"
  ) {
    throw new Error(
      String((toolListError.error as { message?: unknown }).message ?? "tools/list failed"),
    );
  }
  const toolListResult = toolListResponse.messages.find(
    (message) =>
      "id" in message &&
      message.id === 2 &&
      "result" in message,
  );
  const tools =
    toolListResult &&
    "result" in toolListResult &&
    toolListResult.result &&
    typeof toolListResult.result === "object" &&
    Array.isArray((toolListResult.result as { tools?: unknown[] }).tools)
      ? (toolListResult.result as { tools: Array<{ name?: unknown }> }).tools
          .map((tool) => (typeof tool.name === "string" ? tool.name : ""))
          .filter(Boolean)
      : [];

  const toolCallResponse = await registry.dispatchRequest({
    serverId,
    sessionId,
    message: {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "remote_echo",
        arguments: {
          text,
        },
      },
    },
  });
  const toolCallError = toolCallResponse.messages.find(
    (message) =>
      "id" in message &&
      message.id === 3 &&
      "error" in message,
  );
  if (
    toolCallError &&
    "error" in toolCallError &&
    toolCallError.error &&
    typeof toolCallError.error === "object"
  ) {
    throw new Error(
      String((toolCallError.error as { message?: unknown }).message ?? "tools/call failed"),
    );
  }
  const toolCallResult = toolCallResponse.messages.find(
    (message) =>
      "id" in message &&
      message.id === 3 &&
      "result" in message,
  );

  return {
    result:
      toolCallResult && "result" in toolCallResult
        ? toolCallResult.result
        : null,
    tools,
  };
}

async function callTool(
  registry: HostMcpRegistry,
  serverId: string,
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{
  result: unknown;
  tools: string[];
}> {
  const toolListResponse = await registry.dispatchRequest({
    serverId,
    sessionId,
    message: {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    },
  });
  const toolListResult = toolListResponse.messages.find(
    (message) =>
      "id" in message &&
      message.id === 2 &&
      "result" in message,
  );
  const tools =
    toolListResult &&
    "result" in toolListResult &&
    toolListResult.result &&
    typeof toolListResult.result === "object" &&
    Array.isArray((toolListResult.result as { tools?: unknown[] }).tools)
      ? (toolListResult.result as { tools: Array<{ name?: unknown }> }).tools
          .map((tool) => (typeof tool.name === "string" ? tool.name : ""))
          .filter(Boolean)
      : [];

  const toolCallResponse = await registry.dispatchRequest({
    serverId,
    sessionId,
    message: {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
      },
    },
  });
  const toolCallError = toolCallResponse.messages.find(
    (message) =>
      "id" in message &&
      message.id === 3 &&
      "error" in message,
  );
  if (
    toolCallError &&
    "error" in toolCallError &&
    toolCallError.error &&
    typeof toolCallError.error === "object"
  ) {
    throw new Error(
      String((toolCallError.error as { message?: unknown }).message ?? "tools/call failed"),
    );
  }
  const toolCallResult = toolCallResponse.messages.find(
    (message) =>
      "id" in message &&
      message.id === 3 &&
      "result" in message,
  );

  return {
    result:
      toolCallResult && "result" in toolCallResult
        ? toolCallResult.result
        : null,
    tools,
  };
}

async function callHttpWrapperFetch(
  registry: HostMcpRegistry,
  serverId: string,
  sessionId: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const toolCallResponse = await registry.dispatchRequest({
    serverId,
    sessionId,
    message: {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "fetch",
        arguments: input,
      },
    },
  });
  const toolCallError = toolCallResponse.messages.find(
    (message) =>
      "id" in message &&
      message.id === 3 &&
      "error" in message,
  );
  if (
    toolCallError &&
    "error" in toolCallError &&
    toolCallError.error &&
    typeof toolCallError.error === "object"
  ) {
    throw new Error(
      String((toolCallError.error as { message?: unknown }).message ?? "tools/call failed"),
    );
  }

  const toolCallResult = toolCallResponse.messages.find(
    (message) =>
      "id" in message &&
      message.id === 3 &&
      "result" in message,
  );
  return toolCallResult && "result" in toolCallResult
    ? toolCallResult.result
    : null;
}

describe("host MCP remote proxy", () => {
  let scratchDirectory: string;
  let previousSecretStoreBackend: string | undefined;

  beforeEach(() => {
    previousSecretStoreBackend = process.env.ACON_SECRET_STORE_BACKEND;
    process.env.ACON_SECRET_STORE_BACKEND = "file";
  });

  afterEach(() => {
    if (scratchDirectory) {
      rmSync(scratchDirectory, { force: true, recursive: true });
    }
    if (previousSecretStoreBackend === undefined) {
      delete process.env.ACON_SECRET_STORE_BACKEND;
    } else {
      process.env.ACON_SECRET_STORE_BACKEND = previousSecretStoreBackend;
    }
    vi.restoreAllMocks();
  });

  it("proxies a remote Streamable HTTP MCP server", async () => {
    scratchDirectory = mkdtempSync(join(tmpdir(), "acon-host-mcp-test-"));
    const remoteServer = await startStreamableHttpServer();
    const registry = new HostMcpRegistry();
    const sessionId = randomUUID();

    registry.registerServer({
      id: "remote-stream",
      createServer: () =>
        createRemoteProxyHostMcpServer({
          dataDirectory: scratchDirectory,
          serverId: "remote-stream",
          transport: "streamable-http",
          url: remoteServer.url,
        }),
    });

    try {
      await initializeRegistryServer(registry, "remote-stream", sessionId);
      const response = await callRemoteEcho(
        registry,
        "remote-stream",
        sessionId,
        "hello",
      );

      expect(response.tools).toContain("remote_echo");
      expect(response.result).toEqual(
        expect.objectContaining({
          structuredContent: {
            echoedText: "hello",
            transport: "streamable-http",
          },
        }),
      );
    } finally {
      await registry.closeSession("remote-stream", sessionId);
      registry.dispose();
      await remoteServer.close();
    }
  });

  it("falls back to legacy SSE when configured for Streamable HTTP against an SSE server", async () => {
    scratchDirectory = mkdtempSync(join(tmpdir(), "acon-host-mcp-test-"));
    const remoteServer = await startSseServer();
    const registry = new HostMcpRegistry();
    const sessionId = randomUUID();

    registry.registerServer({
      id: "remote-sse",
      createServer: () =>
        createRemoteProxyHostMcpServer({
          dataDirectory: scratchDirectory,
          serverId: "remote-sse",
          transport: "streamable-http",
          url: remoteServer.url,
        }),
    });

    try {
      await initializeRegistryServer(registry, "remote-sse", sessionId);
      const response = await callRemoteEcho(
        registry,
        "remote-sse",
        sessionId,
        "legacy",
      );

      expect(response.tools).toContain("remote_echo");
      expect(response.result).toEqual(
        expect.objectContaining({
          structuredContent: {
            echoedText: "legacy",
            transport: "sse",
          },
        }),
      );
    } finally {
      await registry.closeSession("remote-sse", sessionId);
      registry.dispose();
      await remoteServer.close();
    }
  });

  it("keeps OAuth callback handling and token persistence on the host", async () => {
    scratchDirectory = mkdtempSync(join(tmpdir(), "acon-host-mcp-oauth-"));
    const browserOpener = vi.fn(async () => {});
    const manager = new HostMcpOAuthManager({
      browserOpener,
    });
    const redirectUrl = await manager.getRedirectUrl("oauth-server");
    const provider = new PersistedHostMcpOAuthProvider({
      dataDirectory: scratchDirectory,
      manager,
      oauth: {
        clientId: null,
        clientMetadataUrl: null,
        clientName: "Acon OAuth Test",
        clientSecret: null,
        clientUri: null,
        scope: "tools.read",
        tokenEndpointAuthMethod: null,
      },
      redirectUrl,
      serverId: "oauth-server",
    });

    await provider.redirectToAuthorization(
      new URL("https://auth.example.com/authorize"),
    );
    expect(browserOpener).toHaveBeenCalledWith(
      "https://auth.example.com/authorize",
    );

    const authorizationCodePromise = provider.waitForAuthorizationCode();
    const callbackResponse = await fetch(`${redirectUrl}?code=test-auth-code`);
    expect(callbackResponse.status).toBe(200);
    await expect(authorizationCodePromise).resolves.toBe("test-auth-code");

    provider.saveCodeVerifier("verifier-123");
    provider.saveClientInformation({
      client_id: "client-123",
    });
    provider.saveTokens({
      access_token: "access-123",
      refresh_token: "refresh-123",
      token_type: "Bearer",
    });

    const secondProvider = new PersistedHostMcpOAuthProvider({
      dataDirectory: scratchDirectory,
      manager,
      oauth: {
        clientId: null,
        clientMetadataUrl: null,
        clientName: "Acon OAuth Test",
        clientSecret: null,
        clientUri: null,
        scope: "tools.read",
        tokenEndpointAuthMethod: null,
      },
      redirectUrl,
      serverId: "oauth-server",
    });

    expect(secondProvider.clientInformation()).toEqual({
      client_id: "client-123",
    });
    expect(secondProvider.tokens()).toEqual({
      access_token: "access-123",
      refresh_token: "refresh-123",
      token_type: "Bearer",
    });
    expect(
      existsSync(
        resolve(
          scratchDirectory,
          "host-mcp",
          "oauth",
          "oauth-server.json",
        ),
      ),
    ).toBe(false);

    secondProvider.invalidateCredentials("tokens");
    expect(secondProvider.tokens()).toBeUndefined();
    expect(secondProvider.clientInformation()).toEqual({
      client_id: "client-123",
    });

    manager.dispose();
  });

  it("wraps a baseUrl and injects a referenced bearer token", async () => {
    scratchDirectory = mkdtempSync(join(tmpdir(), "acon-http-wrapper-test-"));
    setPersistedHttpWrapperSecret(
      scratchDirectory,
      "example-api-token",
      "token-123",
    );

    const upstream = createServer((request, response) => {
      const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
      response.writeHead(200, {
        "content-type": "application/json",
      });
      response.end(
        JSON.stringify({
          authorization: request.headers.authorization ?? null,
          path: requestUrl.pathname,
          query: requestUrl.search,
        }),
      );
    });

    await new Promise<void>((resolvePromise) => {
      upstream.listen(0, "127.0.0.1", () => resolvePromise());
    });
    const address = upstream.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected upstream HTTP wrapper test server to expose a TCP port.");
    }

    const registry = new HostMcpRegistry();
    const sessionId = randomUUID();
    registry.registerServer({
      id: "http-wrapper",
      createServer: () =>
        createHttpWrapperHostMcpServer({
          auth: {
            type: "bearer",
            secretRef: "example-api-token",
            headerName: "Authorization",
          },
          baseUrl: `http://127.0.0.1:${address.port}/api`,
          dataDirectory: scratchDirectory,
          id: "http-wrapper",
        }),
    });

    try {
      await initializeRegistryServer(registry, "http-wrapper", sessionId);
      const result = await callHttpWrapperFetch(
        registry,
        "http-wrapper",
        sessionId,
        {
          path: "users",
          query: {
            page: 2,
          },
        },
      );

      expect(result).toEqual(
        expect.objectContaining({
          structuredContent: expect.objectContaining({
            ok: true,
            status: 200,
            json: expect.objectContaining({
              authorization: "Bearer token-123",
              path: "/api/users",
              query: "?page=2",
            }),
          }),
        }),
      );
    } finally {
      await registry.closeSession("http-wrapper", sessionId);
      registry.dispose();
      await new Promise<void>((resolvePromise, rejectPromise) => {
        upstream.close((error) => {
          if (error) {
            rejectPromise(error);
            return;
          }
          resolvePromise();
        });
      });
    }
  });

  it("runs the repo-local REST API server over stdio with env secret refs", async () => {
    scratchDirectory = mkdtempSync(join(tmpdir(), "acon-rest-api-mcp-test-"));
    setPersistedHostSecret(scratchDirectory, "rest-api-token", "token-123");

    const upstream = createServer((request, response) => {
      const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
      response.writeHead(200, {
        "content-type": "application/json",
      });
      response.end(
        JSON.stringify({
          authorization: request.headers.authorization ?? null,
          path: requestUrl.pathname,
          query: requestUrl.search,
        }),
      );
    });

    await new Promise<void>((resolvePromise) => {
      upstream.listen(0, "127.0.0.1", () => resolvePromise());
    });
    const address = upstream.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected upstream REST API test server to expose a TCP port.");
    }

    const registry = new HostMcpRegistry();
    const sessionId = randomUUID();
    registry.registerServer(
      createPersistedHostMcpServerRegistration(
        {
          id: "rest-api",
          transport: "stdio",
          command: process.execPath,
          args: [resolve(process.cwd(), "desktop-container/mcp-servers/rest-api.mjs")],
          cwd: null,
          env: {
            REST_API_BASE_URL: `http://127.0.0.1:${address.port}/api`,
            REST_API_AUTH_TYPE: "bearer",
          },
          envSecretRefs: {
            REST_API_AUTH_SECRET: "rest-api-token",
          },
          name: "REST API MCP",
          version: "0.1.0",
        },
        {
          dataDirectory: scratchDirectory,
        },
      ),
    );

    try {
      await initializeRegistryServer(registry, "rest-api", sessionId);
      const result = await callHttpWrapperFetch(
        registry,
        "rest-api",
        sessionId,
        {
          path: "users",
          query: {
            page: 2,
          },
        },
      );

      expect(result).toEqual(
        expect.objectContaining({
          structuredContent: expect.objectContaining({
            ok: true,
            status: 200,
            json: expect.objectContaining({
              authorization: "Bearer token-123",
              path: "/api/users",
              query: "?page=2",
            }),
          }),
        }),
      );
    } finally {
      await registry.closeSession("rest-api", sessionId);
      registry.dispose();
      await new Promise<void>((resolvePromise, rejectPromise) => {
        upstream.close((error) => {
          if (error) {
            rejectPromise(error);
            return;
          }
          resolvePromise();
        });
      });
    }
  });

  it("defaults OAuth registration to a public client and falls back clientMetadataUrl to clientUri", async () => {
    scratchDirectory = mkdtempSync(join(tmpdir(), "acon-host-mcp-oauth-"));
    const manager = new HostMcpOAuthManager({
      browserOpener: vi.fn(async () => {}),
    });
    const provider = new PersistedHostMcpOAuthProvider({
      dataDirectory: scratchDirectory,
      manager,
      oauth: {
        clientId: null,
        clientMetadataUrl: null,
        clientName: "Acon OAuth Test",
        clientSecret: null,
        clientUri: "https://example.com/oauth/acon-client.json",
        scope: "tools.read",
        tokenEndpointAuthMethod: null,
      },
      redirectUrl: await manager.getRedirectUrl("oauth-public-client"),
      serverId: "oauth-public-client",
    });

    expect(provider.clientMetadataUrl).toBe(
      "https://example.com/oauth/acon-client.json",
    );
    expect(provider.clientMetadata).toEqual(
      expect.objectContaining({
        client_name: "Acon OAuth Test",
        token_endpoint_auth_method: "none",
      }),
    );

    manager.dispose();
  });

  it("includes client_id in token requests even for client_secret_basic auth", async () => {
    scratchDirectory = mkdtempSync(join(tmpdir(), "acon-host-mcp-oauth-"));
    const manager = new HostMcpOAuthManager({
      browserOpener: vi.fn(async () => {}),
    });
    const provider = new PersistedHostMcpOAuthProvider({
      dataDirectory: scratchDirectory,
      manager,
      oauth: {
        clientId: "client-123",
        clientMetadataUrl: null,
        clientName: "Acon OAuth Test",
        clientSecret: "secret-123",
        clientUri: null,
        scope: "tools.read",
        tokenEndpointAuthMethod: "client_secret_basic",
      },
      redirectUrl: await manager.getRedirectUrl("oauth-basic-client"),
      serverId: "oauth-basic-client",
    });

    const headers = new Headers();
    const params = new URLSearchParams();
    await provider.addClientAuthentication(
      headers,
      params,
      "https://auth.example.com/token",
    );

    expect(params.get("client_id")).toBe("client-123");
    expect(params.get("client_secret")).toBe(null);
    expect(headers.get("Authorization")).toBe(
      `Basic ${Buffer.from("client-123:secret-123", "utf8").toString("base64")}`,
    );

    manager.dispose();
  });

  it("does not send client_secret for dynamically registered public clients during code exchange", async () => {
    scratchDirectory = mkdtempSync(join(tmpdir(), "acon-host-mcp-oauth-"));
    const manager = new HostMcpOAuthManager({
      browserOpener: vi.fn(async () => {}),
    });
    const provider = new PersistedHostMcpOAuthProvider({
      dataDirectory: scratchDirectory,
      manager,
      oauth: {
        clientId: null,
        clientMetadataUrl: null,
        clientName: "Acon OAuth Test",
        clientSecret: null,
        clientUri: null,
        scope: "tools.read",
        tokenEndpointAuthMethod: null,
      },
      redirectUrl: await manager.getRedirectUrl("oauth-public-dynamic-client"),
      serverId: "oauth-public-dynamic-client",
    });

    let tokenRequestBody = "";
    const fetchFn: typeof fetch = vi.fn(async (input, init) => {
      const url =
        input instanceof URL
          ? input
          : new URL(typeof input === "string" ? input : input.url);

      if (url.pathname.includes(".well-known/oauth-protected-resource")) {
        return new Response("not found", {
          status: 404,
          headers: {
            "content-type": "text/plain",
          },
        });
      }

      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return new Response(
          JSON.stringify({
            authorization_endpoint: "https://auth.example.com/authorize",
            code_challenge_methods_supported: ["S256"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            issuer: "https://auth.example.com",
            registration_endpoint: "https://auth.example.com/register",
            response_types_supported: ["code"],
            token_endpoint: "https://auth.example.com/token",
            token_endpoint_auth_methods_supported: [
              "client_secret_basic",
              "client_secret_post",
              "none",
            ],
          }),
          {
            headers: {
              "content-type": "application/json",
            },
            status: 200,
          },
        );
      }

      if (url.pathname === "/register") {
        return new Response(
          JSON.stringify({
            client_id: "dynamic-client-123",
            client_id_issued_at: 1,
            client_name: "Acon OAuth Test",
            client_secret: "dynamic-secret-123",
            client_secret_expires_at: 0,
            grant_types: ["authorization_code", "refresh_token"],
            redirect_uris: [provider.redirectUrl],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
          }),
          {
            headers: {
              "content-type": "application/json",
            },
            status: 200,
          },
        );
      }

      if (url.pathname === "/token") {
        tokenRequestBody = String(init?.body ?? "");
        expect(tokenRequestBody).toContain("client_id=dynamic-client-123");
        expect(tokenRequestBody).not.toContain("client_secret=");
        return new Response(
          JSON.stringify({
            access_token: "access-123",
            refresh_token: "refresh-123",
            token_type: "Bearer",
          }),
          {
            headers: {
              "content-type": "application/json",
            },
            status: 200,
          },
        );
      }

      throw new Error(`Unexpected fetch to ${url.toString()}`);
    });

    expect(
      await auth(provider, {
        fetchFn,
        serverUrl: "https://auth.example.com/mcp",
      }),
    ).toBe("REDIRECT");
    await fetch(`${provider.redirectUrl}?code=code-123`);

    expect(
      await auth(provider, {
        authorizationCode: "code-123",
        fetchFn,
        serverUrl: "https://auth.example.com/mcp",
      }),
    ).toBe("AUTHORIZED");
    expect(tokenRequestBody).toContain("code=code-123");
    expect(provider.tokens()).toEqual({
      access_token: "access-123",
      refresh_token: "refresh-123",
      token_type: "Bearer",
    });

    manager.dispose();
  });
});
