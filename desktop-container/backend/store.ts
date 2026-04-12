import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  DesktopAuthState,
  DesktopMessage,
  DesktopModel,
  DesktopModelOption,
  DesktopPane,
  DesktopPaneDropPlacement,
  DesktopPaneLeaf,
  DesktopPaneNode,
  DesktopPaneSplit,
  DesktopPaneSplitDirection,
  DesktopPreviewItem,
  DesktopPreviewTarget,
  DesktopProvider,
  DesktopProviderOption,
  DesktopRuntimeStatus,
  DesktopSnapshot,
  DesktopSidebarPanel,
  DesktopTab,
  DesktopThread,
  DesktopThreadGroup,
  DesktopThreadPreviewState,
  DesktopView,
} from '../../desktop/shared/protocol';
import {
  getDesktopPreviewItemId,
  getDesktopPreviewItemTitle,
  normalizeTransferredPreviewPath,
} from '../../desktop/shared/preview';
import type { ContentBlock } from '../../src/types';
import { extractTextContent } from '../../desktop/shared/message-state';
import {
  getDefaultProvider,
  requireDesktopProvider,
} from './providers';

interface PersistedTab {
  id: string;
  kind: 'thread' | 'workspace' | 'preview';
  paneId: string;
  threadId: string | null;
  viewId: string | null;
  target?: DesktopPreviewTarget;
}

interface PersistedState {
  tabs?: PersistedTab[];
  paneLayout?: PersistedPaneNode | null;
  activePaneId?: string | null;
  activeTabIdByPane?: Record<string, string | null>;
  activeTabId?: string | null;
  activeThreadId: string | null;
  activeGroupId?: string | null;
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
  threadGroups?: DesktopThreadGroup[];
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

interface PersistedPaneLeaf {
  id: string;
  kind: 'pane';
}

interface PersistedPaneSplit {
  id: string;
  kind: 'split';
  direction: DesktopPaneSplitDirection;
  children: PersistedPaneNode[];
  sizes?: number[] | null;
}

type PersistedPaneNode = PersistedPaneLeaf | PersistedPaneSplit;

type PersistedDesktopThread = Omit<DesktopThread, 'provider'> & {
  provider?: DesktopProvider;
};

const DEFAULT_THREAD_GROUP_TITLE = 'Default Group';
const DEFAULT_NEW_THREAD_GROUP_TITLE = 'New group';
const DEFAULT_THREAD_TITLE = 'New thread';
const PRIMARY_PANE_ID = 'primary';
const LEGACY_SECONDARY_PANE_ID = 'secondary';
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

function normalizePaneId(value: unknown): string {
  const normalized = normalizePersistedId(value);
  return normalized ?? PRIMARY_PANE_ID;
}

function isPersistedPaneLeaf(node: PersistedPaneNode): node is PersistedPaneLeaf {
  return node.kind === 'pane';
}

function createPaneLeaf(id: string = randomUUID()): PersistedPaneLeaf {
  return {
    id,
    kind: 'pane',
  };
}

function createDefaultPaneLayout(): PersistedPaneNode {
  return createPaneLeaf(PRIMARY_PANE_ID);
}

function createSplitPaneLayout(
  direction: DesktopPaneSplitDirection,
  children: PersistedPaneNode[],
  sizes?: number[] | null,
): PersistedPaneSplit {
  return {
    id: randomUUID(),
    kind: 'split',
    direction,
    children,
    sizes:
      Array.isArray(sizes) && sizes.length === children.length
        ? sizes.map((size) => (typeof size === 'number' && Number.isFinite(size) ? size : 0))
        : null,
  };
}

function clonePaneNode(node: PersistedPaneNode): PersistedPaneNode {
  if (isPersistedPaneLeaf(node)) {
    return { ...node };
  }

  return {
    ...node,
    children: node.children.map((child) => clonePaneNode(child)),
    sizes: node.sizes ? [...node.sizes] : null,
  };
}

function listPaneIds(node: PersistedPaneNode | null | undefined): string[] {
  if (!node) {
    return [];
  }

  if (isPersistedPaneLeaf(node)) {
    return [node.id];
  }

  return node.children.flatMap((child) => listPaneIds(child));
}

function findPaneNode(
  node: PersistedPaneNode | null | undefined,
  paneId: string,
): PersistedPaneLeaf | null {
  if (!node) {
    return null;
  }

  if (isPersistedPaneLeaf(node)) {
    return node.id === paneId ? node : null;
  }

  for (const child of node.children) {
    const match = findPaneNode(child, paneId);
    if (match) {
      return match;
    }
  }

  return null;
}

function getFirstPaneId(node: PersistedPaneNode | null | undefined): string | null {
  return listPaneIds(node)[0] ?? null;
}

function appendPaneToLayout(
  layout: PersistedPaneNode | null | undefined,
  paneId: string,
): PersistedPaneNode {
  if (!layout) {
    return createPaneLeaf(paneId);
  }

  if (findPaneNode(layout, paneId)) {
    return layout;
  }

  return createSplitPaneLayout('horizontal', [layout, createPaneLeaf(paneId)], [50, 50]);
}

function normalizePaneSplitDirection(
  value: unknown,
): DesktopPaneSplitDirection | null {
  return value === 'horizontal' || value === 'vertical' ? value : null;
}

function normalizePaneLayoutNode(value: unknown): PersistedPaneNode | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const node = value as {
    id?: unknown;
    kind?: unknown;
    direction?: unknown;
    children?: unknown;
    sizes?: unknown;
  };

  if (node.kind === 'pane') {
    const id = normalizePersistedId(node.id);
    return id ? createPaneLeaf(id) : null;
  }

  if (node.kind !== 'split') {
    return null;
  }

  const direction = normalizePaneSplitDirection(node.direction);
  const children = Array.isArray(node.children)
    ? node.children.flatMap((child) => {
        const normalized = normalizePaneLayoutNode(child);
        return normalized ? [normalized] : [];
      })
    : [];
  if (!direction || children.length === 0) {
    return null;
  }

  const sizes = Array.isArray(node.sizes)
    ? node.sizes.flatMap((size) =>
        typeof size === 'number' && Number.isFinite(size) ? [size] : [],
      )
    : null;

  return {
    id: normalizePersistedId(node.id) ?? randomUUID(),
    kind: 'split',
    direction,
    children,
    sizes: sizes && sizes.length === children.length ? sizes : null,
  };
}

function ensurePaneLayout(
  layout: PersistedPaneNode | null | undefined,
  paneIds: Iterable<string>,
): PersistedPaneNode {
  let nextLayout = layout ? clonePaneNode(layout) : createDefaultPaneLayout();

  for (const paneId of paneIds) {
    nextLayout = appendPaneToLayout(nextLayout, paneId);
  }

  return nextLayout;
}

function splitPaneLayout(
  node: PersistedPaneNode,
  targetPaneId: string,
  newPaneId: string,
  placement: Exclude<DesktopPaneDropPlacement, 'center'>,
): PersistedPaneNode {
  if (isPersistedPaneLeaf(node)) {
    if (node.id !== targetPaneId) {
      return node;
    }

    const direction = placement === 'left' || placement === 'right' ? 'horizontal' : 'vertical';
    const newPane = createPaneLeaf(newPaneId);
    const children =
      placement === 'left' || placement === 'top'
        ? [newPane, node]
        : [node, newPane];
    return createSplitPaneLayout(direction, children, [50, 50]);
  }

  return {
    ...node,
    children: node.children.map((child) =>
      splitPaneLayout(child, targetPaneId, newPaneId, placement),
    ),
  };
}

function prunePaneLayout(
  node: PersistedPaneNode | null | undefined,
  paneIds: ReadonlySet<string>,
): PersistedPaneNode | null {
  if (!node) {
    return null;
  }

  if (isPersistedPaneLeaf(node)) {
    return paneIds.has(node.id) ? node : null;
  }

  const children = node.children.flatMap((child) => {
    const pruned = prunePaneLayout(child, paneIds);
    return pruned ? [pruned] : [];
  });

  if (children.length === 0) {
    return null;
  }

  if (children.length === 1) {
    return children[0] ?? null;
  }

  return {
    ...node,
    children,
    sizes: null,
  };
}

function toDesktopPaneLayout(node: PersistedPaneNode): DesktopPaneNode {
  if (isPersistedPaneLeaf(node)) {
    const leaf: DesktopPaneLeaf = {
      id: node.id,
      kind: 'pane',
    };
    return leaf;
  }

  const split: DesktopPaneSplit = {
    id: node.id,
    kind: 'split',
    direction: node.direction,
    children: node.children.map((child) => toDesktopPaneLayout(child)),
    sizes: node.sizes ? [...node.sizes] : null,
  };
  return split;
}

function getPreviewTabId(threadId: string, target: DesktopPreviewTarget): string {
  return `preview:${threadId}:${getDesktopPreviewItemId(target)}`;
}

function getPreviewItemIdFromTab(tab: Pick<PersistedTab, 'kind' | 'target'>): string | null {
  if (tab.kind !== 'preview' || !tab.target) {
    return null;
  }
  return getDesktopPreviewItemId(tab.target);
}

function normalizeThread(value: unknown, defaultGroupId: string): DesktopThread | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const raw = value as DesktopThread & {
    id?: unknown;
    groupId?: unknown;
    provider?: unknown;
    title?: unknown;
    createdAt?: unknown;
    updatedAt?: unknown;
    lastMessagePreview?: unknown;
    status?: unknown;
    lane?: unknown;
    archivedAt?: unknown;
  };
  const id = normalizePersistedId(raw.id);
  if (!id) {
    return null;
  }

  const status =
    typeof raw.status === 'string' && raw.status.trim().length > 0
      ? raw.status.trim()
      : null;
  const lane =
    typeof raw.lane === 'string' && raw.lane.trim().length > 0
      ? raw.lane.trim()
      : null;
  const archivedAt =
    typeof raw.archivedAt === 'number' && Number.isFinite(raw.archivedAt)
      ? raw.archivedAt
      : null;
  const createdAt =
    typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt)
      ? raw.createdAt
      : now();
  const updatedAt =
    typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)
      ? raw.updatedAt
      : createdAt;
  const providerId =
    typeof raw.provider === 'string' ? raw.provider : getDefaultProvider();

  return {
    id,
    groupId:
      typeof raw.groupId === 'string' && raw.groupId.trim().length > 0
        ? raw.groupId.trim()
        : defaultGroupId,
    provider: requireDesktopProvider(providerId).id,
    title:
      typeof raw.title === 'string' && raw.title.trim().length > 0
        ? raw.title.trim()
        : DEFAULT_THREAD_TITLE,
    createdAt,
    updatedAt,
    lastMessagePreview:
      typeof raw.lastMessagePreview === 'string' && raw.lastMessagePreview.trim().length > 0
        ? raw.lastMessagePreview
        : null,
    status,
    lane,
    archivedAt,
  };
}

function createThreadGroup(
  title = DEFAULT_NEW_THREAD_GROUP_TITLE,
): DesktopThreadGroup {
  const timestamp = now();
  return {
    id: randomUUID(),
    title: title.trim() || DEFAULT_THREAD_GROUP_TITLE,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function normalizeThreadGroup(value: unknown): DesktopThreadGroup | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const group = value as {
    id?: unknown;
    title?: unknown;
    createdAt?: unknown;
    updatedAt?: unknown;
  };
  const id = normalizePersistedId(group.id);
  if (!id) {
    return null;
  }

  const createdAt =
    typeof group.createdAt === 'number' && Number.isFinite(group.createdAt)
      ? group.createdAt
      : now();
  const updatedAt =
    typeof group.updatedAt === 'number' && Number.isFinite(group.updatedAt)
      ? group.updatedAt
      : createdAt;

  return {
    id,
    title:
      typeof group.title === 'string' && group.title.trim().length > 0
        ? group.title.trim()
        : DEFAULT_THREAD_GROUP_TITLE,
    createdAt,
    updatedAt,
  };
}

function cloneThreadGroup(group: DesktopThreadGroup): DesktopThreadGroup {
  return { ...group };
}

function cloneThread(thread: DesktopThread): DesktopThread {
  return { ...thread };
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

    const transferPreview = normalizeTransferredPreviewPath(path);
    if (transferPreview) {
      return {
        kind: 'file',
        source: transferPreview.source,
        workspaceId: typeof target.workspaceId === 'string' ? target.workspaceId : null,
        path: transferPreview.path,
        filename: typeof target.filename === 'string' ? target.filename : null,
        title: typeof target.title === 'string' ? target.title : null,
        contentType: typeof target.contentType === 'string' ? target.contentType : null,
      };
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
    paneId?: unknown;
    threadId?: unknown;
    viewId?: unknown;
    target?: unknown;
  };
  const id = normalizePersistedId(tab.id);
  if (!id) {
    return null;
  }

  const kind =
    tab.kind === 'thread'
      ? 'thread'
      : tab.kind === 'workspace'
        ? 'workspace'
        : tab.kind === 'preview'
          ? 'preview'
          : null;
  if (!kind) {
    return null;
  }

  if (kind === 'preview') {
    const target = normalizePreviewTarget(tab.target);
    const threadId = normalizePersistedId(tab.threadId);
    if (!target || !threadId) {
      return null;
    }

    return {
      id,
      kind,
      paneId: normalizePaneId(tab.paneId),
      threadId,
      viewId: null,
      target,
    };
  }

  const viewId = normalizePersistedId(tab.viewId);
  if (!viewId) {
    return null;
  }

  return {
    id,
    kind,
    paneId: normalizePaneId(tab.paneId),
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
      const thread = this.createThread({
        title: DEFAULT_THREAD_GROUP_TITLE,
        groupId: this.getDefaultThreadGroupId(),
      });
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
      const persistedThreadGroups = Array.isArray(parsed.threadGroups)
        ? parsed.threadGroups.flatMap((group) => {
            const normalized = normalizeThreadGroup(group);
            return normalized ? [normalized] : [];
          })
        : [];
      const threadGroups = persistedThreadGroups.length > 0
        ? persistedThreadGroups
        : [createThreadGroup(DEFAULT_THREAD_GROUP_TITLE)];
      const defaultThreadGroupId = threadGroups[0]!.id;
      const threadGroupIds = new Set(threadGroups.map((group) => group.id));
      const threads = Array.isArray(parsed.threads)
        ? parsed.threads.flatMap((thread) => {
            const normalized = normalizeThread(thread, defaultThreadGroupId);
            if (!normalized) {
              return [];
            }

            if (!threadGroupIds.has(normalized.groupId)) {
              normalized.groupId = defaultThreadGroupId;
            }

            return [normalized];
          })
        : [];
      const activeThreadId = normalizePersistedId(parsed.activeThreadId);
      const activeThreadProvider =
        (activeThreadId
          ? threads.find((thread) => thread.id === activeThreadId)?.provider
          : null) ?? fallbackProvider;
      const activeGroupId =
        normalizePersistedId(parsed.activeGroupId) ?? threadGroups[0]?.id ?? null;
      const threadPreviewStateById = Object.fromEntries(
        Object.entries(
          parsed.threadPreviewStateById ?? parsed.threadPanelStateById ?? {},
        ).flatMap(([threadId, previewState]) => {
          const normalized = normalizePreviewState(previewState);
          return normalized ? [[threadId, normalized]] : [];
        }),
      );
      const normalizedTabs = Array.isArray(parsed.tabs)
        ? parsed.tabs.flatMap((tab) => {
            const normalized = normalizeTab(tab);
            return normalized ? [normalized] : [];
          })
        : [];
      const legacyPreviewTabs = Object.entries(threadPreviewStateById).flatMap(
        ([threadId, previewState]) =>
          previewState.visible
            ? previewState.items.map((item) => ({
                id: getPreviewTabId(threadId, item.target),
                kind: 'preview' as const,
                paneId: LEGACY_SECONDARY_PANE_ID,
                threadId,
                viewId: null,
                target: item.target,
              }))
            : [],
      );
      const tabs = [...normalizedTabs];
      for (const previewTab of legacyPreviewTabs) {
        if (!tabs.some((tab) => tab.id === previewTab.id)) {
          tabs.push(previewTab);
        }
      }
      const persistedPaneLayout = normalizePaneLayoutNode(parsed.paneLayout);
      const paneIdsFromTabs = new Set(
        tabs.map((tab) => normalizePaneId(tab.paneId)),
      );
      if (paneIdsFromTabs.size === 0) {
        paneIdsFromTabs.add(PRIMARY_PANE_ID);
      }
      let paneLayout =
        persistedPaneLayout ??
        (paneIdsFromTabs.has(LEGACY_SECONDARY_PANE_ID)
          ? createSplitPaneLayout(
              'horizontal',
              [createPaneLeaf(PRIMARY_PANE_ID), createPaneLeaf(LEGACY_SECONDARY_PANE_ID)],
              [50, 50],
            )
          : createDefaultPaneLayout());
      paneLayout = ensurePaneLayout(paneLayout, paneIdsFromTabs);
      const paneIds = new Set(listPaneIds(paneLayout));
      const activePaneId =
        normalizePersistedId(parsed.activePaneId) && paneIds.has(normalizePersistedId(parsed.activePaneId)!)
          ? normalizePersistedId(parsed.activePaneId)
          : tabs.find((tab) => paneIds.has(tab.paneId))?.paneId ??
            getFirstPaneId(paneLayout) ??
            PRIMARY_PANE_ID;
      const activeTabIdByPaneSource =
        parsed.activeTabIdByPane && typeof parsed.activeTabIdByPane === 'object'
          ? parsed.activeTabIdByPane
          : {};
      const activeTabIdByPane: Record<string, string | null> = Object.fromEntries(
        Object.entries(activeTabIdByPaneSource).flatMap(([paneId, tabId]) => {
          const normalizedTabId = normalizePersistedId(tabId);
          return [[normalizePaneId(paneId), normalizedTabId]];
        }),
      );
      if (!activeTabIdByPane[PRIMARY_PANE_ID]) {
        activeTabIdByPane[PRIMARY_PANE_ID] = normalizePersistedId(parsed.activeTabId);
      }
      if (!activeTabIdByPane[LEGACY_SECONDARY_PANE_ID]) {
        const activeLegacyPreviewTabId =
          activeThreadId && threadPreviewStateById[activeThreadId]?.activeItemId
            ? getPreviewTabId(
                activeThreadId,
                threadPreviewStateById[activeThreadId]!.items.find(
                  (item) => item.id === threadPreviewStateById[activeThreadId]!.activeItemId,
                )?.target ?? threadPreviewStateById[activeThreadId]!.items[0]!.target,
              )
            : null;
        activeTabIdByPane[LEGACY_SECONDARY_PANE_ID] = activeLegacyPreviewTabId;
      }
      for (const paneId of paneIds) {
        if (!(paneId in activeTabIdByPane)) {
          activeTabIdByPane[paneId] = null;
        }
      }

      return {
        tabs,
        paneLayout,
        activePaneId,
        activeTabIdByPane,
        activeTabId: normalizePersistedId(parsed.activeTabId),
        activeThreadId,
        activeGroupId,
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
        threadPreviewStateById,
        providerStateByThread,
        pluginEnabledById:
          parsed.pluginEnabledById && typeof parsed.pluginEnabledById === 'object'
            ? Object.fromEntries(
                Object.entries(parsed.pluginEnabledById).flatMap(([pluginId, enabled]) =>
                  typeof enabled === 'boolean' ? [[pluginId, enabled]] : [],
                ),
              )
            : {},
        threadGroups,
        threads,
        messagesByThread: parsed.messagesByThread ?? {},
      };
    } catch {
      const provider = getDefaultProvider();
      const defaultThreadGroup = createThreadGroup(DEFAULT_THREAD_GROUP_TITLE);
      return {
        tabs: [],
        paneLayout: createDefaultPaneLayout(),
        activePaneId: PRIMARY_PANE_ID,
        activeTabIdByPane: {
          [PRIMARY_PANE_ID]: null,
        },
        activeTabId: null,
        activeThreadId: null,
        activeGroupId: defaultThreadGroup.id,
        activeViewId: null,
        provider,
        modelsByProvider: {
          [provider]: requireDesktopProvider(provider).getDefaultModel(),
        },
        threadPreviewStateById: {},
        providerStateByThread: {},
        pluginEnabledById: {},
        threadGroups: [defaultThreadGroup],
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

  private findThreadGroup(groupId: string | null): DesktopThreadGroup | null {
    if (!groupId) {
      return null;
    }
    return this.state.threadGroups?.find((group) => group.id === groupId) ?? null;
  }

  private getDefaultThreadGroupId(): string {
    const existing = this.state.threadGroups?.[0];
    if (existing) {
      return existing.id;
    }

    const created = createThreadGroup(DEFAULT_THREAD_GROUP_TITLE);
    this.state.threadGroups = [created];
    return created.id;
  }

  private getTabsForPane(paneId: string): PersistedTab[] {
    return (this.state.tabs ?? []).filter((tab) => tab.paneId === paneId);
  }

  private getPaneLayout(): PersistedPaneNode {
    const paneIds = new Set(
      (this.state.tabs ?? []).map((tab) => normalizePaneId(tab.paneId)),
    );
    if (paneIds.size === 0) {
      paneIds.add(PRIMARY_PANE_ID);
    }

    const layout = ensurePaneLayout(this.state.paneLayout, paneIds);
    this.state.paneLayout = layout;
    return layout;
  }

  private listPaneIds(): string[] {
    return listPaneIds(this.getPaneLayout());
  }

  private pruneEmptyPanes(): void {
    const paneIdsWithTabs = new Set(
      (this.state.tabs ?? []).map((tab) => normalizePaneId(tab.paneId)),
    );

    if (paneIdsWithTabs.size === 0) {
      this.state.paneLayout = createDefaultPaneLayout();
      this.state.activePaneId = PRIMARY_PANE_ID;
      this.state.activeTabIdByPane = {
        [PRIMARY_PANE_ID]: null,
      };
      return;
    }

    const prunedLayout = prunePaneLayout(this.getPaneLayout(), paneIdsWithTabs);
    this.state.paneLayout = ensurePaneLayout(prunedLayout, paneIdsWithTabs);
    const nextPaneIds = new Set(listPaneIds(this.state.paneLayout));
    this.state.activeTabIdByPane = Object.fromEntries(
      Array.from(nextPaneIds, (paneId) => [
        paneId,
        normalizePersistedId(this.state.activeTabIdByPane?.[paneId]),
      ]),
    );

    const activePaneId = normalizePersistedId(this.state.activePaneId);
    if (!activePaneId || !nextPaneIds.has(activePaneId)) {
      this.state.activePaneId = getFirstPaneId(this.state.paneLayout) ?? PRIMARY_PANE_ID;
    }
  }

  private hasPane(paneId: string): boolean {
    return findPaneNode(this.getPaneLayout(), paneId) !== null;
  }

  private getActivePaneId(): string {
    const activePaneId = normalizePersistedId(this.state.activePaneId);
    if (activePaneId && this.hasPane(activePaneId)) {
      return activePaneId;
    }

    return getFirstPaneId(this.getPaneLayout()) ?? PRIMARY_PANE_ID;
  }

  private getActiveTabIdForPane(paneId: string): string | null {
    return normalizePersistedId(this.state.activeTabIdByPane?.[paneId]);
  }

  private setActiveTabIdForPane(paneId: string, tabId: string | null): void {
    this.state.activeTabIdByPane = {
      ...(this.state.activeTabIdByPane ?? {}),
      [paneId]: normalizePersistedId(tabId),
    };
  }

  private getActiveTabForPane(paneId: string): PersistedTab | null {
    const tabs = this.getTabsForPane(paneId);
    const activeTabId = this.getActiveTabIdForPane(paneId);
    return tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null;
  }

  private getGlobalActiveTab(): PersistedTab | null {
    return this.getActiveTabForPane(this.getActivePaneId());
  }

  private getPreferredPreviewPaneId(threadId: string): string {
    const existingPreviewTab =
      (this.state.tabs ?? []).find(
        (tab) => tab.kind === 'preview' && tab.threadId === threadId,
      ) ?? null;
    if (existingPreviewTab) {
      return existingPreviewTab.paneId;
    }

    const activePaneId = this.getActivePaneId();
    const existingAlternatePaneId = this.listPaneIds().find((paneId) => paneId !== activePaneId);
    if (existingAlternatePaneId) {
      return existingAlternatePaneId;
    }

    const previewPaneId = randomUUID();
    this.state.paneLayout = splitPaneLayout(
      this.getPaneLayout(),
      activePaneId,
      previewPaneId,
      'right',
    );
    this.setActiveTabIdForPane(previewPaneId, null);
    return previewPaneId;
  }

  private reconcilePaneActivity(): void {
    this.pruneEmptyPanes();
    const tabsById = new Set((this.state.tabs ?? []).map((tab) => tab.id));
    const paneIds = this.listPaneIds();
    for (const paneId of paneIds) {
      const paneTabs = this.getTabsForPane(paneId);
      const activeTabId = this.getActiveTabIdForPane(paneId);
      this.setActiveTabIdForPane(
        paneId,
        activeTabId && tabsById.has(activeTabId)
          ? activeTabId
          : paneTabs[0]?.id ?? null,
      );
    }
    const activePaneId = this.getActivePaneId();
    const activeTab = this.getActiveTabForPane(activePaneId);
    if (activeTab) {
      this.syncStateFromTab(activeTab);
      return;
    }

    this.state.activePaneId = activePaneId;
    this.state.activeTabId = null;
    this.state.activeViewId = null;
  }

  private syncStateFromTab(tab: PersistedTab | null): void {
    if (!tab) {
      const activePaneId = this.getActivePaneId();
      this.state.activePaneId = activePaneId;
      for (const paneId of this.listPaneIds()) {
        this.setActiveTabIdForPane(paneId, null);
      }
      this.state.activeTabId = null;
      this.state.activeViewId = null;
      return;
    }

    this.state.activePaneId = tab.paneId;
    this.setActiveTabIdForPane(tab.paneId, tab.id);
    this.state.activeTabId = tab.id;
    this.state.activeViewId = tab.viewId;
    if (tab.threadId) {
      this.state.activeThreadId = tab.threadId;
      const thread = this.findThread(tab.threadId);
      if (thread) {
        this.state.activeGroupId = thread.groupId;
        this.state.provider = thread.provider;
        this.ensureProviderModel(thread.provider);
      }
    }
  }

  private upsertTab(tab: Omit<PersistedTab, 'id'>): PersistedTab {
    const existing = (this.state.tabs ?? []).find((current) =>
      current.kind === tab.kind &&
      current.threadId === tab.threadId &&
      current.viewId === tab.viewId &&
      (current.kind !== 'preview'
        ? true
        : getPreviewItemIdFromTab(current) === getPreviewItemIdFromTab(tab)),
    );
    if (existing) {
      if (existing.kind === 'preview' && tab.target) {
        existing.target = tab.target;
      }
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
      if (tab.kind === 'thread') {
        return Boolean(tab.threadId && threadIds.has(tab.threadId) && tab.viewId && viewIds.has(tab.viewId));
      }
      if (tab.kind === 'workspace') {
        return Boolean(tab.viewId && viewIds.has(tab.viewId));
      }
      if (tab.kind === 'preview') {
        return Boolean(tab.threadId && threadIds.has(tab.threadId) && tab.target);
      }
      return false;
    });
  }

  private toDesktopTabs(
    tabs: PersistedTab[],
    views: DesktopView[],
  ): DesktopTab[] {
    const viewById = new Map(views.map((view) => [view.id, view]));
    return tabs.reduce<DesktopTab[]>((result, tab) => {
      if (tab.kind === 'thread') {
        const view = tab.viewId ? viewById.get(tab.viewId) : null;
        if (!view) {
          return result;
        }
        const thread = this.findThread(tab.threadId);
        if (!thread) {
          return result;
        }
        result.push({
          id: tab.id,
          kind: 'thread' as const,
          paneId: tab.paneId,
          threadId: thread.id,
          viewId: view.id,
          title: thread.title,
          subtitle: view.title !== 'Chat' ? view.title : null,
          icon: view.icon,
          closable: true,
        });
        return result;
      }

      if (tab.kind === 'preview') {
        const thread = this.findThread(tab.threadId);
        if (!thread || !tab.target) {
          return result;
        }
        result.push({
          id: tab.id,
          kind: 'preview' as const,
          paneId: tab.paneId,
          threadId: thread.id,
          viewId: null,
          title: getDesktopPreviewItemTitle(tab.target),
          subtitle: thread.title,
          icon: tab.target.kind === 'url' ? 'globe' : 'file',
          closable: true,
          previewItem: {
            id: getDesktopPreviewItemId(tab.target),
            title: getDesktopPreviewItemTitle(tab.target),
            target: tab.target,
            src: null,
            contentType: tab.target.kind === 'file' ? tab.target.contentType ?? null : null,
            renderer: null,
          },
        });
        return result;
      }

      const view = tab.viewId ? viewById.get(tab.viewId) : null;
      if (!view) {
        return result;
      }
      result.push({
        id: tab.id,
        kind: 'workspace' as const,
        paneId: tab.paneId,
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
    this.reconcilePaneActivity();
  }

  listThreads(): DesktopThread[] {
    this.sortThreads();
    return this.state.threads.map((thread) => cloneThread(thread));
  }

  listThreadGroups(): DesktopThreadGroup[] {
    return [...(this.state.threadGroups ?? [])]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((group) => cloneThreadGroup(group));
  }

  getThreadGroup(groupId: string): DesktopThreadGroup | null {
    const group = this.findThreadGroup(groupId);
    return group ? cloneThreadGroup(group) : null;
  }

  getActiveThreadId(): string | null {
    return this.state.activeThreadId;
  }

  getActiveGroupId(): string | null {
    return normalizePersistedId(this.state.activeGroupId) ?? this.state.threadGroups?.[0]?.id ?? null;
  }

  createThreadGroup(title = DEFAULT_NEW_THREAD_GROUP_TITLE): DesktopThreadGroup {
    const group = createThreadGroup(title);
    this.state.threadGroups = [...(this.state.threadGroups ?? []), group];
    this.state.activeGroupId = group.id;
    this.persist();
    return cloneThreadGroup(group);
  }

  updateThreadGroup(groupId: string, title: string): DesktopThreadGroup {
    const group = this.findThreadGroup(groupId);
    if (!group) {
      throw new Error(`Thread group ${groupId} does not exist`);
    }

    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      throw new Error("Thread group title cannot be empty");
    }

    group.title = normalizedTitle;
    group.updatedAt = now();
    this.persist();
    return cloneThreadGroup(group);
  }

  deleteThreadGroup(groupId: string): void {
    const group = this.findThreadGroup(groupId);
    if (!group) {
      throw new Error(`Thread group ${groupId} does not exist`);
    }

    const defaultGroupId = this.getDefaultThreadGroupId();
    if (group.id === defaultGroupId) {
      throw new Error("Default group cannot be deleted");
    }

    const timestamp = now();
    for (const thread of this.state.threads) {
      if (thread.groupId === group.id) {
        thread.groupId = defaultGroupId;
        thread.updatedAt = timestamp;
      }
    }

    this.state.threadGroups = (this.state.threadGroups ?? []).filter(
      (entry) => entry.id !== group.id,
    );
    if (this.state.activeGroupId === group.id) {
      this.state.activeGroupId = defaultGroupId;
    }
    this.touchThreadGroup(defaultGroupId, timestamp);
    this.sortThreads();
    this.persist();
  }

  setActiveGroup(groupId: string): void {
    const group = this.findThreadGroup(groupId);
    if (!group) {
      throw new Error(`Thread group ${groupId} does not exist`);
    }

    this.state.activeGroupId = group.id;
    this.persist();
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
      paneId: this.getActivePaneId(),
      threadId,
      viewId,
    });
    this.syncStateFromTab(tab);
    this.persist();
  }

  activateWorkspaceView(viewId: string): void {
    const tab = this.upsertTab({
      kind: 'workspace',
      paneId: this.getActivePaneId(),
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

  focusPane(paneId: string): void {
    if (!this.hasPane(paneId)) {
      throw new Error(`Pane ${paneId} does not exist`);
    }

    this.state.activePaneId = paneId;
    const activeTab = this.getActiveTabForPane(paneId);
    if (activeTab) {
      this.syncStateFromTab(activeTab);
    } else {
      this.state.activeTabId = null;
      this.state.activeViewId = null;
    }
    this.persist();
  }

  closeTab(tabId: string, views: DesktopView[]): void {
    const tabs = this.normalizeTabs(views);
    const removedTab = tabs.find((tab) => tab.id === tabId) ?? null;
    if (!removedTab) {
      throw new Error(`Tab ${tabId} does not exist`);
    }

    this.state.tabs = tabs.filter((tab) => tab.id !== tabId);

    if (removedTab.kind === 'preview' && removedTab.threadId && removedTab.target) {
      const itemId = getDesktopPreviewItemId(removedTab.target);
      const current = this.state.threadPreviewStateById?.[removedTab.threadId];
      if (current) {
        const items = current.items.filter((item) => item.id !== itemId);
        this.state.threadPreviewStateById = {
          ...(this.state.threadPreviewStateById ?? {}),
          [removedTab.threadId]: {
            visible: current.visible && items.length > 0,
            activeItemId:
              current.activeItemId === itemId
                ? items[0]?.id ?? null
                : current.activeItemId && items.some((item) => item.id === current.activeItemId)
                  ? current.activeItemId
                  : items[0]?.id ?? null,
            items,
          },
        };
      }
    }

    this.reconcilePaneActivity();
    this.persist();
  }

  moveTab(
    tabId: string,
    targetPaneId: string,
    targetIndex?: number,
    placement: DesktopPaneDropPlacement = 'center',
  ): void {
    const tabs = [...(this.state.tabs ?? [])];
    const movingTab = tabs.find((tab) => tab.id === tabId) ?? null;
    if (!movingTab) {
      throw new Error(`Tab ${tabId} does not exist`);
    }

    let destinationPaneId = targetPaneId;
    if (placement !== 'center') {
      if (!this.hasPane(targetPaneId)) {
        throw new Error(`Pane ${targetPaneId} does not exist`);
      }
      destinationPaneId = randomUUID();
      this.state.paneLayout = splitPaneLayout(
        this.getPaneLayout(),
        targetPaneId,
        destinationPaneId,
        placement,
      );
      this.setActiveTabIdForPane(destinationPaneId, null);
    } else if (!this.hasPane(destinationPaneId)) {
      this.state.paneLayout = appendPaneToLayout(this.getPaneLayout(), destinationPaneId);
      this.setActiveTabIdForPane(destinationPaneId, null);
    }

    const sourcePaneId = movingTab.paneId;
    const sourcePaneTabs = this.getTabsForPane(sourcePaneId);
    const sourceIndex = sourcePaneTabs.findIndex((tab) => tab.id === tabId);
    const destinationTabs = this.getTabsForPane(destinationPaneId).filter(
      (tab) => tab.id !== tabId,
    );
    let insertionIndex =
      typeof targetIndex === 'number' && Number.isFinite(targetIndex)
        ? Math.trunc(targetIndex)
        : destinationTabs.length;
    if (sourcePaneId === destinationPaneId && sourceIndex !== -1 && sourceIndex < insertionIndex) {
      insertionIndex -= 1;
    }
    insertionIndex = Math.max(0, Math.min(destinationTabs.length, insertionIndex));

    const nextTabs = tabs.filter((tab) => tab.id !== tabId);
    const movedTab: PersistedTab = {
      ...movingTab,
      paneId: destinationPaneId,
    };
    let destinationCount = 0;
    let inserted = false;
    const reorderedTabs = nextTabs.flatMap((tab) => {
      if (tab.paneId !== destinationPaneId) {
        return [tab];
      }

      if (!inserted && destinationCount === insertionIndex) {
        inserted = true;
        destinationCount += 1;
        return [movedTab, tab];
      }

      destinationCount += 1;
      return [tab];
    });
    if (!inserted) {
      reorderedTabs.push(movedTab);
    }

    this.state.tabs = reorderedTabs;
    this.syncStateFromTab(movedTab);
    this.reconcilePaneActivity();
    this.persist();
  }

  private syncPreviewTabs(threadId: string): void {
    const previewState = this.state.threadPreviewStateById?.[threadId] ?? {
      visible: false,
      activeItemId: null,
      items: [],
    };
    const currentTabs = this.state.tabs ?? [];
    const previewTabs = currentTabs.filter(
      (tab) => tab.kind === 'preview' && tab.threadId === threadId,
    );
    const preferredPaneId =
      previewTabs[0]?.paneId ?? this.getPreferredPreviewPaneId(threadId);
    const desiredItems = previewState.visible ? previewState.items : [];
    const desiredTabs = desiredItems.map<PersistedTab>((item) => {
      const existing =
        previewTabs.find((tab) => getPreviewItemIdFromTab(tab) === item.id) ?? null;
      return {
        id: existing?.id ?? getPreviewTabId(threadId, item.target),
        kind: 'preview',
        paneId: existing?.paneId ?? preferredPaneId,
        threadId,
        viewId: null,
        target: item.target,
      };
    });

    this.state.tabs = [
      ...currentTabs.filter(
        (tab) => !(tab.kind === 'preview' && tab.threadId === threadId),
      ),
      ...desiredTabs,
    ];

    if (desiredTabs.length > 0) {
      const activePreviewTab =
        desiredTabs.find((tab) => getPreviewItemIdFromTab(tab) === previewState.activeItemId) ??
        desiredTabs[0] ??
        null;
      this.syncStateFromTab(activePreviewTab);
      return;
    }

    this.reconcilePaneActivity();
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
    this.syncPreviewTabs(threadId);
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
    this.syncPreviewTabs(threadId);
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
    this.syncPreviewTabs(threadId);
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
    this.syncPreviewTabs(threadId);
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
    this.syncPreviewTabs(threadId);
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
    this.syncPreviewTabs(threadId);
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

  private touchThreadGroup(groupId: string, timestamp = now()): void {
    const group = this.findThreadGroup(groupId);
    if (group) {
      group.updatedAt = timestamp;
    }
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
    this.state.activeGroupId = thread.groupId;
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

  updateThread(
    threadId: string,
    update: {
      title?: string | null;
      groupId?: string | null;
      status?: string | null;
      lane?: string | null;
      archivedAt?: number | null;
    },
  ): DesktopThread {
    const thread = this.findThread(threadId);
    if (!thread) {
      throw new Error(`Thread ${threadId} does not exist`);
    }

    const previousGroupId = thread.groupId;

    if ('title' in update) {
      thread.title =
        typeof update.title === 'string' && update.title.trim().length > 0
          ? update.title.trim()
          : thread.title;
    }

    if ('groupId' in update) {
      const nextGroup =
        typeof update.groupId === 'string' ? this.findThreadGroup(update.groupId) : null;
      if (nextGroup) {
        thread.groupId = nextGroup.id;
      }
    }

    if ('status' in update) {
      thread.status =
        typeof update.status === 'string' && update.status.trim().length > 0
          ? update.status.trim()
          : null;
    }

    if ('lane' in update) {
      thread.lane =
        typeof update.lane === 'string' && update.lane.trim().length > 0
          ? update.lane.trim()
          : null;
    }

    if ('archivedAt' in update) {
      thread.archivedAt =
        typeof update.archivedAt === 'number' && Number.isFinite(update.archivedAt)
          ? update.archivedAt
          : null;
    }

    thread.updatedAt = now();
    if (this.state.activeThreadId === thread.id) {
      this.state.activeGroupId = thread.groupId;
    }
    if (previousGroupId !== thread.groupId) {
      this.touchThreadGroup(previousGroupId, thread.updatedAt);
    }
    this.touchThreadGroup(thread.groupId, thread.updatedAt);
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

  createThread(options: {
    title?: string;
    provider?: DesktopProvider;
    groupId: string;
    status?: string | null;
    lane?: string | null;
    archivedAt?: number | null;
  }): DesktopThread {
    const normalizedProvider = requireDesktopProvider(options.provider ?? this.state.provider).id;
    const resolvedGroupId = this.findThreadGroup(options.groupId)?.id;
    if (!resolvedGroupId) {
      throw new Error(`Thread group ${options.groupId} does not exist`);
    }
    const timestamp = now();
    const thread: DesktopThread = {
      id: randomUUID(),
      groupId: resolvedGroupId,
      provider: normalizedProvider,
      title: options.title?.trim() || DEFAULT_THREAD_TITLE,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastMessagePreview: null,
      status:
        typeof options.status === 'string' && options.status.trim().length > 0
          ? options.status.trim()
          : null,
      lane:
        typeof options.lane === 'string' && options.lane.trim().length > 0
          ? options.lane.trim()
          : null,
      archivedAt:
        typeof options.archivedAt === 'number' && Number.isFinite(options.archivedAt)
          ? options.archivedAt
          : null,
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
    this.state.activeGroupId = resolvedGroupId;
    this.state.provider = normalizedProvider;
    this.ensureProviderModel(normalizedProvider);
    this.touchThreadGroup(resolvedGroupId, timestamp);
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
    this.touchThreadGroup(thread.groupId, thread.updatedAt);
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
      this.touchThreadGroup(thread.groupId, thread.updatedAt);
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
      this.touchThreadGroup(thread.groupId, thread.updatedAt);
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
    this.touchThreadGroup(thread.groupId, thread.updatedAt);

    const lastMessage = messages[messages.length - 1];
    thread.lastMessagePreview = lastMessage
      ? previewText(lastMessage.content) || thread.lastMessagePreview
      : thread.lastMessagePreview;

    this.sortThreads();
    this.persist();
  }

  private buildDesktopPanes(tabs: DesktopTab[]): DesktopPane[] {
    const activeTabIdByPane = this.state.activeTabIdByPane ?? {};
    const panes = this.listPaneIds().map<DesktopPane>((paneId) => {
      const paneTabs = tabs.filter((tab) => normalizePaneId(tab.paneId) === paneId);
      const activeTabId = normalizePersistedId(activeTabIdByPane[paneId]);
      return {
        id: paneId,
        activeTabId:
          activeTabId && paneTabs.some((tab) => tab.id === activeTabId)
            ? activeTabId
            : paneTabs[0]?.id ?? null,
        tabs: paneTabs,
      };
    });

    if (panes.length === 0) {
      return [];
    }

    const activePaneId = this.getActivePaneId();
    if (!panes.some((pane) => pane.id === activePaneId)) {
      this.state.activePaneId = panes[0]?.id ?? PRIMARY_PANE_ID;
    }

    return panes;
  }

  buildSnapshot(
    runtimeStatus: DesktopRuntimeStatus,
    provider: DesktopProvider,
    availableProviders: DesktopProviderOption[],
    model: DesktopModel,
    availableModels: DesktopModelOption[],
    auth: DesktopAuthState,
    views: DesktopView[],
    sidebarPanels: DesktopSidebarPanel[],
    plugins: DesktopSnapshot['plugins'],
  ): DesktopSnapshot {
    const tabs = this.normalizeTabs(views);
    this.state.tabs = tabs;
    this.reconcilePaneActivity();
    const desktopTabs = this.toDesktopTabs(this.state.tabs ?? [], views);
    const panes = this.buildDesktopPanes(desktopTabs);
    const paneLayout = toDesktopPaneLayout(this.getPaneLayout());

    return {
      threadGroups: this.listThreadGroups(),
      tabs: desktopTabs,
      panes,
      paneLayout,
      activePaneId: this.getActivePaneId(),
      activeTabId: this.getActiveTabId(),
      activeThreadId: this.state.activeThreadId,
      activeGroupId: this.getActiveGroupId(),
      activeViewId: this.getActiveViewId(),
      threadPreviewStateById: this.getThreadPreviewStateById(),
      threadRuntimeById: {},
      threads: this.listThreads(),
      messagesByThread: this.getMessagesByThread(),
      provider,
      availableProviders,
      model,
      availableModels,
      auth,
      runtimeStatus,
      views,
      sidebarPanels,
      plugins,
      pendingPermissionRequest: null,
    };
  }
}
