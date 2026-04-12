import type { CamelAIExtensionModule } from "../../../sdk";

const extension: CamelAIExtensionModule = {
  activate(api) {
    api.registerPreviewProvider("spreadsheet.table", {
      title: "Spreadsheet Preview",
      description: "Render CSV and TSV files with a plugin-owned table view.",
      selectors: [
        { kind: "fileExtension", value: ".csv" },
        { kind: "fileExtension", value: ".tsv" },
        { kind: "mime", value: "text/csv" },
        { kind: "mime", value: "text/tab-separated-values" },
      ],
      priority: "builtin",
      render: {
        kind: "webview",
        webviewId: "spreadsheet-renderer",
      },
    });
  },
};

export default extension;
