import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  DesktopAuthState,
  DesktopMessage,
  DesktopModel,
  DesktopModelOption,
  DesktopPreviewItem,
  DesktopPreviewTarget,
  DesktopProvider,
  DesktopProviderOption,
  DesktopRuntimeStatus,
  DesktopSnapshot,
  DesktopTab,
  DesktopThread,
  DesktopThreadMetadata,
  DesktopThreadPreviewState,
  DesktopView,
} from '../../desktop/shared/protocol';
import {
  getDesktopPreviewItemId,
  getDesktopPreviewItemTitle,
} from '../../desktop/shared/preview';
import type { ContentBlock } from '../../src/types';
import { extractTextContent } from '../../desktop/shared/message-state';
import {
  getDefaultProvider,
  requireDesktopProvider,
} from './providers';

interface PersistedTab {
  id: string;
  kind: 'thread' | 'workspace';
  threadId: string | null;
  viewId: string;
}

interface PersistedState {
  tabs?: PersistedTab[];
  activeTabId?: string | null;
  activeThreadId: string | null;
  activeViewId?: string | null;
  provider: DesktopProvider;
  modelsByProvider: Partial<Record<DesktopProvider, DesktopModel>>;
  threadPreviewStateById?: Record<string, PersistedThreadPreviewState>;
  providerStateByThread?: Partial<
    Record<
      string,
      Partial<
        Record<
          DesktopProvider,
          {
            sessionId?: string | null;
          }
        >
      >
    >
  >;
  pluginEnabledById?: Record<string, boolean>;
  threads: DesktopThread[];
  messagesByThread: Record<string, DesktopMessage[]>;
}

interface PersistedPreviewItem {
  id: string;
  target: DesktopPreviewTarget;
}

interface PersistedThreadPreviewState {
  visible: boolean;
  activeItemId: string | null;
  items: PersistedPreviewItem[];
}

type PersistedDesktopThread = Omit<DesktopThread, 'provider'> & {
  provider?: DesktopProvider;
};

const DEFAULT_THREAD_TITLE = 'New thread';
const backendDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(backendDirectory, '..');
const DEFAULT_DATA_DIR = resolve(desktopDirectory, '.local');

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function now(): number {
  return Date.now();
}

function deriveThreadTitle(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!normalized) return DEFAULT_THREAD_TITLE;
  return normalized.slice(0, 60);
}

function previewText(content: string | ContentBlock[]): string | null {
  const text = extractTextContent(content).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 140) : null;
}

function normalizePersistedId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cloneThreadMetadata(metadata: DesktopThreadMetadata): DesktopThreadMetadata {
  return {
    status: metadata.status,
    lane: metadata.lane,
    archived: metadata.archived,
    archivedAt: metadata.archivedAt,
  };
}

function createDefaultThreadMetadata(): DesktopThreadMetadata {
  return {
    status: null,
    lane: null,
    archived: false,
    archivedAt: null,
  };
}

function normalizeThreadMetadata(value: unknown): DesktopThreadMetadata {
  if (!value || typeof value !== 'object') {
    return createDefaultThreadMetadata();
  }

  const raw = value as {
    status?: unknown;
    lane?: unknown;
    archived?: unknown;
    archivedAt?: unknown;
  };
  const status =
    typeof raw.status === 'string' && raw.status.trim().length > 0
      ? raw.status.trim()
      : null;
  const lane =
    typeof raw.lane === 'string' && raw.lane.trim().length > 0
      ? raw.lane.trim()
      : null;
  const archived = raw.archived === true;
  const archivedAt =
    archived && typeof raw.archivedAt === 'number' && Number.isFinite(raw.archivedAt)
      ? raw.archivedAt
      : archived
        ? now()
        : null;

  return {
    status,
    lane,
    archived,
    archivedAt,
  };
}

function cloneThread(thread: DesktopThread): DesktopThread {
  return {
    ...thread,
    metadata: cloneThreadMetadata(thread.metadata),
  };
}

function normalizePreviewTarget(value: unknown): DesktopPreviewTarget | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const target = value as {
    kind?: unknown;
    source?: unknown;
    workspaceId?: unknown;
    path?: unknown;
    filename?: unknown;
    title?: unknown;
    contentType?: unknown;
    url?: unknown;
  };

  if (target.kind === 'url' && typeof target.url === 'string') {
    const url = target.url.trim();
    if (!url) {
      return null;
    }
    return {
      kind: 'url',
      url,
      title: typeof target.title === 'string' ? target.title : null,
    };
  }

  if (
    target.kind === 'file' &&
    (target.source === 'workspace' || target.source === 'upload' || target.source === 'output') &&
    typeof target.path === 'string'
  ) {
    const path = target.path.trim();
    if (!path) {
      return null;
    }

    return {
      kind: 'file',
      source: target.source,
      workspaceId: typeof target.workspaceId === 'string' ? target.workspaceId : null,
      path,
      filename: typeof target.filename === 'string' ? target.filename : null,
      title: typeof target.title === 'string' ? target.title : null,
      contentType: typeof target.contentType === 'string' ? target.contentType : null,
    };
  }

  return null;
}

function normalizePreviewItem(value: unknown): PersistedPreviewItem | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const item = value as {
    id?: unknown;
    target?: unknown;
  };
  const target = normalizePreviewTarget(item.target);
  if (!target) {
    return null;
  }

  return {
    id: normalizePersistedId(item.id) ?? getDesktopPreviewItemId(target),
    target,
  };
}

function normalizePreviewState(value: unknown): PersistedThreadPreviewState | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const preview = value as {
    items?: unknown;
    activeItemId?: unknown;
    visible?: unknown;
  };
  const items = Array.isArray(preview.items)
    ? preview.items.flatMap((item) => {
        const normalized = normalizePreviewItem(item);
        return normalized ? [normalized] : [];
      })
    : [];
  const activeItemId = normalizePersistedId(preview.activeItemId);

  return {
    visible: preview.visible === true && items.length > 0,
    activeItemId:
      activeItemId && items.some((item) => item.id === activeItemId)
        ? activeItemId
        : items[0]?.id ?? null,
    items,
  };
}

function toDesktopPreviewState(
  state: PersistedThreadPreviewState | undefined,
): DesktopThreadPreviewState {
  const items: DesktopPreviewItem[] = (state?.items ?? []).map((item) => ({
    id: item.id,
    title: getDesktopPreviewItemTitle(item.target),
    target: item.target,
    src: null,
    contentType:
      item.target.kind === 'file'
        ? item.target.contentType ?? null
        : null,
    renderer: null,
  }));
  const activeItemId =
    state?.activeItemId && items.some((item) => item.id === state.activeItemId)
      ? state.activeItemId
      : items[0]?.id ?? null;

  return {
    visible: state?.visible === true && items.length > 0,
    activeItemId,
    items,
  };
}

function normalizeTab(value: unknown): PersistedTab | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const tab = value as {
    id?: unknown;
    kind?: unknown;
    threadId?: unknown;
    viewId?: unknown;
  };
  const id = normalizePersistedId(tab.id);
  const viewId = normalizePersistedId(tab.viewId);
  if (!id || !viewId) {
    return null;
  }

  const kind = tab.kind === 'thread' ? 'thread' : tab.kind === 'workspace' ? 'workspace' : null;
  if (!kind) {
    return null;
  }

  return {
    id,
    kind,
    threadId: normalizePersistedId(tab.threadId),
    viewId,
  };
}

export class DesktopStore {
  private readonly statePath: string;
  private state: PersistedState;

  constructor(dataDir = process.env.DESKTOP_DATA_DIR || DEFAULT_DATA_DIR) {
    ensureDir(dataDir);
    this.statePath = resolve(dataDir, 'state.json');
    this.state = this.load();
    if (this.state.threads.length === 0) {
      const thread = this.createThread('Local workspace');
      this.state.activeThreadId = thread.id;
      this.persist();
    }
  }

  private load(): PersistedState {
    try {
      const raw = readFileSync(this.statePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistedState & {
        model?: DesktopModel;
        threads?: PersistedDesktopThread[];
        activePluginPageId?: string | null;
        threadPanelStateById?: Record<string, unknown>;
      };
      const providerAdapter = requireDesktopProvider(
        parsed.provider ?? getDefaultProvider(),
      );
      const fallbackProvider = providerAdapter.id;
      const legacyModel =
        parsed.model && typeof parsed.model === 'string'
          ? providerAdapter.normalizeModel(parsed.model)
          : undefined;
      const modelsByProvider = parsed.modelsByProvider ?? {};
      const persistedProviderModel = modelsByProvider[fallbackProvider];
      const providerStateByThread = parsed.providerStateByThread ?? {};
      const activeViewId =
        normalizePersistedId(parsed.activeViewId) ??
        normalizePersistedId(parsed.activePluginPageId);
      const inferThreadProvider = (
        thread: PersistedDesktopThread,
      ): DesktopProvider => {
        if (thread.provider) {
          return requireDesktopProvider(thread.provider).id;
        }

        const threadProviderState = providerStateByThread[thread.id] ?? {};
        const providersWithSessions = Object.entries(threadProviderState)
          .filter((entry): entry is [DesktopProvider, { sessionId?: string | null }] =>
            Boolean(entry[1]?.sessionId),
          )
          .map(([providerId]) => requireDesktopProvider(providerId).id);

        if (providersWithSessions.length === 1) {
          return providersWithSessions[0];
        }

        return fallbackProvider;
      };
      const threads = Array.isArray(parsed.threads)
        ? parsed.threads.map((thread) => ({
            ...thread,
            provider: inferThreadProvider(thread),
            metadata: normalizeThreadMetadata(thread.metadata),
          }))
        : [];
      const activeThreadId = parsed.activeThreadId ?? null;
      const activeThreadProvider =
        (activeThreadId
          ? threads.find((thread) => thread.id === activeThreadId)?.provider
          : null) ?? fallbackProvider;

      return {
        tabs: Array.isArray(parsed.tabs)
          ? parsed.tabs.flatMap((tab) => {
              const normalized = normalizeTab(tab);
              return normalized ? [normalized] : [];
            })
          : [],
        activeTabId: normalizePersistedId(parsed.activeTabId),
        activeThreadId,
        activeViewId,
        provider: activeThreadProvider,
        modelsByProvider: {
          ...modelsByProvider,
          [activeThreadProvider]: requireDesktopProvider(activeThreadProvider).normalizeModel(
            modelsByProvider[activeThreadProvider] ??
              persistedProviderModel ??
              legacyModel ??
              requireDesktopProvider(activeThreadProvider).getDefaultModel(),
          ),
        },
        threadPreviewStateById: Object.fromEntries(
          Object.entries(
            parsed.threadPreviewStateById ?? parsed.threadPanelStateById ?? {},
          ).flatMap(([threadId, previewState]) => {
            const normalized = normalizePreviewState(previewState);
            return normalized ? [[threadId, normalized]] : [];
          }),
        ),
        providerStateByThread,
        pluginEnabledById:
          parsed.pluginEnabledById && typeof parsed.pluginEnabledById === 'object'
            ? Object.fromEntries(
                Object.entries(parsed.pluginEnabledById).flatMap(([pluginId, enabled]) =>
                  typeof enabled === 'boolean' ? [[pluginId, enabled]] : [],
                ),
              )
            : {},
        threads,
        messagesByThread: parsed.messagesByThread ?? {},
      };
    } catch {
      const provider = getDefaultProvider();
      return {
        tabs: [],
        activeTabId: null,
        activeThreadId: null,
        activeViewId: null,
        provider,
        modelsByProvider: {
          [provider]: requireDesktopProvider(provider).getDefaultModel(),
        },
        threadPreviewStateById: {},
        providerStateByThread: {},
        pluginEnabledById: {},
        threads: [],
        messagesByThread: {},
      };
    }
  }

  private persist(): void {
    ensureDir(dirname(this.statePath));
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
  }

  private sortThreads(): void {
    this.state.threads.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  private findThread(threadId: string | null): DesktopThread | null {
    if (!threadId) {
      return null;
    }
    return this.state.threads.find((thread) => thread.id === threadId) ?? null;
  }

  private syncStateFromTab(tab: PersistedTab | null): void {
    if (!tab) {
      this.state.activeTabId = null;
      this.state.activeViewId = null;
      return;
    }

    this.state.activeTabId = tab.id;
    this.state.activeViewId = tab.viewId;
    if (tab.kind === 'thread' && tab.threadId) {
      this.state.activeThreadId = tab.threadId;
      const thread = this.findThread(tab.threadId);
      if (thread) {
        this.state.provider = thread.provider;
        this.ensureProviderModel(thread.provider);
      }
    }
  }

  private upsertTab(tab: Omit<PersistedTab, 'id'>): PersistedTab {
    const existing = (this.state.tabs ?? []).find((current) =>
      current.kind === tab.kind &&
      current.threadId === tab.threadId &&
      current.viewId === tab.viewId,
    );
    if (existing) {
      return existing;
    }

    const created: PersistedTab = {
      id: randomUUID(),
      ...tab,
    };
    this.state.tabs = [...(this.state.tabs ?? []), created];
    return created;
  }

  private normalizeTabs(
    views: DesktopView[],
  ): PersistedTab[] {
    const viewIds = new Set(views.map((view) => view.id));
    const threadIds = new Set(this.state.threads.map((thread) => thread.id));
    return (this.state.tabs ?? []).filter((tab) => {
      if (!viewIds.has(tab.viewId)) {
        return false;
      }
      if (tab.kind === 'thread') {
        return Boolean(tab.threadId && threadIds.has(tab.threadId));
      }
      return true;
    });
  }

  private toDesktopTabs(
    tabs: PersistedTab[],
    views: DesktopView[],
  ): DesktopTab[] {
    const viewById = new Map(views.map((view) => [view.id, view]));
    return tabs.reduce<DesktopTab[]>((result, tab) => {
      const view = viewById.get(tab.viewId);
      if (!view) {
        return result;
      }

      if (tab.kind === 'thread') {
        const thread = this.findThread(tab.threadId);
        if (!thread) {
          return result;
        }
        result.push({
          id: tab.id,
          kind: 'thread' as const,
          threadId: thread.id,
          viewId: view.id,
          title: thread.title,
          subtitle: view.title !== 'Chat' ? view.title : null,
          icon: view.icon,
          closable: true,
        });
        return result;
      }

      result.push({
        id: tab.id,
        kind: 'workspace' as const,
        threadId: null,
        viewId: view.id,
        title: view.title,
        subtitle: null,
        icon: view.icon,
        closable: true,
      });
      return result;
    }, []);
  }

  private activateFallbackTab(views: DesktopView[]): void {
    const tabs = this.normalizeTabs(views);
    this.state.tabs = tabs;
    const activeTab =
      tabs.find((tab) => tab.id === this.state.activeTabId) ??
      tabs[tabs.length - 1] ??
      null;
    this.syncStateFromTab(activeTab);
  }

  listThreads(): DesktopThread[] {
    this.sortThreads();
    return this.state.threads.map((thread) => cloneThread(thread));
  }

  getActiveThreadId(): string | null {
    return this.state.activeThreadId;
  }

  getActiveViewId(): string | null {
    return normalizePersistedId(this.state.activeViewId);
  }

  getActiveTabId(): string | null {
    return normalizePersistedId(this.state.activeTabId);
  }

  getProvider(): DesktopProvider {
    return this.state.provider;
  }

  isPluginEnabled(pluginId: string): boolean {
    return this.state.pluginEnabledById?.[pluginId] !== false;
  }

  setPluginEnabled(pluginId: string, enabled: boolean): void {
    const next = { ...(this.state.pluginEnabledById ?? {}) };
    if (enabled) {
      delete next[pluginId];
    } else {
      next[pluginId] = false;
    }
    this.state.pluginEnabledById = next;
    this.persist();
  }

  setProvider(provider: DesktopProvider): void {
    const normalizedProvider = requireDesktopProvider(provider).id;
    this.state.provider = normalizedProvider;
    this.ensureProviderModel(normalizedProvider);
    this.persist();
  }

  setActiveView(viewId: string | null): void {
    this.state.activeViewId = normalizePersistedId(viewId);
    this.persist();
  }

  activateThreadView(threadId: string, viewId: string): void {
    const thread = this.findThread(threadId);
    if (!thread) {
      throw new Error(`Thread ${threadId} does not exist`);
    }

    const tab = this.upsertTab({
      kind: 'thread',
      threadId,
      viewId,
    });
    this.syncStateFromTab(tab);
    this.persist();
  }

  activateWorkspaceView(viewId: string): void {
    const tab = this.upsertTab({
      kind: 'workspace',
      threadId: null,
      viewId,
    });
    this.syncStateFromTab(tab);
    this.persist();
  }

  selectTab(tabId: string): void {
    const tab = (this.state.tabs ?? []).find((current) => current.id === tabId);
    if (!tab) {
      throw new Error(`Tab ${tabId} does not exist`);
    }
    this.syncStateFromTab(tab);
    this.persist();
  }

  closeTab(tabId: string, views: DesktopView[]): void {
    const tabs = this.normalizeTabs(views);
    const index = tabs.findIndex((tab) => tab.id === tabId);
    if (index === -1) {
      throw new Error(`Tab ${tabId} does not exist`);
    }

    const nextTabs = tabs.filter((tab) => tab.id !== tabId);
    this.state.tabs = nextTabs;
    if (this.state.activeTabId === tabId) {
      const fallback = nextTabs[index] ?? nextTabs[index - 1] ?? nextTabs[0] ?? null;
      this.syncStateFromTab(fallback);
    } else {
      this.state.activeTabId = normalizePersistedId(this.state.activeTabId);
    }
    this.persist();
  }

  getThreadPreviewStateById(): Record<string, DesktopThreadPreviewState> {
    return Object.fromEntries(
      Object.entries(this.state.threadPreviewStateById ?? {}).map(([threadId, previewState]) => [
        threadId,
        toDesktopPreviewState(previewState),
      ]),
    );
  }

  getThreadPreviewState(threadId: string): DesktopThreadPreviewState {
    return toDesktopPreviewState(this.state.threadPreviewStateById?.[threadId]);
  }

  setThreadPreviewItems(
    threadId: string,
    targets: DesktopPreviewTarget[],
    activeItemId?: string | null,
  ): void {
    if (!this.getThread(threadId)) {
      throw new Error(`Thread ${threadId} does not exist`);
    }

    const items = targets.flatMap((target) => {
      const normalized = normalizePreviewTarget(target);
      if (!normalized) {
        return [];
      }

      return [{
        id: getDesktopPreviewItemId(normalized),
        target: normalized,
      }];
    });

    const dedupedItems = items.filter((item, index) =>
      items.findIndex((candidate) => candidate.id === item.id) === index,
    );
    const nextActiveItemId =
      normalizePersistedId(activeItemId) &&
      dedupedItems.some((item) => item.id === normalizePersistedId(activeItemId))
        ? normalizePersistedId(activeItemId)
        : dedupedItems[0]?.id ?? null;

    this.state.threadPreviewStateById = {
      ...(this.state.threadPreviewStateById ?? {}),
      [threadId]: {
        visible: dedupedItems.length > 0,
        activeItemId: nextActiveItemId,
        items: dedupedItems,
      },
    };
    this.persist();
  }

  openThreadPreviewItem(threadId: string, target: DesktopPreviewTarget): void {
    if (!this.getThread(threadId)) {
      throw new Error(`Thread ${threadId} does not exist`);
    }

    const normalized = normalizePreviewTarget(target);
    if (!normalized) {
      return;
    }

    const current = this.state.threadPreviewStateById?.[threadId] ?? {
      visible: false,
      activeItemId: null,
      items: [],
    };
    const nextItem: PersistedPreviewItem = {
      id: getDesktopPreviewItemId(normalized),
      target: normalized,
    };
    const existingIndex = current.items.findIndex((item) => item.id === nextItem.id);
    const items =
      existingIndex === -1
        ? [...current.items, nextItem]
        : current.items.map((item, index) => (index === existingIndex ? nextItem : item));

    this.state.threadPreviewStateById = {
      ...(this.state.threadPreviewStateById ?? {}),
      [threadId]: {
        visible: items.length > 0,
        activeItemId: nextItem.id,
        items,
      },
    };
    this.persist();
  }

  selectThreadPreviewItem(threadId: string, itemId: string): void {
    if (!this.getThread(threadId)) {
      throw new Error(`Thread ${threadId} does not exist`);
    }

    const current = this.state.threadPreviewStateById?.[threadId];
    const normalizedItemId = normalizePersistedId(itemId);
    if (!current || !normalizedItemId || !current.items.some((item) => item.id === normalizedItemId)) {
      return;
    }

    this.state.threadPreviewStateById = {
      ...(this.state.threadPreviewStateById ?? {}),
      [threadId]: {
        ...current,
        visible: current.items.length > 0,
        activeItemId: normalizedItemId,
      },
    };
    this.persist();
  }

  closeThreadPreviewItem(threadId: string, itemId: string): void {
    if (!this.getThread(threadId)) {
      throw new Error(`Thread ${threadId} does not exist`);
    }

    const current = this.state.threadPreviewStateById?.[threadId];
    const normalizedItemId = normalizePersistedId(itemId);
    if (!current || !normalizedItemId) {
      return;
    }

    const items = current.items.filter((item) => item.id !== normalizedItemId);
    const activeItemId =
      current.activeItemId === normalizedItemId
        ? items[0]?.id ?? null
        : current.activeItemId && items.some((item) => item.id === current.activeItemId)
          ? current.activeItemId
          : items[0]?.id ?? null;

    this.state.threadPreviewStateById = {
      ...(this.state.threadPreviewStateById ?? {}),
      [threadId]: {
        visible: current.visible && items.length > 0,
        activeItemId,
        items,
      },
    };
    this.persist();
  }

  clearThreadPreview(threadId: string): void {
    if (!this.getThread(threadId)) {
      throw new Error(`Thread ${threadId} does not exist`);
    }

    this.state.threadPreviewStateById = {
      ...(this.state.threadPreviewStateById ?? {}),
      [threadId]: {
        visible: false,
        activeItemId: null,
        items: [],
      },
    };
    this.persist();
  }

  setThreadPreviewVisibility(threadId: string, visible: boolean): void {
    if (!this.getThread(threadId)) {
      throw new Error(`Thread ${threadId} does not exist`);
    }

    const current = this.state.threadPreviewStateById?.[threadId] ?? {
      visible: false,
      activeItemId: null,
      items: [],
    };

    this.state.threadPreviewStateById = {
      ...(this.state.threadPreviewStateById ?? {}),
      [threadId]: {
        ...current,
        visible: visible && current.items.length > 0,
      },
    };
    this.persist();
  }

  private ensureProviderModel(provider: DesktopProvider): void {
    if (!this.state.modelsByProvider[provider]) {
      this.state.modelsByProvider[provider] =
        requireDesktopProvider(provider).getDefaultModel();
    }
  }

  getModel(provider = this.state.provider): DesktopModel {
    const adapter = requireDesktopProvider(provider);
    return adapter.normalizeModel(
      this.state.modelsByProvider[provider] ?? adapter.getDefaultModel(),
    );
  }

  setModel(model: DesktopModel, provider = this.state.provider): void {
    this.state.modelsByProvider[provider] =
      requireDesktopProvider(provider).normalizeModel(model);
    this.persist();
  }

  getProviderSessionId(
    threadId: string,
    provider = this.state.provider,
  ): string | null {
    return this.state.providerStateByThread?.[threadId]?.[provider]?.sessionId ?? null;
  }

  setProviderSessionId(
    threadId: string,
    provider: DesktopProvider,
    sessionId: string | null,
  ): void {
    const current = this.state.providerStateByThread ?? {};
    const threadState = current[threadId] ?? {};
    this.state.providerStateByThread = {
      ...current,
      [threadId]: {
        ...threadState,
        [provider]: {
          ...threadState[provider],
          sessionId,
        },
      },
    };
    this.persist();
  }

  getMessagesByThread(): Record<string, DesktopMessage[]> {
    return Object.fromEntries(
      Object.entries(this.state.messagesByThread).map(([threadId, messages]) => [
        threadId,
        messages.map((message) => ({ ...message })),
      ]),
    );
  }

  getThread(threadId: string): DesktopThread | null {
    const thread = this.state.threads.find((entry) => entry.id === threadId) ?? null;
    return thread ? cloneThread(thread) : null;
  }

  getThreadProvider(threadId: string): DesktopProvider {
    return this.getThread(threadId)?.provider ?? this.state.provider;
  }

  setActiveThread(threadId: string): void {
    const thread = this.findThread(threadId);
    if (!thread) {
      throw new Error(`Thread ${threadId} does not exist`);
    }

    this.state.activeThreadId = threadId;
    this.state.provider = thread.provider;
    this.ensureProviderModel(thread.provider);
    this.persist();
  }

  setThreadProvider(threadId: string, provider: DesktopProvider): void {
    const thread = this.findThread(threadId);
    if (!thread) {
      throw new Error(`Thread ${threadId} does not exist`);
    }

    const normalizedProvider = requireDesktopProvider(provider).id;
    thread.provider = normalizedProvider;
    this.ensureProviderModel(normalizedProvider);
    if (this.state.activeThreadId === threadId) {
      this.state.provider = normalizedProvider;
    }
    this.persist();
  }

  updateThreadMetadata(
    threadId: string,
    update: {
      status?: string | null;
      lane?: string | null;
      archived?: boolean | null;
    },
  ): DesktopThread {
    const thread = this.findThread(threadId);
    if (!thread) {
      throw new Error(`Thread ${threadId} does not exist`);
    }

    if ('status' in update) {
      thread.metadata.status =
        typeof update.status === 'string' && update.status.trim().length > 0
          ? update.status.trim()
          : null;
    }

    if ('lane' in update) {
      thread.metadata.lane =
        typeof update.lane === 'string' && update.lane.trim().length > 0
          ? update.lane.trim()
          : null;
    }

    if ('archived' in update && typeof update.archived === 'boolean') {
      if (update.archived && !thread.metadata.archived) {
        thread.metadata.archivedAt = now();
      } else if (!update.archived) {
        thread.metadata.archivedAt = null;
      }
      thread.metadata.archived = update.archived;
    }

    thread.updatedAt = now();
    this.sortThreads();
    this.persist();
    return cloneThread(thread);
  }

  threadHasHarnessState(threadId: string): boolean {
    if ((this.state.messagesByThread[threadId] ?? []).length > 0) {
      return true;
    }

    return Object.values(this.state.providerStateByThread?.[threadId] ?? {}).some(
      (entry) => Boolean(entry?.sessionId),
    );
  }

  getThreadMessages(threadId: string): DesktopMessage[] {
    return (this.state.messagesByThread[threadId] ?? []).map((message) => ({
      ...message,
    }));
  }

  createThread(
    title = DEFAULT_THREAD_TITLE,
    provider = this.state.provider,
  ): DesktopThread {
    const normalizedProvider = requireDesktopProvider(provider).id;
    const thread: DesktopThread = {
      id: randomUUID(),
      provider: normalizedProvider,
      title: title.trim() || DEFAULT_THREAD_TITLE,
      createdAt: now(),
      updatedAt: now(),
      lastMessagePreview: null,
      metadata: createDefaultThreadMetadata(),
    };
    this.state.threads.unshift(thread);
    this.state.messagesByThread[thread.id] = [];
    this.state.threadPreviewStateById = {
      ...(this.state.threadPreviewStateById ?? {}),
      [thread.id]: {
        visible: false,
        activeItemId: null,
        items: [],
      },
    };
    this.state.providerStateByThread = {
      ...(this.state.providerStateByThread ?? {}),
      [thread.id]: {},
    };
    this.state.activeThreadId = thread.id;
    this.state.provider = normalizedProvider;
    this.ensureProviderModel(normalizedProvider);
    this.persist();
    return cloneThread(thread);
  }

  appendMessage(
    threadId: string,
    role: DesktopMessage['role'],
    content: DesktopMessage['content'],
    status: DesktopMessage['status'],
    extras: Pick<DesktopMessage, 'isMeta' | 'sourceToolUseID'> = {},
  ): DesktopMessage {
    const thread = this.findThread(threadId);
    if (!thread) {
      throw new Error(`Thread ${threadId} does not exist`);
    }

    const message: DesktopMessage = {
      id: randomUUID(),
      threadId,
      role,
      content,
      createdAt: now(),
      status,
      isMeta: extras.isMeta,
      sourceToolUseID: extras.sourceToolUseID,
    };
    const nextMessages = this.state.messagesByThread[threadId] ?? [];
    nextMessages.push(message);
    this.state.messagesByThread[threadId] = nextMessages;

    thread.updatedAt = now();
    thread.lastMessagePreview = previewText(content) || thread.lastMessagePreview;

    if (role === 'user' && typeof content === 'string' && thread.title === DEFAULT_THREAD_TITLE) {
      thread.title = deriveThreadTitle(content);
    }

    this.sortThreads();
    this.persist();
    return message;
  }

  appendToMessage(threadId: string, messageId: string, delta: string): DesktopMessage {
    const messages = this.state.messagesByThread[threadId];
    if (!messages) {
      throw new Error(`Thread ${threadId} has no messages`);
    }
    const message = messages.find((entry) => entry.id === messageId);
    if (!message) {
      throw new Error(`Message ${messageId} does not exist`);
    }
    message.content = `${extractTextContent(message.content)}${delta}`;
    message.status = 'streaming';
    const thread = this.findThread(threadId);
    if (thread) {
      thread.updatedAt = now();
      thread.lastMessagePreview = previewText(message.content) || thread.lastMessagePreview;
      this.sortThreads();
    }
    this.persist();
    return message;
  }

  finalizeMessage(
    threadId: string,
    messageId: string,
    status: DesktopMessage['status'],
    content?: DesktopMessage['content'],
  ): DesktopMessage {
    const messages = this.state.messagesByThread[threadId];
    if (!messages) {
      throw new Error(`Thread ${threadId} has no messages`);
    }
    const message = messages.find((entry) => entry.id === messageId);
    if (!message) {
      throw new Error(`Message ${messageId} does not exist`);
    }
    if (typeof content === 'string') {
      message.content = content;
    } else if (Array.isArray(content)) {
      message.content = content;
    }
    message.status = status;
    const thread = this.findThread(threadId);
    if (thread) {
      thread.updatedAt = now();
      thread.lastMessagePreview = previewText(message.content) || thread.lastMessagePreview;
      this.sortThreads();
    }
    this.persist();
    return message;
  }

  replaceThreadMessages(threadId: string, messages: DesktopMessage[]): void {
    const thread = this.findThread(threadId);
    if (!thread) {
      throw new Error(`Thread ${threadId} does not exist`);
    }

    this.state.messagesByThread[threadId] = messages.map((message) => ({
      ...message,
    }));
    thread.updatedAt = now();

    const lastMessage = messages[messages.length - 1];
    thread.lastMessagePreview = lastMessage
      ? previewText(lastMessage.content) || thread.lastMessagePreview
      : thread.lastMessagePreview;

    this.sortThreads();
    this.persist();
  }

  buildSnapshot(
    runtimeStatus: DesktopRuntimeStatus,
    provider: DesktopProvider,
    availableProviders: DesktopProviderOption[],
    model: DesktopModel,
    availableModels: DesktopModelOption[],
    auth: DesktopAuthState,
    views: DesktopView[],
    plugins: DesktopSnapshot['plugins'],
  ): DesktopSnapshot {
    const tabs = this.normalizeTabs(views);
    this.state.tabs = tabs;
    if (!tabs.some((tab) => tab.id === this.state.activeTabId)) {
      this.activateFallbackTab(views);
    }

    return {
      tabs: this.toDesktopTabs(this.state.tabs ?? [], views),
      activeTabId: this.getActiveTabId(),
      activeThreadId: this.state.activeThreadId,
      activeViewId: this.getActiveViewId(),
      threadPreviewStateById: this.getThreadPreviewStateById(),
      threads: this.listThreads(),
      messagesByThread: this.getMessagesByThread(),
      provider,
      availableProviders,
      model,
      availableModels,
      auth,
      runtimeStatus,
      views,
      plugins,
      pendingPermissionRequest: null,
    };
  }
}
