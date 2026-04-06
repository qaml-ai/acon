import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  DesktopPanel,
  DesktopPluginRecord,
  DesktopView,
} from "../../../desktop/shared/protocol";
import {
  getHarnessAdapterForProvider,
  getHarnessAdapters,
  type CamelAIHarnessAdapterInfo,
} from "./harness-adapters";
import { createAgentExtensionThreadStateStore } from "./thread-state";
import type {
  CamelAIActivationContext,
  CamelAIBeforePromptResult,
  CamelAIEvent,
  CamelAIEventContext,
  CamelAIEventHandler,
  CamelAIEventName,
  CamelAIExtensionModule,
  CamelAIManifest,
  CamelAIPluginApi,
  CamelAIRuntimeRecord,
  CamelAIToolRegistration,
  DiscoveredCamelAIExtension,
} from "./types";

const BUILTIN_EXTENSION_DIRECTORY = resolve(
  process.cwd(),
  "desktop-agentos/plugins/builtin",
);
const USER_EXTENSION_DIRECTORY = resolve(
  process.env.DESKTOP_DATA_DIR || resolve(process.cwd(), "desktop-agentos/.local"),
  "plugins",
);
const DEFAULT_EXTENSION_DIRECTORIES = [
  { path: BUILTIN_EXTENSION_DIRECTORY, builtin: true },
  { path: USER_EXTENSION_DIRECTORY, builtin: false },
].filter((entry) => Boolean(entry.path));

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function getEntrypoint(
  extensionPath: string,
  packageJson: Record<string, unknown>,
  manifest: Record<string, unknown>,
): string {
  if (typeof manifest.main === "string") {
    return resolve(extensionPath, manifest.main);
  }
  if (typeof packageJson.main === "string") {
    return resolve(extensionPath, packageJson.main);
  }
  return resolve(extensionPath, "index.ts");
}

function discoverExtensions(): DiscoveredCamelAIExtension[] {
  const discovered: DiscoveredCamelAIExtension[] = [];

  for (const root of DEFAULT_EXTENSION_DIRECTORIES) {
    if (!existsSync(root.path) || !isDirectory(root.path)) {
      continue;
    }

    for (const entry of readdirSync(root.path)) {
      const extensionPath = resolve(root.path, entry);
      if (!isDirectory(extensionPath)) {
        continue;
      }

      const packagePath = resolve(extensionPath, "package.json");
      if (!existsSync(packagePath)) {
        continue;
      }

      try {
        const packageJson = readJson(packagePath);
        const rawManifest =
          packageJson.camelai && typeof packageJson.camelai === "object"
            ? (packageJson.camelai as Record<string, unknown>)
            : null;
        if (!rawManifest || typeof rawManifest.id !== "string") {
          continue;
        }

        const manifest: CamelAIManifest = {
          id: rawManifest.id,
          name:
            typeof rawManifest.name === "string"
              ? rawManifest.name
              : typeof packageJson.name === "string"
                ? packageJson.name
                : rawManifest.id,
          version:
            typeof rawManifest.version === "string"
              ? rawManifest.version
              : typeof packageJson.version === "string"
                ? packageJson.version
                : "0.0.0",
          description:
            typeof rawManifest.description === "string"
              ? rawManifest.description
              : typeof packageJson.description === "string"
                ? packageJson.description
                : "",
          icon:
            typeof rawManifest.icon === "string" ? rawManifest.icon : undefined,
          main:
            typeof rawManifest.main === "string" ? rawManifest.main : undefined,
          settings:
            typeof rawManifest.settings === "string"
              ? rawManifest.settings
              : undefined,
          webviews:
            rawManifest.webviews && typeof rawManifest.webviews === "object"
              ? Object.fromEntries(
                  Object.entries(rawManifest.webviews).flatMap(([id, value]) =>
                    typeof value === "string" ? [[id, value]] : [],
                  ),
                )
              : {},
        };

        discovered.push({
          id: manifest.id,
          extensionPath,
          entryPath: getEntrypoint(extensionPath, packageJson, rawManifest),
          builtin: root.builtin,
          packageName:
            typeof packageJson.name === "string"
              ? packageJson.name
              : manifest.id,
          packageVersion:
            typeof packageJson.version === "string"
              ? packageJson.version
              : "0.0.0",
          manifest,
        });
      } catch {
        continue;
      }
    }
  }

  return discovered.sort((left, right) =>
    left.manifest.name!.localeCompare(right.manifest.name!),
  );
}

function getContributionId(pluginId: string, contributionId: string): string {
  return `plugin:${pluginId}:${contributionId}`;
}

function resolveWebviewEntrypoint(
  extension: DiscoveredCamelAIExtension,
  webviewId: string,
): string | null {
  const webviewPath = extension.manifest.webviews?.[webviewId];
  if (!webviewPath) {
    return null;
  }
  if (/^(https?:|data:)/.test(webviewPath)) {
    return webviewPath;
  }
  return resolve(extension.extensionPath, webviewPath);
}

export class CamelAIExtensionHost {
  private readonly records = new Map<string, CamelAIRuntimeRecord>();
  private initializePromise: Promise<void> | null = null;
  private initialized = false;

  private ensureRecord(
    discovered: DiscoveredCamelAIExtension,
  ): CamelAIRuntimeRecord {
    const existing = this.records.get(discovered.id);
    if (existing) {
      return existing;
    }

    const created: CamelAIRuntimeRecord = {
      discovered,
      activated: false,
      activationError: null,
      views: new Map(),
      panels: new Map(),
      commands: new Map(),
      tools: new Map(),
      handlers: new Map(),
    };
    this.records.set(discovered.id, created);
    return created;
  }

  async initialize(context: CamelAIActivationContext): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (this.initializePromise) {
      await this.initializePromise;
      return;
    }

    this.initializePromise = this.loadRecords(context);

    try {
      await this.initializePromise;
    } finally {
      this.initializePromise = null;
    }
  }

  async refresh(context: CamelAIActivationContext): Promise<void> {
    if (this.initializePromise) {
      try {
        await this.initializePromise;
      } catch {
        // Ignore the previous startup failure and retry from scratch below.
      }
    }

    this.records.clear();
    this.initialized = false;
    this.initializePromise = this.loadRecords(context);

    try {
      await this.initializePromise;
    } finally {
      this.initializePromise = null;
    }
  }

  private async loadRecords(context: CamelAIActivationContext): Promise<void> {
    const discovered = discoverExtensions();
    for (const entry of discovered) {
      const record = this.ensureRecord(entry);
      await this.activateRecord(record, context);
    }
    this.initialized = true;
  }

  private createThreadState(
    pluginId: string,
    threadId: string | null,
    context: CamelAIActivationContext,
  ) {
    return createAgentExtensionThreadStateStore({
      pluginId,
      threadId,
      threadStateDirectory:
        threadId && context.activeThreadId === threadId
          ? context.threadStateDirectory
          : threadId && context.runtimeDirectory
            ? resolve(
                context.runtimeDirectory,
                "pi-home",
                ".pi",
                "camelai-state",
                "threads",
                threadId,
              )
            : null,
    });
  }

  private createApi(
    record: CamelAIRuntimeRecord,
    context: CamelAIActivationContext,
  ): CamelAIPluginApi {
    const harnessAdapters = getHarnessAdapters();
    const pluginId = record.discovered.id;

    return {
      pluginId,
      harnessAdapters,
      on: (event, handler) => {
        const handlers = record.handlers.get(event) ?? [];
        handlers.push(handler);
        record.handlers.set(event, handlers);
      },
      registerView: (id, view) => {
        record.views.set(id, view);
      },
      registerPanel: (id, panel) => {
        record.panels.set(id, panel);
      },
      registerCommand: (id, command) => {
        record.commands.set(id, command);
      },
      registerTool: (id, tool) => {
        record.tools.set(id, tool);
      },
      threadState: (threadId = context.activeThreadId) =>
        this.createThreadState(pluginId, threadId ?? null, context),
    };
  }

  private async activateRecord(
    record: CamelAIRuntimeRecord,
    context: CamelAIActivationContext,
  ): Promise<void> {
    if (record.activated || record.activationError) {
      return;
    }

    try {
      const loadedModule = (await import(
        pathToFileURL(record.discovered.entryPath).href
      )) as CamelAIExtensionModule & {
        default?: CamelAIExtensionModule;
      };
      const module =
        loadedModule && typeof loadedModule === "object" && loadedModule.default
          ? loadedModule.default
          : loadedModule;
      if (typeof module.activate === "function") {
        await module.activate(this.createApi(record, context));
      }
      record.activated = true;
      record.activationError = null;
    } catch (error) {
      record.activated = false;
      record.activationError =
        error instanceof Error ? error.message : String(error);
    }
  }

  private createPluginRecord(record: CamelAIRuntimeRecord): DesktopPluginRecord {
    const { discovered } = record;
    return {
      id: discovered.id,
      name: discovered.manifest.name ?? discovered.id,
      version: discovered.packageVersion,
      description: discovered.manifest.description ?? null,
      source: discovered.builtin ? "builtin" : "user",
      enabled: true,
      path: discovered.extensionPath,
      main: discovered.entryPath,
      webviews: Object.entries(discovered.manifest.webviews ?? {}).map(
        ([id, entrypoint]) => ({
          id,
          entrypoint: resolveWebviewEntrypoint(discovered, id) ?? entrypoint,
        }),
      ),
      capabilities: {
        views: Array.from(record.views.entries()).map(([id, view]) => ({
          id,
          title: view.title,
          description: view.description ?? null,
          icon: view.icon ?? null,
          scope: view.scope ?? "workspace",
          default: view.default === true,
        })),
        panels: Array.from(record.panels.entries()).map(([id, panel]) => ({
          id,
          title: panel.title,
          description: panel.description ?? null,
          icon: panel.icon ?? null,
          autoOpen: panel.autoOpen ?? "never",
        })),
        commands: Array.from(record.commands.entries()).map(([id, command]) => ({
          id,
          title: command.title,
          description: command.description ?? null,
        })),
        tools: Array.from(record.tools.entries()).map(([id, tool]) => ({
          id,
          title: tool.title ?? null,
          description: tool.description ?? null,
          schema: null,
          availableTo: tool.availableTo ?? ["*"],
        })),
      },
      runtime: {
        activated: record.activated,
        activationError: record.activationError,
        subscribedEvents: Array.from(record.handlers.keys()),
        registeredViewIds: Array.from(record.views.keys()),
        registeredPanelIds: Array.from(record.panels.keys()),
        registeredCommandIds: Array.from(record.commands.keys()),
        registeredToolIds: Array.from(record.tools.keys()),
      },
    };
  }

  private buildViews(
    context: CamelAIActivationContext,
    plugins: DesktopPluginRecord[],
  ): DesktopView[] {
    const pluginById = new Map(plugins.map((plugin) => [plugin.id, plugin]));
    const views: DesktopView[] = [];

    for (const record of this.records.values()) {
      const plugin = pluginById.get(record.discovered.id);
      if (!plugin) {
        continue;
      }

      for (const [id, view] of record.views.entries()) {
        const render =
          view.render.kind === "host"
            ? { kind: "host" as const, component: view.render.component }
            : {
                kind: "webview" as const,
                entrypoint: resolveWebviewEntrypoint(
                  record.discovered,
                  view.render.webviewId,
                ) ?? "",
              };
        const threadState = this.createThreadState(
          record.discovered.id,
          context.activeThreadId,
          context,
        );
        views.push({
          id: getContributionId(record.discovered.id, id),
          title: view.title,
          description: view.description ?? null,
          icon: view.icon ?? record.discovered.manifest.icon ?? null,
          pluginId: record.discovered.id,
          scope: view.scope ?? "workspace",
          isDefault: view.default === true,
          render,
          hostData: view.buildHostData
            ? view.buildHostData({
                ...context,
                pluginId: record.discovered.id,
                viewId: id,
                threadState,
                plugin,
              })
            : null,
        });
      }
    }

    return views;
  }

  private buildPanels(
    context: CamelAIActivationContext,
    plugins: DesktopPluginRecord[],
  ): DesktopPanel[] {
    const pluginById = new Map(plugins.map((plugin) => [plugin.id, plugin]));
    const panels: DesktopPanel[] = [];

    for (const record of this.records.values()) {
      const plugin = pluginById.get(record.discovered.id);
      if (!plugin) {
        continue;
      }

      for (const [id, panel] of record.panels.entries()) {
        const render =
          panel.render.kind === "host"
            ? { kind: "host" as const, component: panel.render.component }
            : {
                kind: "webview" as const,
                entrypoint: resolveWebviewEntrypoint(
                  record.discovered,
                  panel.render.webviewId,
                ) ?? "",
              };
        const threadState = this.createThreadState(
          record.discovered.id,
          context.activeThreadId,
          context,
        );
        panels.push({
          id: getContributionId(record.discovered.id, id),
          title: panel.title,
          description: panel.description ?? null,
          icon: panel.icon ?? record.discovered.manifest.icon ?? null,
          pluginId: record.discovered.id,
          autoOpen: panel.autoOpen ?? "never",
          render,
          hostData: panel.buildHostData
            ? panel.buildHostData({
                ...context,
                pluginId: record.discovered.id,
                panelId: id,
                threadId: context.activeThreadId,
                threadState,
                plugin,
              })
            : null,
        });
      }
    }

    return panels;
  }

  getSnapshot(context: CamelAIActivationContext): {
    views: DesktopView[];
    panels: DesktopPanel[];
    plugins: DesktopPluginRecord[];
  } {
    const plugins = Array.from(this.records.values()).map((record) =>
      this.createPluginRecord(record),
    );
    return {
      views: this.buildViews(context, plugins),
      panels: this.buildPanels(context, plugins),
      plugins,
    };
  }

  getDefaultViewId(preferredScope?: "thread" | "workspace"): string | null {
    const allViews: Array<{
      pluginId: string;
      viewId: string;
      scope: "thread" | "workspace";
      isDefault: boolean;
    }> = [];

    for (const record of this.records.values()) {
      for (const [viewId, view] of record.views.entries()) {
        allViews.push({
          pluginId: record.discovered.id,
          viewId,
          scope: view.scope ?? "workspace",
          isDefault: view.default === true,
        });
      }
    }

    const defaultMatch = allViews.find(
      (view) =>
        view.isDefault &&
        (!preferredScope || view.scope === preferredScope),
    );
    if (defaultMatch) {
      return getContributionId(defaultMatch.pluginId, defaultMatch.viewId);
    }

    const firstScopeMatch = allViews.find(
      (view) => !preferredScope || view.scope === preferredScope,
    );
    return firstScopeMatch
      ? getContributionId(firstScopeMatch.pluginId, firstScopeMatch.viewId)
      : null;
  }

  getDefaultThreadPanelId(): string | null {
    for (const record of this.records.values()) {
      for (const [id, panel] of record.panels.entries()) {
        if ((panel.autoOpen ?? "never") !== "never") {
          return getContributionId(record.discovered.id, id);
        }
      }
    }
    return null;
  }

  async emit(
    type: CamelAIEventName,
    event: CamelAIEvent,
    context: CamelAIActivationContext,
  ): Promise<unknown[]> {
    await this.initialize(context);
    const results: unknown[] = [];

    for (const record of this.records.values()) {
      const handlers = record.handlers.get(type) ?? [];
      if (handlers.length === 0) {
        continue;
      }

      const threadId = "threadId" in event && typeof event.threadId === "string"
        ? event.threadId
        : context.activeThreadId;
      const eventContext: CamelAIEventContext = {
        ...context,
        pluginId: record.discovered.id,
        threadId,
        threadState: this.createThreadState(record.discovered.id, threadId, context),
      };

      for (const handler of handlers) {
        results.push(await handler(event, eventContext));
      }
    }

    return results;
  }

  async applyBeforePrompt(
    threadId: string,
    content: string,
    context: CamelAIActivationContext,
  ): Promise<{ cancelled: boolean; content: string }> {
    const results = await this.emit(
      "before_prompt",
      {
        type: "before_prompt",
        threadId,
        content,
      },
      context,
    );

    let nextContent = content;
    for (const result of results) {
      if (!result || typeof result !== "object") {
        continue;
      }
      const patch = result as CamelAIBeforePromptResult;
      if (patch.cancel) {
        return { cancelled: true, content: nextContent };
      }
      if (typeof patch.content === "string") {
        nextContent = patch.content;
      }
      if (typeof patch.prepend === "string" && patch.prepend.trim()) {
        nextContent = `${patch.prepend.trim()}\n\n${nextContent}`;
      }
      if (typeof patch.append === "string" && patch.append.trim()) {
        nextContent = `${nextContent}\n\n${patch.append.trim()}`;
      }
    }

    return { cancelled: false, content: nextContent };
  }

  getToolRegistrations(): Array<{
    pluginId: string;
    toolId: string;
    tool: CamelAIToolRegistration;
  }> {
    const registrations: Array<{
      pluginId: string;
      toolId: string;
      tool: CamelAIToolRegistration;
    }> = [];

    for (const record of this.records.values()) {
      for (const [toolId, tool] of record.tools.entries()) {
        registrations.push({
          pluginId: record.discovered.id,
          toolId,
          tool,
        });
      }
    }

    return registrations;
  }

  getHarnessAdaptersForContext(
    context: CamelAIActivationContext,
  ): CamelAIHarnessAdapterInfo[] {
    const primary = getHarnessAdapterForProvider(context.provider);
    const all = getHarnessAdapters();
    return [primary, ...all.filter((adapter) => adapter.id !== primary.id)];
  }
}
