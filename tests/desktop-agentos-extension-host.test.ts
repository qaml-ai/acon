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
  it("discovers builtin v2 extensions and exposes page plus preview surfaces", async () => {
    const host = new CamelAIExtensionHost();
    const context = createActivationContext();

    await host.initialize(context);
    const snapshot = host.getSnapshot(context);

    expect(snapshot.plugins.map((plugin) => plugin.id)).toEqual(
      expect.arrayContaining([
        "extension-lab",
        "random-site-preview",
        "thread-journal",
      ]),
    );

    expect(snapshot.pages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "plugin:extension-lab:extension-lab.home",
          surface: "page",
        }),
        expect.objectContaining({
          id: "plugin:random-site-preview:random-site-preview.frame",
          surface: "preview",
        }),
      ]),
    );
    expect(host.getDefaultThreadPreviewPageId()).toBe(
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
