import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { ChatPreviewProvider } from "@/components/chat-preview/preview-context";
import { CurrentWorkspaceIdProvider } from "@/hooks/use-current-workspace-id";

describe("MarkdownRenderer", () => {
  it("routes workspace output API links into the preview pane", () => {
    const openPreviewTarget = vi.fn();

    render(
      <CurrentWorkspaceIdProvider workspaceId={null}>
        <ChatPreviewProvider
          value={{
            openPreviewTarget,
            setPreviewTargets: vi.fn(),
            clearPreviewTarget: vi.fn(),
          }}
        >
          <MarkdownRenderer content="[Open report](/api/workspaces/desktop/outputs/reports/quarterly%20report.xlsx)" />
        </ChatPreviewProvider>
      </CurrentWorkspaceIdProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open report" }));

    expect(openPreviewTarget).toHaveBeenCalledWith({
      kind: "file",
      source: "output",
      workspaceId: "desktop",
      path: "reports/quarterly report.xlsx",
      filename: "quarterly report.xlsx",
    });
  });

  it("routes direct /mnt output markdown links into the preview pane", () => {
    const openPreviewTarget = vi.fn();

    render(
      <CurrentWorkspaceIdProvider workspaceId={null}>
        <ChatPreviewProvider
          value={{
            openPreviewTarget,
            setPreviewTargets: vi.fn(),
            clearPreviewTarget: vi.fn(),
          }}
        >
          <MarkdownRenderer content="[Download file](/mnt/user-outputs/reports/final%20sheet.xlsx)" />
        </ChatPreviewProvider>
      </CurrentWorkspaceIdProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Download file" }));

    expect(openPreviewTarget).toHaveBeenCalledWith({
      kind: "file",
      source: "output",
      workspaceId: "desktop",
      path: "reports/final sheet.xlsx",
      filename: "final sheet.xlsx",
    });
  });
});
