import type { CamelAIExtensionModule } from "../../../sdk";

const extension: CamelAIExtensionModule = {
  activate(api) {
    api.registerPage("extension-lab.home", {
      title: "Extension Lab",
      description: "Inspect the new V2 extension runtime and installed plugins.",
      icon: "Blocks",
      render: {
        kind: "host",
        component: "extension-catalog",
      },
    });
  },
};

export default extension;
