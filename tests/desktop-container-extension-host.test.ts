import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function writeUserPlugin(
  dataDir: string,
  options: {
    id: string;
    manifest?: Record<string, unknown>;
    code: string;
    files?: Record<string, string>;
  },
) {
  const pluginDirectory = resolve(dataDir, "plugins", options.id);
  mkdirSync(pluginDirectory, { recursive: true });
  writeFileSync(
    resolve(pluginDirectory, "package.json"),
    JSON.stringify(
      {
        name: `@test/${options.id}`,
        version: "0.1.0",
        type: "module",
        camelai: {
          id: options.id,
          name: options.id,
          main: "./index.mjs",
          ...(options.manifest ?? {}),
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(resolve(pluginDirectory, "index.mjs"), options.code);
  for (const [relativePath, contents] of Object.entries(options.files ?? {})) {
    const filePath = resolve(pluginDirectory, relativePath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents);
  }
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
  let sandboxDataDir: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    previousDataDir = process.env.DESKTOP_DATA_DIR;
    sandboxDataDir = mkdtempSync(join(tmpdir(), "acon-extension-host-"));
    process.env.DESKTOP_DATA_DIR = sandboxDataDir;
  });

  afterEach(() => {
    if (previousDataDir === undefined) {
      delete process.env.DESKTOP_DATA_DIR;
    } else {
      process.env.DESKTOP_DATA_DIR = previousDataDir;
    }
    rmSync(sandboxDataDir, { recursive: true, force: true });
  });

  it("discovers builtin v2 extensions and exposes workbench views", async () => {
    const host = new CamelAIExtensionHost();
    const context = createActivationContext();

    await host.initialize(context);
    const snapshot = host.getSnapshot(context);

    expect(snapshot.plugins.map((plugin) => plugin.id)).toEqual(
      expect.arrayContaining([
        "extension-lab",
        "host-mcp-manager",
        "preview-control",
        "spreadsheet-preview",
        "thread-journal",
      ]),
    );

    expect(snapshot.views).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "plugin:extension-lab:extension-lab.home",
          scope: "workspace",
          isDefault: false,
        }),
      ]),
    );
    expect(host.getDefaultViewId("workspace")).toBe(
      "plugin:extension-lab:extension-lab.home",
    );
    expect(snapshot.panels).toBeUndefined();
    expect(host.getDefaultViewId("thread")).toBe("plugin:chat:chat.thread");
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

  it("activates the builtin spreadsheet preview plugin", async () => {
    const host = new CamelAIExtensionHost();
    const context = createActivationContext();

    await host.initialize(context);

    const plugin = host
      .getSnapshot(context)
      .plugins.find((entry) => entry.id === "spreadsheet-preview");

    expect(plugin).toMatchObject({
      id: "spreadsheet-preview",
      enabled: true,
      runtime: {
        activated: true,
        activationError: null,
      },
    });
  });

  it("registers the builtin host MCP manager server", async () => {
    const registerMcpServer = vi.fn();
    const host = new CamelAIExtensionHost({
      registerMcpServer,
    });
    const context = createActivationContext();

    await host.initialize(context);

    expect(registerMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "plugin:host-mcp-manager:host-mcp-manager",
        name: "Host MCP Manager",
        pluginId: "host-mcp-manager",
        source: "plugin",
      }),
    );
  });

  it("exposes install_http_server through the builtin host MCP manager", async () => {
    const registerMcpServer = vi.fn();
    const installHttpHostMcpServer = vi.fn().mockReturnValue({
      configPath: "/tmp/host-mcp/servers/remote-server.json",
      headers: {
        "x-test": "1",
      },
      id: "remote-server",
      name: "Remote Server",
      oauth: {
        clientId: null,
        clientSecretRef: null,
        clientMetadataUrl: null,
        clientName: "Acon",
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
      registerMcpServer,
      uninstallInstalledHostMcpServer: () => false,
    });
    const context = createActivationContext();

    await host.initialize(context);

    const registration = registerMcpServer.mock.calls.find(
      ([entry]) => entry?.id === "plugin:host-mcp-manager:host-mcp-manager",
    )?.[0];
    expect(registration).toBeTruthy();

    const registry = new HostMcpRegistry();
    const sessionId = randomUUID();
    registry.registerServer(registration);

    try {
      await initializeRegistryServer(
        registry,
        "plugin:host-mcp-manager:host-mcp-manager",
        sessionId,
      );

      const toolsList = await registry.dispatchRequest({
        serverId: "plugin:host-mcp-manager:host-mcp-manager",
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
        serverId: "plugin:host-mcp-manager:host-mcp-manager",
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
        expect.objectContaining({
          pluginId: "host-mcp-manager",
          harness: "claude-code",
          threadId: "thread-1",
          workspaceDirectory: "/tmp/workspace",
        }),
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
      await registry.closeSession(
        "plugin:host-mcp-manager:host-mcp-manager",
        sessionId,
      );
      registry.dispose();
    }
  });

  it("prompts for secrets and installs the repo-local REST API server through the builtin host MCP manager", async () => {
    const registerMcpServer = vi.fn();
    const promptToStoreSecret = vi.fn().mockResolvedValue({
      secretRef: "linear-api-key",
    });
    const installStdioHostMcpServer = vi.fn().mockResolvedValue({
      configPath: "/tmp/host-mcp/servers/linear-rest.json",
      id: "linear-rest",
      transport: "stdio",
      command: "/tmp/acon-mcp-builtin.mjs",
      args: ["rest-api"],
      cwd: null,
      env: {
        REST_API_BASE_URL: "https://api.linear.app/graphql",
        REST_API_AUTH_TYPE: "bearer",
      },
      envSecretRefs: {
        REST_API_AUTH_SECRET: "linear-api-key",
      },
      name: "Linear REST",
      version: "0.1.0",
      replaced: false,
    });
    const host = new CamelAIExtensionHost({
      installStdioHostMcpServer,
      listInstalledHostMcpServers: () => [],
      promptToStoreSecret,
      registerMcpServer,
      uninstallInstalledHostMcpServer: () => false,
    });
    const context = createActivationContext();

    await host.initialize(context);

    const registration = registerMcpServer.mock.calls.find(
      ([entry]) => entry?.id === "plugin:host-mcp-manager:host-mcp-manager",
    )?.[0];
    expect(registration).toBeTruthy();

    const registry = new HostMcpRegistry();
    const sessionId = randomUUID();
    registry.registerServer(registration);

    try {
      await initializeRegistryServer(
        registry,
        "plugin:host-mcp-manager:host-mcp-manager",
        sessionId,
      );

      const promptResponse = await registry.dispatchRequest({
        serverId: "plugin:host-mcp-manager:host-mcp-manager",
        sessionId,
        message: {
          jsonrpc: "2.0",
          id: 10,
          method: "tools/call",
          params: {
            name: "prompt_to_store_secret",
            arguments: {
              secretRef: "linear-api-key",
              title: "Store Linear API key",
            },
          },
        },
      });
      const promptMessage = getResultMessage(
        promptResponse.messages as Array<Record<string, unknown>>,
        10,
      );

      expect(promptToStoreSecret).toHaveBeenCalledWith(
        {
          secretRef: "linear-api-key",
          title: "Store Linear API key",
        },
        expect.objectContaining({
          pluginId: "host-mcp-manager",
          harness: "claude-code",
          threadId: "thread-1",
        }),
      );
      expect(promptMessage).toEqual(
        expect.objectContaining({
          result: expect.objectContaining({
            structuredContent: {
              secretRef: "linear-api-key",
            },
          }),
        }),
      );

      const installResponse = await registry.dispatchRequest({
        serverId: "plugin:host-mcp-manager:host-mcp-manager",
        sessionId,
        message: {
          jsonrpc: "2.0",
          id: 11,
          method: "tools/call",
          params: {
            name: "install_rest_api_server",
            arguments: {
              id: "linear-rest",
              baseUrl: "https://api.linear.app/graphql",
              auth: {
                type: "bearer",
                secretRef: "linear-api-key",
                headerName: null,
              },
              name: "Linear REST",
            },
          },
        },
      });
      const installMessage = getResultMessage(
        installResponse.messages as Array<Record<string, unknown>>,
        11,
      );

      expect(installStdioHostMcpServer).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "linear-rest",
          command: expect.stringContaining("/desktop-container/bin/acon-mcp-builtin.mjs"),
          args: ["rest-api"],
          env: expect.objectContaining({
            REST_API_BASE_URL: "https://api.linear.app/graphql",
            REST_API_AUTH_TYPE: "bearer",
          }),
          envSecretRefs: {
            REST_API_AUTH_SECRET: "linear-api-key",
          },
        }),
        expect.objectContaining({
          pluginId: "host-mcp-manager",
          harness: "claude-code",
          threadId: "thread-1",
          workspaceDirectory: "/tmp/workspace",
        }),
      );
      expect(installMessage).toEqual(
        expect.objectContaining({
          result: expect.objectContaining({
            structuredContent: expect.objectContaining({
              id: "linear-rest",
              transport: "stdio",
            }),
          }),
        }),
      );
    } finally {
      await registry.closeSession(
        "plugin:host-mcp-manager:host-mcp-manager",
        sessionId,
      );
    }
  });

  it("lists installed plugins and installs a workspace plugin through the builtin host MCP manager", async () => {
    const registerMcpServer = vi.fn();
    const listInstalledPlugins = vi.fn().mockReturnValue([
      {
        id: "chat",
        name: "Chat",
        version: "0.1.0",
        source: "builtin",
        enabled: true,
        disableable: false,
        path: "/tmp/plugins/chat",
      },
    ]);
    const installPluginFromWorkspace = vi.fn().mockResolvedValue({
      pluginId: "todo-plugin",
      pluginName: "Todo Plugin",
      version: "0.2.0",
      installPath: "/tmp/plugins/todo-plugin",
      replaced: false,
    });
    const host = new CamelAIExtensionHost({
      listInstalledPlugins,
      installPluginFromWorkspace,
      registerMcpServer,
    });
    const context = createActivationContext();

    await host.initialize(context);

    const registration = registerMcpServer.mock.calls.find(
      ([entry]) => entry?.id === "plugin:host-mcp-manager:host-mcp-manager",
    )?.[0];
    expect(registration).toBeTruthy();

    const registry = new HostMcpRegistry();
    const sessionId = randomUUID();
    registry.registerServer(registration);

    try {
      await initializeRegistryServer(
        registry,
        "plugin:host-mcp-manager:host-mcp-manager",
        sessionId,
      );

      const listResponse = await registry.dispatchRequest({
        serverId: "plugin:host-mcp-manager:host-mcp-manager",
        sessionId,
        message: {
          jsonrpc: "2.0",
          id: 20,
          method: "tools/call",
          params: {
            name: "list_installed_plugins",
            arguments: {},
          },
        },
      });
      const listMessage = getResultMessage(
        listResponse.messages as Array<Record<string, unknown>>,
        20,
      );

      expect(listInstalledPlugins).toHaveBeenCalledTimes(1);
      expect(listMessage).toEqual(
        expect.objectContaining({
          result: expect.objectContaining({
            structuredContent: {
              plugins: [
                expect.objectContaining({
                  id: "chat",
                  source: "builtin",
                }),
              ],
            },
          }),
        }),
      );

      const installResponse = await registry.dispatchRequest({
        serverId: "plugin:host-mcp-manager:host-mcp-manager",
        sessionId,
        message: {
          jsonrpc: "2.0",
          id: 21,
          method: "tools/call",
          params: {
            name: "install_workspace_plugin",
            arguments: {
              path: "plugins/todo-plugin",
            },
          },
        },
      });
      const installMessage = getResultMessage(
        installResponse.messages as Array<Record<string, unknown>>,
        21,
      );

      expect(installPluginFromWorkspace).toHaveBeenCalledWith(
        {
          path: "plugins/todo-plugin",
        },
        expect.objectContaining({
          pluginId: "host-mcp-manager",
          harness: "claude-code",
          threadId: "thread-1",
          workspaceDirectory: "/tmp/workspace",
        }),
      );
      expect(installMessage).toEqual(
        expect.objectContaining({
          result: expect.objectContaining({
            structuredContent: expect.objectContaining({
              pluginId: "todo-plugin",
              pluginName: "Todo Plugin",
            }),
          }),
        }),
      );
    } finally {
      await registry.closeSession(
        "plugin:host-mcp-manager:host-mcp-manager",
        sessionId,
      );
    }
  });

  it("lists bundled plugin agent assets through the builtin host MCP manager", async () => {
    const registerMcpServer = vi.fn();
    const listPluginAgentAssets = vi.fn().mockReturnValue([
      {
        pluginId: "agent-assets-plugin",
        pluginName: "Agent Assets Plugin",
        pluginVersion: "0.3.0",
        source: "user",
        path: "/tmp/plugins/agent-assets-plugin",
        skills: [{ id: "authoring" }],
        mcpServers: [
          {
            id: "docs",
            transport: "stdio",
            name: null,
            version: null,
          },
        ],
        installedByProvider: [
          {
            provider: "codex",
            installedSkillIds: [],
            installedMcpServerIds: [],
          },
          {
            provider: "claude",
            installedSkillIds: [],
            installedMcpServerIds: [],
          },
        ],
      },
    ]);
    const host = new CamelAIExtensionHost({
      listPluginAgentAssets,
      registerMcpServer,
    });
    const context = createActivationContext();

    await host.initialize(context);

    const registration = registerMcpServer.mock.calls.find(
      ([entry]) => entry?.id === "plugin:host-mcp-manager:host-mcp-manager",
    )?.[0];
    expect(registration).toBeTruthy();

    const registry = new HostMcpRegistry();
    const sessionId = randomUUID();
    registry.registerServer(registration);

    try {
      await initializeRegistryServer(
        registry,
        "plugin:host-mcp-manager:host-mcp-manager",
        sessionId,
      );

      const listResponse = await registry.dispatchRequest({
        serverId: "plugin:host-mcp-manager:host-mcp-manager",
        sessionId,
        message: {
          jsonrpc: "2.0",
          id: 22,
          method: "tools/call",
          params: {
            name: "list_plugin_agent_assets",
            arguments: {},
          },
        },
      });
      const listMessage = getResultMessage(
        listResponse.messages as Array<Record<string, unknown>>,
        22,
      );

      expect(listPluginAgentAssets).toHaveBeenCalledWith(null);
      expect(listMessage).toEqual(
        expect.objectContaining({
          result: expect.objectContaining({
            structuredContent: {
              plugins: [
                expect.objectContaining({
                  pluginId: "agent-assets-plugin",
                  skills: [{ id: "authoring" }],
                }),
              ],
            },
          }),
        }),
      );
    } finally {
      await registry.closeSession(
        "plugin:host-mcp-manager:host-mcp-manager",
        sessionId,
      );
    }
  });
  it("keeps disabled plugins discovered without activating or contributing surfaces", async () => {
    writeUserPlugin(sandboxDataDir, {
      id: "disabled-user-plugin",
      code: `
        export default {
          activate(api) {
            api.registerView("disabled.view", {
              title: "Disabled",
              render: { kind: "host", component: "extension-catalog" },
            });
          },
        };
      `,
    });

    const host = new CamelAIExtensionHost({
      isPluginEnabled: (pluginId) => pluginId !== "disabled-user-plugin",
    });
    const context = createActivationContext();

    await host.initialize(context);
    const snapshot = host.getSnapshot(context);
    const plugin = snapshot.plugins.find(
      (entry) => entry.id === "disabled-user-plugin",
    );

    expect(plugin).toMatchObject({
      id: "disabled-user-plugin",
      enabled: false,
      disableable: true,
    });
    expect(plugin?.runtime.activated).toBe(false);
    expect(
      snapshot.views.some((view) => view.pluginId === "disabled-user-plugin"),
    ).toBe(false);
  });

  it("requires an explicit serve-mcp permission before plugins can expose MCP servers", async () => {
    writeUserPlugin(sandboxDataDir, {
      id: "missing-serve-mcp-permission",
      code: `
        export default {
          activate(api) {
            api.registerMcpServer("missing-serve-mcp-permission.server", {
              createServer() {
                return {
                  async connect() {},
                  async close() {},
                };
              },
            });
          },
        };
      `,
    });

    const host = new CamelAIExtensionHost({
      registerMcpServer: vi.fn(),
    });
    const context = createActivationContext();

    await host.initialize(context);
    const plugin = host
      .getSnapshot(context)
      .plugins.find((entry) => entry.id === "missing-serve-mcp-permission");

    expect(plugin?.runtime.activationError).toContain("serve-mcp");
  });

  it("turns malformed view registrations into activation errors instead of crashing snapshots", async () => {
    const host = new CamelAIExtensionHost();
    const context = createActivationContext();

    await host.initialize(context);
    const record = {
      discovered: {
        id: "malformed-view-plugin",
        extensionPath: "/tmp/plugins/malformed-view-plugin",
        entryPath: "/tmp/plugins/malformed-view-plugin/index.mjs",
        builtin: false,
        packageName: "@test/malformed-view-plugin",
        packageVersion: "0.1.0",
        manifest: {
          id: "malformed-view-plugin",
          name: "Malformed View Plugin",
          version: "0.1.0",
          description: "",
          webviews: {},
          permissions: [],
          apiVersion: 1,
          minApiVersion: 1,
        },
      },
      enabled: true,
      activated: false,
      activationError: null,
      compatibilityError: null,
      views: new Map(),
      sidebarPanels: new Map(),
      commands: new Map(),
      previewProviders: new Map(),
      tools: new Map(),
      handlers: new Map(),
      disposables: [],
      registeredHostMcpServerIds: new Set(),
    };
    let activationError: Error | null = null;
    try {
      (host as any).createApi(record, context).registerView("invalid.view", null);
    } catch (error) {
      activationError = error instanceof Error ? error : new Error(String(error));
    }
    record.activationError = activationError?.message ?? null;
    (host as any).records.set(record.discovered.id, record);

    const snapshot = host.getSnapshot(context);
    const plugin = snapshot.plugins.find((entry) => entry.id === "malformed-view-plugin");

    expect(plugin?.runtime.activated).toBe(false);
    expect(plugin?.runtime.activationError).toContain("invalid view");
    expect(
      snapshot.views.some((view) => view.pluginId === "malformed-view-plugin"),
    ).toBe(false);
  });

  it("cleans up host MCP registrations when plugins refresh", async () => {
    const registerMcpServer = vi.fn();
    const unregisterMcpServer = vi.fn();
    const host = new CamelAIExtensionHost({
      registerMcpServer,
      unregisterMcpServer,
    });
    const context = createActivationContext();

    await host.initialize(context);
    await host.refresh(context);

    expect(registerMcpServer).toHaveBeenCalledTimes(4);
    expect(registerMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "plugin:host-mcp-manager:host-mcp-manager",
      }),
    );
    expect(registerMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "plugin:preview-control:preview-control",
      }),
    );
    expect(unregisterMcpServer).toHaveBeenCalledWith(
      "plugin:host-mcp-manager:host-mcp-manager",
    );
    expect(unregisterMcpServer).toHaveBeenCalledWith(
      "plugin:preview-control:preview-control",
    );
  });
});
