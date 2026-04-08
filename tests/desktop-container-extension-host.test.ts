import { describe, expect, it, vi } from "vitest";
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
});
