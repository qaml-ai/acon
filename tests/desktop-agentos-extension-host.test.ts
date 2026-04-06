import { describe, expect, it } from "vitest";
import { CamelAIExtensionHost } from "../desktop-agentos/backend/extensions/host";

function createActivationContext() {
  return {
    provider: "agentos" as const,
    harness: "pi" as const,
    model: "claude-sonnet-4-20250514",
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
        "random-site-preview",
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
    expect(snapshot.panels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "plugin:random-site-preview:random-site-preview.frame",
          autoOpen: "all-threads",
        }),
      ]),
    );
    expect(host.getDefaultViewId("thread")).toBe(
      "plugin:chat-core:chat-core.thread",
    );
    expect(host.getDefaultThreadPanelId()).toBe(
      "plugin:random-site-preview:random-site-preview.frame",
    );
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
});
