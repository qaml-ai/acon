import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  DesktopPreviewTarget,
  DesktopPluginPermission,
  DesktopPluginRecord,
  DesktopThreadPreviewState,
  DesktopView,
} from "../../../desktop/shared/protocol";
import builtinExtensionLab from "../../plugins/builtin/extension-lab/index";
import builtinHostMcpManager from "../../plugins/builtin/host-mcp-manager/index";
import builtinPreviewControl from "../../plugins/builtin/preview-control/index";
import builtinThreadJournal from "../../plugins/builtin/thread-journal/index";
import {
  getHarnessAdapterForProvider,
  getHarnessAdapters,
  type CamelAIHarnessAdapterInfo,
} from "./harness-adapters";
import { createAgentExtensionThreadStateStore } from "./thread-state";
import { CAMELAI_CURRENT_API_VERSION } from "./types";
import type {
  CamelAIActivationContext,
  CamelAIDisposable,
  CamelAIDisposableLike,
  CamelAIBeforePromptResult,
  CamelAIEvent,
  CamelAIEventContext,
  CamelAIEventHandler,
  CamelAIEventName,
  CamelAIExtensionModule,
  CamelAIHostMcpMutationContext,
  CamelAIHostMcpServerRegistration,
  CamelAIInstallHostMcpServerResult,
  CamelAIInstallHttpHostMcpServerOptions,
  CamelAIInstallStdioHostMcpServerOptions,
  CamelAIManifest,
  CamelAIPersistedHostMcpServerRecord,
  CamelAIPluginApi,
  CamelAIRuntimeRecord,
  CamelAIToolRegistration,
  DiscoveredCamelAIExtension,
} from "./types";

const extensionHostDirectory = dirname(fileURLToPath(import.meta.url));
const backendDirectory = resolve(extensionHostDirectory, "..");
function resolveFirstExistingDirectory(candidates: string[]): string {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate) && isDirectory(candidate)) {
      return candidate;
    }
  }
  return candidates[0] ?? "";
}

function getExtensionDirectories(): Array<{ path: string; builtin: boolean }> {
  return [
    {
      path: resolveFirstExistingDirectory([
        process.env.DESKTOP_BUILTIN_PLUGIN_DIR?.trim() || "",
        resolve(backendDirectory, "..", "plugins", "builtin"),
        resolve(process.cwd(), "desktop-container", "plugins", "builtin"),
      ]),
      builtin: true,
    },
    {
      path: resolve(
        process.env.DESKTOP_DATA_DIR || resolve(backendDirectory, "..", ".local"),
        "plugins",
      ),
      builtin: false,
    },
  ].filter((entry) => Boolean(entry.path));
}
const BUILTIN_EXTENSION_MODULES: Record<string, CamelAIExtensionModule> = {
  "extension-lab": builtinExtensionLab as unknown as CamelAIExtensionModule,
  "host-mcp-manager": builtinHostMcpManager as unknown as CamelAIExtensionModule,
  "preview-control": builtinPreviewControl as unknown as CamelAIExtensionModule,
  "thread-journal": builtinThreadJournal as unknown as CamelAIExtensionModule,
};
const VALID_PLUGIN_PERMISSIONS = new Set<DesktopPluginPermission>([
  "host-mcp",
  "thread-preview",
]);

interface ThreadPreviewMutationResult {
  threadId: string;
  state: DesktopThreadPreviewState;
}

export interface CamelAIExtensionHostOptions {
  registerHostMcpServer?: (registration: CamelAIHostMcpServerRegistration) => void;
  unregisterHostMcpServer?: (serverId: string) => void;
  listInstalledHostMcpServers?: () => CamelAIPersistedHostMcpServerRecord[];
  installStdioHostMcpServer?: (
    server: CamelAIInstallStdioHostMcpServerOptions,
    context: CamelAIHostMcpMutationContext,
  ) => Promise<CamelAIInstallHostMcpServerResult>;
  uninstallInstalledHostMcpServer?: (
    serverId: string,
    context: Omit<CamelAIHostMcpMutationContext, "workspaceDirectory">,
  ) => Promise<boolean>;
  isPluginEnabled?: (
    pluginId: string,
    plugin: DiscoveredCamelAIExtension,
  ) => boolean;
  installHttpHostMcpServer?: (
    server: CamelAIInstallHttpHostMcpServerOptions,
    context: CamelAIHostMcpMutationContext,
  ) => Promise<CamelAIInstallHostMcpServerResult>;
  openThreadPreviewItem?: (
    threadId: string | null,
    target: DesktopPreviewTarget,
  ) => ThreadPreviewMutationResult;
  setThreadPreviewItems?: (
    threadId: string | null,
    targets: DesktopPreviewTarget[],
    activeIndex?: number | null,
  ) => ThreadPreviewMutationResult;
  clearThreadPreview?: (threadId: string | null) => ThreadPreviewMutationResult;
  setThreadPreviewVisibility?: (
    threadId: string | null,
    visible: boolean,
  ) => ThreadPreviewMutationResult;
}

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

function normalizePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function parsePluginPermissions(value: unknown): DesktopPluginPermission[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) =>
    typeof entry === "string" && VALID_PLUGIN_PERMISSIONS.has(entry as DesktopPluginPermission)
      ? [entry as DesktopPluginPermission]
      : [],
  );
}

function parseSettingsSchema(value: unknown): CamelAIManifest["settings"] | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const raw = value as {
    description?: unknown;
    fields?: unknown;
  };
  const fields =
    raw.fields && typeof raw.fields === "object"
      ? Object.fromEntries(
          Object.entries(raw.fields as Record<string, unknown>).flatMap(
            ([fieldId, fieldValue]) => {
              if (!fieldValue || typeof fieldValue !== "object") {
                return [];
              }
              const field = fieldValue as {
                type?: unknown;
                label?: unknown;
                description?: unknown;
                required?: unknown;
                options?: unknown;
              };
              if (
                typeof field.type !== "string" ||
                !["boolean", "number", "secret", "select", "string"].includes(
                  field.type,
                ) ||
                typeof field.label !== "string"
              ) {
                return [];
              }

              const options = Array.isArray(field.options)
                ? field.options.flatMap((option) => {
                    if (!option || typeof option !== "object") {
                      return [];
                    }
                    const rawOption = option as {
                      label?: unknown;
                      value?: unknown;
                    };
                    return typeof rawOption.label === "string" &&
                        typeof rawOption.value === "string"
                      ? [
                          {
                            label: rawOption.label,
                            value: rawOption.value,
                          },
                        ]
                      : [];
                  })
                : [];

              return [
                [
                  fieldId,
                  {
                    type: field.type,
                    label: field.label,
                    description:
                      typeof field.description === "string"
                        ? field.description
                        : undefined,
                    required: field.required === true,
                    options,
                  },
                ],
              ];
            },
          ),
        )
      : {};

  return {
    description:
      typeof raw.description === "string" ? raw.description : undefined,
    fields,
  };
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

  for (const root of getExtensionDirectories()) {
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
          apiVersion:
            normalizePositiveInteger(rawManifest.apiVersion) ??
            CAMELAI_CURRENT_API_VERSION,
          minApiVersion:
            normalizePositiveInteger(rawManifest.minApiVersion) ??
            CAMELAI_CURRENT_API_VERSION,
          permissions: parsePluginPermissions(rawManifest.permissions),
          disableable:
            typeof rawManifest.disableable === "boolean"
              ? rawManifest.disableable
              : undefined,
          settings: parseSettingsSchema(rawManifest.settings),
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

function getCompatibilityError(manifest: CamelAIManifest): string | null {
  const declaredApiVersion =
    manifest.apiVersion ?? CAMELAI_CURRENT_API_VERSION;
  const minApiVersion = manifest.minApiVersion ?? declaredApiVersion;

  if (minApiVersion > CAMELAI_CURRENT_API_VERSION) {
    return `Requires plugin API v${minApiVersion}, but the host only supports v${CAMELAI_CURRENT_API_VERSION}.`;
  }
  if (declaredApiVersion > CAMELAI_CURRENT_API_VERSION) {
    return `Targets plugin API v${declaredApiVersion}, but the host only supports v${CAMELAI_CURRENT_API_VERSION}.`;
  }
  return null;
}

function createDisposable(callback: () => void | Promise<void>): CamelAIDisposable {
  let disposed = false;
  return {
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      await callback();
    },
  };
}

function normalizeDisposable(
  disposable: CamelAIDisposableLike,
): CamelAIDisposable {
  if (typeof disposable === "function") {
    return createDisposable(disposable);
  }
  return createDisposable(() => disposable.dispose());
}

export class CamelAIExtensionHost {
  private readonly options: CamelAIExtensionHostOptions;
  private readonly records = new Map<string, CamelAIRuntimeRecord>();
  private initializePromise: Promise<void> | null = null;
  private initialized = false;
  private loadGeneration = 0;

  constructor(options: CamelAIExtensionHostOptions = {}) {
    this.options = options;
  }

  private ensureRecord(
    discovered: DiscoveredCamelAIExtension,
  ): CamelAIRuntimeRecord {
    const existing = this.records.get(discovered.id);
    if (existing) {
      return existing;
    }

    const created: CamelAIRuntimeRecord = {
      discovered,
      enabled: this.options.isPluginEnabled?.(discovered.id, discovered) ?? true,
      activated: false,
      activationError: null,
      compatibilityError: getCompatibilityError(discovered.manifest),
      views: new Map(),
      commands: new Map(),
      tools: new Map(),
      handlers: new Map(),
      disposables: [],
      deactivate: null,
      registeredHostMcpServerIds: new Set(),
    };
    this.records.set(discovered.id, created);
    return created;
  }

  private registerRecordDisposable(
    record: CamelAIRuntimeRecord,
    disposable: CamelAIDisposableLike,
  ): CamelAIDisposable {
    const normalized = normalizeDisposable(disposable);
    record.disposables.push(normalized);
    return normalized;
  }

  private pluginHasPermission(
    record: CamelAIRuntimeRecord,
    permission: DesktopPluginPermission,
  ): boolean {
    return (
      record.discovered.manifest.permissions?.includes(permission) ?? false
    );
  }

  private assertPluginPermission(
    record: CamelAIRuntimeRecord,
    permission: DesktopPluginPermission,
  ): void {
    if (this.pluginHasPermission(record, permission)) {
      return;
    }
    throw new Error(
      `Plugin ${record.discovered.id} must declare the '${permission}' permission.`,
    );
  }

  private async deactivateRecord(record: CamelAIRuntimeRecord): Promise<void> {
    const explicitDeactivate = record.deactivate;
    record.deactivate = null;

    try {
      if (explicitDeactivate) {
        await explicitDeactivate();
      }
    } finally {
      const disposables = [...record.disposables].reverse();
      record.disposables = [];
      for (const disposable of disposables) {
        await disposable.dispose();
      }

      record.views.clear();
      record.commands.clear();
      record.tools.clear();
      record.handlers.clear();
      record.registeredHostMcpServerIds.clear();
      record.activated = false;
    }
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

    for (const record of this.records.values()) {
      await this.deactivateRecord(record);
    }
    this.records.clear();
    this.initialized = false;
    this.loadGeneration += 1;
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
                "thread-state",
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
      registerDisposable: (disposable) =>
        this.registerRecordDisposable(record, disposable),
      on: (event, handler) => {
        const handlers = record.handlers.get(event) ?? [];
        handlers.push(handler);
        record.handlers.set(event, handlers);
        return this.registerRecordDisposable(record, () => {
          const registeredHandlers = record.handlers.get(event) ?? [];
          const nextHandlers = registeredHandlers.filter(
            (entry) => entry !== handler,
          );
          if (nextHandlers.length === 0) {
            record.handlers.delete(event);
            return;
          }
          record.handlers.set(event, nextHandlers);
        });
      },
      registerView: (id, view) => {
        record.views.set(id, view);
        return this.registerRecordDisposable(record, () => {
          record.views.delete(id);
        });
      },
      registerCommand: (id, command) => {
        record.commands.set(id, command);
        return this.registerRecordDisposable(record, () => {
          record.commands.delete(id);
        });
      },
      registerTool: (id, tool) => {
        record.tools.set(id, tool);
        return this.registerRecordDisposable(record, () => {
          record.tools.delete(id);
        });
      },
      registerHostMcpServer: (registration) => {
        this.assertPluginPermission(record, "host-mcp");
        this.options.registerHostMcpServer?.(registration);
        record.registeredHostMcpServerIds.add(registration.id);
        return this.registerRecordDisposable(record, () => {
          if (!record.registeredHostMcpServerIds.delete(registration.id)) {
            return;
          }
          this.options.unregisterHostMcpServer?.(registration.id);
        });
      },
      unregisterHostMcpServer: (serverId) => {
        this.assertPluginPermission(record, "host-mcp");
        const registered = record.registeredHostMcpServerIds.delete(serverId);
        if (registered) {
          this.options.unregisterHostMcpServer?.(serverId);
        }
        return registered;
      },
      listInstalledHostMcpServers: () => {
        this.assertPluginPermission(record, "host-mcp");
        return this.options.listInstalledHostMcpServers?.() ?? [];
      },
      installStdioHostMcpServer: async (server) => {
        this.assertPluginPermission(record, "host-mcp");
        if (!this.options.installStdioHostMcpServer) {
          throw new Error("Host MCP installation is unavailable.");
        }
        return await this.options.installStdioHostMcpServer(server, {
          pluginId,
          harness: context.harness,
          threadId: context.activeThreadId,
          workspaceDirectory: context.workspaceDirectory,
        });
      },
      installHttpHostMcpServer: async (server) => {
        this.assertPluginPermission(record, "host-mcp");
        if (!this.options.installHttpHostMcpServer) {
          throw new Error("Host MCP installation is unavailable.");
        }
        return await this.options.installHttpHostMcpServer(server, {
          pluginId,
          harness: context.harness,
          threadId: context.activeThreadId,
          workspaceDirectory: context.workspaceDirectory,
        });
      },
      uninstallInstalledHostMcpServer: async (serverId) => {
        this.assertPluginPermission(record, "host-mcp");
        return (
          await this.options.uninstallInstalledHostMcpServer?.(serverId, {
            pluginId,
            harness: context.harness,
            threadId: context.activeThreadId,
          })
        ) ?? false;
      },
      openThreadPreviewItem: (target, threadId = context.activeThreadId) => {
        this.assertPluginPermission(record, "thread-preview");
        if (!this.options.openThreadPreviewItem) {
          throw new Error("Thread preview mutation is unavailable.");
        }
        return this.options.openThreadPreviewItem(threadId ?? null, target);
      },
      setThreadPreviewItems: (
        targets,
        options = {},
      ) => {
        this.assertPluginPermission(record, "thread-preview");
        if (!this.options.setThreadPreviewItems) {
          throw new Error("Thread preview mutation is unavailable.");
        }
        return this.options.setThreadPreviewItems(
          options.threadId ?? context.activeThreadId ?? null,
          targets,
          options.activeIndex,
        );
      },
      clearThreadPreview: (threadId = context.activeThreadId) => {
        this.assertPluginPermission(record, "thread-preview");
        if (!this.options.clearThreadPreview) {
          throw new Error("Thread preview mutation is unavailable.");
        }
        return this.options.clearThreadPreview(threadId ?? null);
      },
      setThreadPreviewVisibility: (
        visible,
        threadId = context.activeThreadId,
      ) => {
        this.assertPluginPermission(record, "thread-preview");
        if (!this.options.setThreadPreviewVisibility) {
          throw new Error("Thread preview mutation is unavailable.");
        }
        return this.options.setThreadPreviewVisibility(threadId ?? null, visible);
      },
      threadState: (threadId = context.activeThreadId) =>
        this.createThreadState(pluginId, threadId ?? null, context),
    };
  }

  private async activateRecord(
    record: CamelAIRuntimeRecord,
    context: CamelAIActivationContext,
  ): Promise<void> {
    if (!record.enabled || record.compatibilityError) {
      record.activated = false;
      record.activationError = null;
      return;
    }
    if (record.activated || record.activationError) {
      return;
    }

    try {
      const builtinModule =
        record.discovered.builtin
          ? BUILTIN_EXTENSION_MODULES[record.discovered.id] ?? null
          : null;
      let module: CamelAIExtensionModule;

      if (builtinModule) {
        module = builtinModule;
      } else {
        const moduleUrl = pathToFileURL(record.discovered.entryPath);
        moduleUrl.searchParams.set("camelai-load", String(this.loadGeneration));
        const loadedModule = (await import(
          moduleUrl.href
        )) as CamelAIExtensionModule & {
          default?: CamelAIExtensionModule;
        };
        module =
          loadedModule && typeof loadedModule === "object" && loadedModule.default
            ? loadedModule.default
            : loadedModule;
      }

      if (typeof module.activate === "function") {
        const activationResult = await module.activate(
          this.createApi(record, context),
        );
        if (activationResult) {
          const disposable = normalizeDisposable(activationResult);
          record.disposables.push(disposable);
        }
      }
      if (typeof module.deactivate === "function") {
        record.deactivate = () => module.deactivate?.();
      }
      record.activated = true;
      record.activationError = null;
    } catch (error) {
      await this.deactivateRecord(record);
      record.activated = false;
      record.activationError =
        error instanceof Error ? error.message : String(error);
    }
  }

  private createPluginRecord(record: CamelAIRuntimeRecord): DesktopPluginRecord {
    const { discovered } = record;
    const settings =
      typeof discovered.manifest.settings === "string"
        ? {
            description: discovered.manifest.settings,
            fields: [],
          }
        : discovered.manifest.settings
          ? {
              description: discovered.manifest.settings.description ?? null,
              fields: Object.entries(discovered.manifest.settings.fields).map(
                ([fieldId, field]) => ({
                  id: fieldId,
                  type: field.type,
                  label: field.label,
                  description: field.description ?? null,
                  required: field.required === true,
                  options: field.options ?? [],
                }),
              ),
            }
          : null;

    return {
      id: discovered.id,
      name: discovered.manifest.name ?? discovered.id,
      version: discovered.packageVersion,
      description: discovered.manifest.description ?? null,
      source: discovered.builtin ? "builtin" : "user",
      enabled: record.enabled,
      disableable:
        discovered.manifest.disableable ?? !discovered.builtin,
      path: discovered.extensionPath,
      main: discovered.entryPath,
      webviews: Object.entries(discovered.manifest.webviews ?? {}).map(
        ([id, entrypoint]) => ({
          id,
          entrypoint: resolveWebviewEntrypoint(discovered, id) ?? entrypoint,
        }),
      ),
      permissions: discovered.manifest.permissions ?? [],
      settings,
      compatibility: {
        currentApiVersion: CAMELAI_CURRENT_API_VERSION,
        declaredApiVersion:
          discovered.manifest.apiVersion ?? CAMELAI_CURRENT_API_VERSION,
        minApiVersion:
          discovered.manifest.minApiVersion ??
          discovered.manifest.apiVersion ??
          CAMELAI_CURRENT_API_VERSION,
        compatible: !record.compatibilityError,
        reason: record.compatibilityError,
      },
      capabilities: {
        views: Array.from(record.views.entries()).map(([id, view]) => ({
          id,
          title: view.title,
          description: view.description ?? null,
          icon: view.icon ?? null,
          scope: view.scope ?? "workspace",
          default: view.default === true,
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

  getSnapshot(context: CamelAIActivationContext): {
    views: DesktopView[];
    plugins: DesktopPluginRecord[];
  } {
    const plugins = Array.from(this.records.values()).map((record) =>
      this.createPluginRecord(record),
    );
    return {
      views: this.buildViews(context, plugins),
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
