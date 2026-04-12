import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopStore } from "../desktop-container/backend/store";
import type {
  DesktopAuthState,
  DesktopModelOption,
  DesktopModelSourceOption,
  DesktopProviderOption,
  DesktopRuntimeStatus,
  DesktopView,
} from "../desktop/shared/protocol";

const runtimeStatus: DesktopRuntimeStatus = {
  state: "running",
  detail: "ready",
  helperPath: null,
};

const providerOptions: DesktopProviderOption[] = [
  { id: "claude", label: "Claude" },
];

const modelOptions: DesktopModelOption[] = [
  { id: "sonnet", label: "Claude Sonnet", provider: "claude" },
];

const modelSourceOptions: DesktopModelSourceOption[] = [
  { id: "default", label: "Default", provider: "claude" },
];

const auth: DesktopAuthState = {
  provider: "claude",
  available: true,
  source: "provider-account",
  label: "Claude",
};

const views: DesktopView[] = [
  {
    id: "plugin:chat:chat.thread",
    title: "Chat",
    description: null,
    icon: "MessagesSquare",
    pluginId: "chat",
    scope: "thread",
    isDefault: true,
    render: {
      kind: "host",
      component: "thread-view",
    },
    hostData: null,
  },
  {
    id: "plugin:extension-lab:extension-lab.home",
    title: "Extension Lab",
    description: null,
    icon: "Blocks",
    pluginId: "extension-lab",
    scope: "workspace",
    isDefault: false,
    render: {
      kind: "host",
      component: "catalog",
    },
    hostData: null,
  },
];

function buildSnapshot(store: DesktopStore) {
  return store.buildSnapshot(
    runtimeStatus,
    "claude",
    providerOptions,
    "sonnet",
    modelOptions,
    "default",
    modelSourceOptions,
    auth,
    views,
    [],
    [],
  );
}

function createStoreFixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "acon-store-"));
  const store = new DesktopStore(dataDir);
  const activeThreadId = store.getActiveThreadId();
  if (!activeThreadId) {
    throw new Error("Expected an active thread");
  }

  store.activateThreadView(activeThreadId, views[0]!.id);
  store.activateWorkspaceView(views[1]!.id);

  return {
    dataDir,
    store,
  };
}

function getSecondaryPaneId(store: DesktopStore): string {
  const snapshot = buildSnapshot(store);
  const secondaryPane = snapshot.panes?.find((pane) => pane.id !== "primary");
  if (!secondaryPane) {
    throw new Error("Expected a secondary pane");
  }
  return secondaryPane.id;
}

const cleanupDirs: string[] = [];

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const path = cleanupDirs.pop();
    if (path) {
      rmSync(path, { force: true, recursive: true });
    }
  }
});

describe("desktop store pane layout", () => {
  it("moves a tab into another pane on a center drop and prunes the emptied source pane", () => {
    const { dataDir, store } = createStoreFixture();
    cleanupDirs.push(dataDir);

    let snapshot = buildSnapshot(store);
    const threadTabId = snapshot.tabs.find((tab) => tab.kind === "thread")?.id;
    const workspaceTabId = snapshot.tabs.find((tab) => tab.kind === "workspace")?.id;
    expect(threadTabId).toBeTruthy();
    expect(workspaceTabId).toBeTruthy();

    store.moveTab(workspaceTabId!, "primary", undefined, "right");
    const secondaryPaneId = getSecondaryPaneId(store);

    store.moveTab(threadTabId!, secondaryPaneId, undefined, "center");
    snapshot = buildSnapshot(store);

    expect(snapshot.panes).toHaveLength(1);
    expect(snapshot.panes?.[0]?.id).toBe(secondaryPaneId);
    expect(snapshot.tabs.map((tab) => tab.paneId)).toEqual([
      secondaryPaneId,
      secondaryPaneId,
    ]);
    expect(snapshot.paneLayout).toMatchObject({
      kind: "pane",
      id: secondaryPaneId,
    });
  });

  it("removes an empty pane after closing its last tab", () => {
    const { dataDir, store } = createStoreFixture();
    cleanupDirs.push(dataDir);

    let snapshot = buildSnapshot(store);
    const workspaceTabId = snapshot.tabs.find((tab) => tab.kind === "workspace")?.id;
    expect(workspaceTabId).toBeTruthy();

    store.moveTab(workspaceTabId!, "primary", undefined, "right");
    store.closeTab(workspaceTabId!, views);
    snapshot = buildSnapshot(store);

    expect(snapshot.panes).toHaveLength(1);
    expect(snapshot.panes?.[0]?.id).toBe("primary");
    expect(snapshot.paneLayout).toMatchObject({
      kind: "pane",
      id: "primary",
    });
  });

  it("creates a vertical split when a tab is dropped on the bottom edge", () => {
    const { dataDir, store } = createStoreFixture();
    cleanupDirs.push(dataDir);

    const snapshot = buildSnapshot(store);
    const workspaceTabId = snapshot.tabs.find((tab) => tab.kind === "workspace")?.id;
    expect(workspaceTabId).toBeTruthy();

    store.moveTab(workspaceTabId!, "primary", undefined, "bottom");
    const nextSnapshot = buildSnapshot(store);

    expect(nextSnapshot.paneLayout).toMatchObject({
      kind: "split",
      direction: "vertical",
    });
    expect(nextSnapshot.panes).toHaveLength(2);
  });

  it("reorders tabs within the same pane", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "acon-store-"));
    cleanupDirs.push(dataDir);
    const store = new DesktopStore(dataDir);
    const activeThreadId = store.getActiveThreadId();
    const activeGroupId = store.getActiveGroupId();
    if (!activeThreadId || !activeGroupId) {
      throw new Error("Expected active thread context");
    }

    store.activateThreadView(activeThreadId, views[0]!.id);
    const secondThread = store.createThread({
      groupId: activeGroupId,
      provider: "claude",
      title: "Second thread",
    });
    store.activateThreadView(secondThread.id, views[0]!.id);

    let snapshot = buildSnapshot(store);
    const pane = snapshot.panes?.find((entry) => entry.id === "primary");
    expect(pane?.tabs).toHaveLength(2);
    const firstTabId = pane?.tabs[0]?.id;
    expect(firstTabId).toBeTruthy();

    store.moveTab(firstTabId!, "primary", 2, "center");
    snapshot = buildSnapshot(store);

    expect(snapshot.panes?.[0]?.tabs.map((tab) => tab.id)).toEqual([
      pane?.tabs[1]?.id,
      firstTabId,
    ]);
  });
});
