import type { CamelAIExtensionModule } from "../../../sdk";

const extension: CamelAIExtensionModule = {
  activate(api) {
    api.registerView("chat.thread", {
      title: "Chat",
      description: "Thread-focused chat workspace.",
      icon: "MessagesSquare",
      scope: "thread",
      default: true,
      render: {
        kind: "host",
        component: "thread-view",
      },
    });

    api.registerSidebarPanel("chat.recent-threads", {
      title: "Recent Chats",
      description: "Browse and resume local chat threads.",
      icon: "MessagesSquare",
      placement: "content",
      order: 100,
      render: {
        kind: "host",
        component: "recent-threads",
      },
    });
  },
};

export default extension;
