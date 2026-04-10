import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopService } from "../desktop-container/backend/service";
import type {
  RuntimeManager,
  StreamContainerPromptOptions,
  StreamContainerPromptResult,
} from "../desktop-container/backend/container-runtime";

function createRuntimeManagerStub(paths: {
  workspaceDirectory: string;
  managedWorkspaceDirectory: string;
  runtimeDirectory: string;
}): RuntimeManager {
  return {
    getWorkspaceDirectory: () => paths.workspaceDirectory,
    getManagedWorkspaceDirectory: () => paths.managedWorkspaceDirectory,
    getRuntimeDirectory: () => paths.runtimeDirectory,
    getThreadStateDirectory: (threadId: string) =>
      resolve(paths.runtimeDirectory, "thread-state", threadId),
    getCachedStatus: () => ({
      state: "running",
      detail: "Runtime ready",
      helperPath: null,
    }),
    registerHostMcpServer: vi.fn(),
    unregisterHostMcpServer: vi.fn(),
    dispose: vi.fn(),
    ensureRuntime: vi.fn(async () => ({
      state: "running",
      detail: "Runtime ready",
      helperPath: null,
    })),
    cancelPrompt: vi.fn(async () => {}),
    streamPrompt: vi.fn(
      async (_options: StreamContainerPromptOptions): Promise<StreamContainerPromptResult> => {
        throw new Error("streamPrompt should not be called in preview integration tests");
      },
    ),
  };
}

async function waitFor<T>(assertion: () => T, timeoutMs = 5_000): Promise<T> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return assertion();
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Timed out waiting for test condition.");
}

describe("Desktop preview providers integration", () => {
  let sandboxDataDir: string;
  let previousDataDir: string | undefined;
  let workspaceDirectory: string;
  let runtimeDirectory: string;

  beforeEach(() => {
    previousDataDir = process.env.DESKTOP_DATA_DIR;
    sandboxDataDir = mkdtempSync(join(tmpdir(), "acon-preview-provider-test-"));
    workspaceDirectory = resolve(sandboxDataDir, "workspace");
    runtimeDirectory = resolve(sandboxDataDir, "runtime");
    mkdirSync(workspaceDirectory, { recursive: true });
    mkdirSync(runtimeDirectory, { recursive: true });
    process.env.DESKTOP_DATA_DIR = sandboxDataDir;
  });

  afterEach(() => {
    if (previousDataDir === undefined) {
      delete process.env.DESKTOP_DATA_DIR;
    } else {
      process.env.DESKTOP_DATA_DIR = previousDataDir;
    }
    rmSync(sandboxDataDir, { recursive: true, force: true });
  });

  it("resolves the builtin spreadsheet preview provider for workspace CSV files", async () => {
    const reportsDirectory = resolve(workspaceDirectory, "reports");
    const csvPath = resolve(reportsDirectory, "data.csv");
    mkdirSync(reportsDirectory, { recursive: true });
    writeFileSync(csvPath, "name,score\nAva,10\nLeo,8\n", "utf8");

    const runtime = createRuntimeManagerStub({
      workspaceDirectory,
      managedWorkspaceDirectory: workspaceDirectory,
      runtimeDirectory,
    });
    const service = new DesktopService(runtime);

    try {
      await waitFor(() => {
        const plugin = service
          .getSnapshot()
          .plugins.find((entry) => entry.id === "spreadsheet-preview");
        expect(plugin).toBeTruthy();
        expect(plugin?.runtime.activated).toBe(true);
      });

      const threadId = service.getSnapshot().threads[0]?.id;
      expect(threadId).toBeTruthy();

      service.openThreadPreviewItem(threadId, {
        kind: "file",
        source: "workspace",
        path: "/reports/data.csv",
      });

      const previewItem = await waitFor(() => {
        const state = service.getSnapshot().threadPreviewStateById[threadId!];
        expect(state).toBeTruthy();
        expect(state.visible).toBe(true);
        expect(state.items).toHaveLength(1);
        expect(state.activeItemId).toBe(state.items[0]?.id ?? null);
        expect(state.items[0]?.renderer).toBeTruthy();
        return state.items[0]!;
      });

      expect(previewItem.src).toBe(
        `desktop-plugin://local${pathToFileURL(csvPath).pathname}`,
      );
      expect(previewItem.renderer).toMatchObject({
        pluginId: "spreadsheet-preview",
        providerId: "plugin:spreadsheet-preview:spreadsheet.table",
        title: "Spreadsheet Preview",
        render: {
          kind: "webview",
          entrypoint: expect.stringContaining(
            "/desktop-container/plugins/builtin/spreadsheet-preview/webviews/spreadsheet-preview.html",
          ),
        },
      });
    } finally {
      service.dispose();
    }
  });

  it("resolves output preview files from the desktop transfers directory", async () => {
    const outputsDirectory = resolve(sandboxDataDir, "transfers", "outputs");
    const workbookPath = resolve(outputsDirectory, "sales_report.xlsx");
    mkdirSync(outputsDirectory, { recursive: true });
    writeFileSync(workbookPath, "fake workbook bytes", "utf8");

    const runtime = createRuntimeManagerStub({
      workspaceDirectory,
      managedWorkspaceDirectory: workspaceDirectory,
      runtimeDirectory,
    });
    const service = new DesktopService(runtime);

    try {
      const threadId = service.getSnapshot().threads[0]?.id;
      expect(threadId).toBeTruthy();

      service.openThreadPreviewItem(threadId, {
        kind: "file",
        source: "workspace",
        path: "/mnt/user-outputs/sales_report.xlsx",
      });

      const previewItem = await waitFor(() => {
        const state = service.getSnapshot().threadPreviewStateById[threadId!];
        expect(state).toBeTruthy();
        expect(state.items).toHaveLength(1);
        return state.items[0]!;
      });

      expect(previewItem.target).toMatchObject({
        kind: "file",
        source: "output",
        path: "sales_report.xlsx",
      });
      expect(previewItem.src).toBe(
        `desktop-plugin://local${pathToFileURL(workbookPath).pathname}`,
      );
      expect(previewItem.renderer).toBeNull();
    } finally {
      service.dispose();
    }
  });

  it("resolves container provider-home preview files from the runtime directory", async () => {
    const providerHomeDirectory = resolve(runtimeDirectory, "providers", "claude", "home");
    const workbookPath = resolve(providerHomeDirectory, "sales_report.xlsx");
    mkdirSync(providerHomeDirectory, { recursive: true });
    writeFileSync(workbookPath, "fake workbook bytes", "utf8");

    const runtime = createRuntimeManagerStub({
      workspaceDirectory,
      managedWorkspaceDirectory: workspaceDirectory,
      runtimeDirectory,
    });
    const service = new DesktopService(runtime);

    try {
      const threadId = service.getSnapshot().threads[0]?.id;
      expect(threadId).toBeTruthy();

      service.openThreadPreviewItem(threadId, {
        kind: "file",
        source: "workspace",
        path: "/data/providers/claude/home/sales_report.xlsx",
      });

      const previewItem = await waitFor(() => {
        const state = service.getSnapshot().threadPreviewStateById[threadId!];
        expect(state).toBeTruthy();
        expect(state.items).toHaveLength(1);
        return state.items[0]!;
      });

      expect(previewItem.target).toMatchObject({
        kind: "file",
        source: "workspace",
        path: "/data/providers/claude/home/sales_report.xlsx",
      });
      expect(previewItem.src).toBe(
        `desktop-plugin://local${pathToFileURL(workbookPath).pathname}`,
      );
      expect(previewItem.renderer).toBeNull();
    } finally {
      service.dispose();
    }
  });
});
