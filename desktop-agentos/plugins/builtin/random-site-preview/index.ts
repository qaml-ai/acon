import type { CamelAIExtensionModule } from "../../../sdk";

const extension: CamelAIExtensionModule = {
  activate(api) {
    api.registerPreviewPane("random-site-preview.frame", {
      title: "Random Site Preview",
      description: "Shows a thread-specific random website.",
      icon: "Globe",
      autoOpen: "all-threads",
      render: {
        kind: "webview",
        webviewId: "random-site-frame",
      },
    });
  },
};

export default extension;
