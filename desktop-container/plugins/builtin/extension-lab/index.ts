import type { CamelAIExtensionModule } from "../../../sdk";

const extension: CamelAIExtensionModule = {
  activate(api) {
    api.registerView("extension-lab.home", {
      title: "Extension Lab",
      description: "Inspect the new V2 extension runtime and installed plugins.",
      icon: "Blocks",
      scope: "workspace",
      render: {
        kind: "host",
        component: "catalog",
      },
    });
  },
};

export default extension;
