import type { CamelAIExtensionModule } from "../../../sdk";

const extension: CamelAIExtensionModule = {
  activate(api) {
    api.registerView("chat-core.thread", {
      title: "Chat",
      description: "Thread-focused chat workspace.",
      icon: "MessagesSquare",
      scope: "thread",
      default: true,
      render: {
        kind: "host",
        component: "chat-thread",
      },
    });
  },
};

export default extension;
