import type { CamelAIExtensionModule } from "../../../sdk";

const extension: CamelAIExtensionModule = {
  activate(api) {
    api.registerView("kanban.board", {
      title: "Kanban",
      description: "Manage local chat threads across workflow lanes.",
      icon: "KanbanSquare",
      scope: "workspace",
      render: {
        kind: "host",
        component: "board",
      },
    });
  },
};

export default extension;
