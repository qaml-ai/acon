import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CamelAIExtensionHost } from "../desktop-container/backend/extensions/host";
import { HostMcpRegistry } from "../desktop-container/backend/host-mcp";

function createActivationContext() {
  return {
    provider: "claude" as const,
    harness: "claude-code" as const,
    model: "sonnet",
    activeThreadId: "thread-1",
    runtimeStatus: {
      state: "running" as const,
      detail: "Runtime ready",
      helperPath: null,
      runtimeDirectory: "/tmp/runtime",
    },
    runtimeDirectory: "/tmp/runtime",
    workspaceDirectory: "/tmp/workspace",
    threadStateDirectory: "/tmp/camelai-state/thread-1",
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

function getResultMessage(messages: Array<Record<string, unknown>>, id: number) {
  const errorMessage = messages.find(
    (message) => message.id === id && "error" in message,
  );
  if (errorMessage) {
    throw new Error(
      String(
        (errorMessage.error as { message?: unknown } | undefined)?.message ??
          `request ${id} failed`,
      ),
    );
  }

  return messages.find((message) => message.id === id && "result" in message) ?? null;
}

describe("CamelAIExtensionHost", () => {
  it("discovers builtin v2 extensions and exposes workbench views plus panels", async () => {
    const host = new CamelAIExtensionHost();
    const context = createActivationContext();

    await host.initialize(context);
    const snapshot = host.getSnapshot(context);

    expect(snapshot.plugins.map((plugin) => plugin.id)).toEqual(
      expect.arrayContaining([
        "chat-core",
        "extension-lab",
        "host-mcp-manager",
        "thread-journal",
      ]),
    );

    expect(snapshot.views).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "plugin:chat-core:chat-core.thread",
          scope: "thread",
          isDefault: true,
        }),
        expect.objectContaining({
          id: "plugin:extension-lab:extension-lab.home",
          scope: "workspace",
          isDefault: false,
        }),
      ]),
    );
    expect(snapshot.panels).toEqual([]);
    expect(host.getDefaultViewId("thread")).toBe(
      "plugin:chat-core:chat-core.thread",
    );
    expect(host.getDefaultThreadPanelId()).toBe(null);
  });

  it("runs before_prompt hooks from the new runtime-first extension API", async () => {
    const host = new CamelAIExtensionHost();
    const context = createActivationContext();

    await host.initialize(context);
    const result = await host.applyBeforePrompt(
      "thread-1",
      "Check the repo status.",
      context,
    );

    expect(result.cancelled).toBe(false);
    expect(result.content).toBe("Check the repo status.");

    const threadJournal = host
      .getSnapshot(context)
      .plugins.find((plugin) => plugin.id === "thread-journal");
    expect(threadJournal?.runtime.subscribedEvents).toContain("before_prompt");
  });

  it("registers the builtin host MCP manager server", async () => {
    const registerHostMcpServer = vi.fn();
    const host = new CamelAIExtensionHost({
      registerHostMcpServer,
    });
    const context = createActivationContext();

    await host.initialize(context);

    expect(registerHostMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "host-mcp-manager",
      }),
    );
  });

  it("exposes install_http_server through the builtin host MCP manager", async () => {
    const registerHostMcpServer = vi.fn();
    const installHttpHostMcpServer = vi.fn().mockReturnValue({
      configPath: "/tmp/host-mcp/servers/remote-server.json",
      headers: {
        "x-test": "1",
      },
      id: "remote-server",
      name: "Remote Server",
      oauth: {
        clientId: null,
        clientMetadataUrl: null,
        clientName: "Acon",
        clientSecret: null,
        clientUri: null,
        scope: "tools.read",
        tokenEndpointAuthMethod: null,
      },
      replaced: false,
      transport: "streamable-http",
      url: "https://example.com/mcp",
      version: "1.0.0",
    });
    const host = new CamelAIExtensionHost({
      installHttpHostMcpServer,
      listInstalledHostMcpServers: () => [],
      registerHostMcpServer,
      uninstallInstalledHostMcpServer: () => false,
    });
    const context = createActivationContext();

    await host.initialize(context);

    const registration = registerHostMcpServer.mock.calls.find(
      ([entry]) => entry?.id === "host-mcp-manager",
    )?.[0];
    expect(registration).toBeTruthy();

    const registry = new HostMcpRegistry();
    const sessionId = randomUUID();
    registry.registerServer(registration);

    try {
      await initializeRegistryServer(registry, "host-mcp-manager", sessionId);

      const toolsList = await registry.dispatchRequest({
        serverId: "host-mcp-manager",
        sessionId,
        message: {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        },
      });
      const toolsListMessage = getResultMessage(
        toolsList.messages as Array<Record<string, unknown>>,
        2,
      );
      const toolNames =
        toolsListMessage &&
        typeof toolsListMessage.result === "object" &&
        toolsListMessage.result &&
        Array.isArray((toolsListMessage.result as { tools?: unknown[] }).tools)
          ? (toolsListMessage.result as { tools: Array<{ name?: unknown }> }).tools
              .map((tool) => (typeof tool.name === "string" ? tool.name : ""))
              .filter(Boolean)
          : [];

      expect(toolNames).toContain("install_http_server");

      const installResponse = await registry.dispatchRequest({
        serverId: "host-mcp-manager",
        sessionId,
        message: {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "install_http_server",
            arguments: {
              id: "remote-server",
              transport: "streamable-http",
              url: "https://example.com/mcp",
              headers: {
                "x-test": "1",
              },
              oauth: {
                clientName: "Acon",
                scope: "tools.read",
              },
              name: "Remote Server",
              version: "1.0.0",
            },
          },
        },
      });
      const installMessage = getResultMessage(
        installResponse.messages as Array<Record<string, unknown>>,
        3,
      );

      expect(installHttpHostMcpServer).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "remote-server",
          transport: "streamable-http",
          url: "https://example.com/mcp",
        }),
        "/tmp/workspace",
      );
      expect(installMessage).toEqual(
        expect.objectContaining({
          result: expect.objectContaining({
            structuredContent: expect.objectContaining({
              id: "remote-server",
              transport: "streamable-http",
              url: "https://example.com/mcp",
            }),
          }),
        }),
      );
    } finally {
      await registry.closeSession("host-mcp-manager", sessionId);
      registry.dispose();
    }
  });
});
