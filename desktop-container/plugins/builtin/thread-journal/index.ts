import type { CamelAIExtensionModule } from "../../../sdk";

const extension: CamelAIExtensionModule = {
  activate(api) {
    api.registerCommand("thread-journal.reset", {
      title: "Reset Thread Journal",
      description: "Clear stored prompt history for the active thread.",
      async run(context) {
        context.threadState.clear();
      },
    });

    api.registerTool("thread-journal.snapshot", {
      title: "Thread Journal Snapshot",
      description: "Return the current thread journal snapshot.",
      availableTo: ["*"],
      async execute(_params, context) {
        return {
          threadId: context.threadId ?? null,
          state: context.threadState.snapshot(),
        };
      },
    });

    api.on("before_prompt", async (event, context) => {
      const count = context.threadState.get<number>("promptCount") ?? 0;
      context.threadState.set("promptCount", count + 1);
      context.threadState.set("lastPromptPreview", String(event.content).slice(0, 120));
      return undefined;
    });
  },
};

export default extension;
