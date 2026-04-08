import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CamelAIExtensionHost } from "../desktop-container/backend/extensions/host";

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

  it("requires an explicit host-mcp permission before privileged host MCP APIs can be used", async () => {
    writeUserPlugin(sandboxDataDir, {
      id: "missing-host-mcp-permission",
      code: `
        export default {
          activate(api) {
            api.registerHostMcpServer({
              id: "missing-host-mcp-permission.server",
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
      registerHostMcpServer: vi.fn(),
    });
    const context = createActivationContext();

    await host.initialize(context);
    const plugin = host
      .getSnapshot(context)
      .plugins.find((entry) => entry.id === "missing-host-mcp-permission");

    expect(plugin?.runtime.activationError).toContain("host-mcp");
  });

  it("cleans up host MCP registrations when plugins refresh", async () => {
    const registerHostMcpServer = vi.fn();
    const unregisterHostMcpServer = vi.fn();
    const host = new CamelAIExtensionHost({
      registerHostMcpServer,
      unregisterHostMcpServer,
    });
    const context = createActivationContext();

    await host.initialize(context);
    await host.refresh(context);

    expect(registerHostMcpServer).toHaveBeenCalledTimes(2);
    expect(registerHostMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "host-mcp-manager",
      }),
    );
    expect(unregisterHostMcpServer).toHaveBeenCalledWith(
      "host-mcp-manager",
    );
  });
});
