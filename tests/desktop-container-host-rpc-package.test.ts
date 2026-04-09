import { describe, expect, it, vi } from "vitest";
import {
  HostRpcClient,
  HostRpcError,
} from "../desktop-container/container-images/npm-packages/acon-host-rpc/index.js";

describe("@acon/host-rpc managed MCP helpers", () => {
  it("initializes and closes managed sessions when listing tools", async () => {
    const client = new HostRpcClient({
      socketPath: "/tmp/unused.sock",
      timeoutMs: 1,
    });
    const requests: Array<{ method: string; params: unknown }> = [];

    vi.spyOn(client, "request").mockImplementation(async (method, params) => {
      requests.push({ method, params });

      if (
        method === "mcp.request" &&
        params &&
        typeof params === "object" &&
        "message" in params &&
        params.message &&
        typeof params.message === "object" &&
        "method" in params.message &&
        params.message.method === "tools/list"
      ) {
        return {
          messages: [
            {
              jsonrpc: "2.0",
              id: 2,
              result: {
                tools: [{ name: "host_echo" }],
              },
            },
          ],
        };
      }

      return method === "mcp.close" ? { ok: true } : { messages: [] };
    });

    const tools = await client.listMcpTools("server-1");

    expect(tools).toEqual([{ name: "host_echo" }]);
    expect(requests).toHaveLength(4);

    const sessionId = (requests[0].params as { sessionId: string }).sessionId;
    expect(requests).toEqual([
      {
        method: "mcp.request",
        params: {
          serverId: "server-1",
          sessionId,
          message: expect.objectContaining({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
          }),
        },
      },
      {
        method: "mcp.request",
        params: {
          serverId: "server-1",
          sessionId,
          message: {
            jsonrpc: "2.0",
            method: "notifications/initialized",
          },
        },
      },
      {
        method: "mcp.request",
        params: {
          serverId: "server-1",
          sessionId,
          message: {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/list",
            params: {},
          },
        },
      },
      {
        method: "mcp.close",
        params: {
          serverId: "server-1",
          sessionId,
        },
      },
    ]);
  });

  it("supports prompt and resource convenience helpers without exposing raw MCP requests", async () => {
    const client = new HostRpcClient({
      socketPath: "/tmp/unused.sock",
      timeoutMs: 1,
    });

    vi.spyOn(client, "request").mockImplementation(async (method, params) => {
      if (
        method === "mcp.request" &&
        params &&
        typeof params === "object" &&
        "message" in params &&
        params.message &&
        typeof params.message === "object" &&
        "method" in params.message
      ) {
        switch (params.message.method) {
          case "prompts/list":
            return {
              messages: [
                {
                  jsonrpc: "2.0",
                  id: 4,
                  result: {
                    prompts: [{ name: "summarize" }],
                  },
                },
              ],
            };
          case "prompts/get":
            return {
              messages: [
                {
                  jsonrpc: "2.0",
                  id: 5,
                  result: {
                    description: "Summarize a topic",
                    messages: [
                      {
                        role: "user",
                        content: {
                          type: "text",
                          text: "Summarize release notes",
                        },
                      },
                    ],
                  },
                },
              ],
            };
          case "resources/list":
            return {
              messages: [
                {
                  jsonrpc: "2.0",
                  id: 6,
                  result: {
                    resources: [{ name: "README", uri: "file:///workspace/README.md" }],
                  },
                },
              ],
            };
          case "resources/templates/list":
            return {
              messages: [
                {
                  jsonrpc: "2.0",
                  id: 8,
                  result: {
                    resourceTemplates: [
                      {
                        name: "workspace-file",
                        uriTemplate: "file:///workspace/{path}",
                      },
                    ],
                  },
                },
              ],
            };
          case "resources/read":
            return {
              messages: [
                {
                  jsonrpc: "2.0",
                  id: 7,
                  result: {
                    contents: [
                      {
                        uri: "file:///workspace/README.md",
                        text: "hello",
                      },
                    ],
                  },
                },
              ],
            };
          default:
            return { messages: [] };
        }
      }

      return method === "mcp.close" ? { ok: true } : { messages: [] };
    });

    await expect(client.listMcpPrompts("server-1")).resolves.toEqual([
      { name: "summarize" },
    ]);
    await expect(
      client.getMcpPrompt("server-1", "summarize", { topic: "release" }),
    ).resolves.toEqual({
      description: "Summarize a topic",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "Summarize release notes",
          },
        },
      ],
    });
    await expect(client.listMcpResources("server-1")).resolves.toEqual([
      { name: "README", uri: "file:///workspace/README.md" },
    ]);
    await expect(client.listMcpResourceTemplates("server-1")).resolves.toEqual([
      {
        name: "workspace-file",
        uriTemplate: "file:///workspace/{path}",
      },
    ]);
    await expect(
      client.readMcpResource("server-1", "file:///workspace/README.md"),
    ).resolves.toEqual({
      contents: [
        {
          uri: "file:///workspace/README.md",
          text: "hello",
        },
      ],
    });
  });

  it("supports grouped MCP interactions through withMcpSession", async () => {
    const client = new HostRpcClient({
      socketPath: "/tmp/unused.sock",
      timeoutMs: 1,
    });
    const requests: Array<{ method: string; params: unknown }> = [];

    vi.spyOn(client, "request").mockImplementation(async (method, params) => {
      requests.push({ method, params });

      if (
        method === "mcp.request" &&
        params &&
        typeof params === "object" &&
        "message" in params &&
        params.message &&
        typeof params.message === "object" &&
        "method" in params.message
      ) {
        switch (params.message.method) {
          case "tools/list":
            return {
              messages: [
                {
                  jsonrpc: "2.0",
                  id: 2,
                  result: {
                    tools: [{ name: "host_echo" }],
                  },
                },
              ],
            };
          case "prompts/get":
            return {
              messages: [
                {
                  jsonrpc: "2.0",
                  id: 5,
                  result: {
                    messages: [
                      {
                        role: "user",
                        content: {
                          type: "text",
                          text: "hello",
                        },
                      },
                    ],
                  },
                },
              ],
            };
          default:
            return { messages: [] };
        }
      }

      return method === "mcp.close" ? { ok: true } : { messages: [] };
    });

    const result = await client.withMcpSession("server-1", async (session) => {
      const tools = await session.listTools();
      const prompt = await session.getPrompt("summarize");
      return {
        serverId: session.serverId,
        tools,
        prompt,
      };
    });

    expect(result).toEqual({
      serverId: "server-1",
      tools: [{ name: "host_echo" }],
      prompt: {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: "hello",
            },
          },
        ],
      },
    });
    expect(requests).toHaveLength(5);
    const sessionId = (requests[0].params as { sessionId: string }).sessionId;
    expect(
      requests.filter(
        (request) =>
          request.method === "mcp.request" &&
          request.params &&
          typeof request.params === "object" &&
          "sessionId" in request.params &&
          request.params.sessionId === sessionId,
      ),
    ).toHaveLength(4);
    expect(requests[4]).toEqual({
      method: "mcp.close",
      params: {
        serverId: "server-1",
        sessionId,
      },
    });
  });

  it("surfaces MCP tool-call failures as HostRpcError", async () => {
    const client = new HostRpcClient({
      socketPath: "/tmp/unused.sock",
      timeoutMs: 1,
    });

    vi.spyOn(client, "request").mockImplementation(async (method, params) => {
      if (
        method === "mcp.request" &&
        params &&
        typeof params === "object" &&
        "message" in params &&
        params.message &&
        typeof params.message === "object" &&
        "method" in params.message &&
        params.message.method === "tools/call"
      ) {
        return {
          messages: [
            {
              jsonrpc: "2.0",
              id: 3,
              error: {
                message: "Tool invocation failed",
              },
            },
          ],
        };
      }

      return method === "mcp.close" ? { ok: true } : { messages: [] };
    });

    await expect(
      client.callMcpTool("server-1", "host_echo", { text: "hello" }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<HostRpcError>>({
        name: "HostRpcError",
        message: "Tool invocation failed",
        code: "MCP_TOOL_CALL_FAILED",
        method: "tools/call",
      }),
    );
  });
});
