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
    const messages: Array<Record<string, unknown>> = [];
    const mcpRequestSpy = vi
      .spyOn(client, "mcpRequest")
      .mockImplementation(async (_serverId, _sessionId, message) => {
        messages.push(message as Record<string, unknown>);
        if (
          message &&
          typeof message === "object" &&
          "method" in message &&
          message.method === "tools/list"
        ) {
          return [
            {
              jsonrpc: "2.0",
              id: 2,
              result: {
                tools: [{ name: "host_echo" }],
              },
            },
          ];
        }
        return [];
      });
    const closeSpy = vi
      .spyOn(client, "closeMcpSession")
      .mockResolvedValue({ ok: true });

    const tools = await client.listMcpTools("server-1");

    expect(tools).toEqual([{ name: "host_echo" }]);
    expect(messages).toEqual([
      expect.objectContaining({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
      }),
      {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      },
    ]);
    expect(mcpRequestSpy).toHaveBeenCalledTimes(3);
    expect(closeSpy).toHaveBeenCalledWith("server-1", expect.any(String));
  });

  it("reuses caller-provided sessions for tool calls without reinitializing or closing them", async () => {
    const client = new HostRpcClient({
      socketPath: "/tmp/unused.sock",
      timeoutMs: 1,
    });
    const mcpRequestSpy = vi
      .spyOn(client, "mcpRequest")
      .mockResolvedValue([
        {
          jsonrpc: "2.0",
          id: 3,
          result: {
            structuredContent: {
              echoedText: "hello",
            },
          },
        },
      ]);
    const closeSpy = vi
      .spyOn(client, "closeMcpSession")
      .mockResolvedValue({ ok: true });

    const result = await client.callMcpTool(
      "server-1",
      "host_echo",
      { text: "hello" },
      { sessionId: "existing-session" },
    );

    expect(result).toEqual({
      structuredContent: {
        echoedText: "hello",
      },
    });
    expect(mcpRequestSpy).toHaveBeenCalledTimes(1);
    expect(mcpRequestSpy).toHaveBeenCalledWith(
      "server-1",
      "existing-session",
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "host_echo",
          arguments: {
            text: "hello",
          },
        },
      },
    );
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it("surfaces MCP tool-call failures as HostRpcError", async () => {
    const client = new HostRpcClient({
      socketPath: "/tmp/unused.sock",
      timeoutMs: 1,
    });
    vi.spyOn(client, "mcpRequest")
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          jsonrpc: "2.0",
          id: 3,
          error: {
            message: "Tool invocation failed",
          },
        },
      ]);
    vi.spyOn(client, "closeMcpSession").mockResolvedValue({ ok: true });

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
