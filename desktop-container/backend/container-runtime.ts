import { createHash } from "node:crypto";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { DesktopRuntimeStatus } from "../../desktop/shared/protocol";
import { logDesktop } from "../../desktop/backend/log";
import { getHostClaudeCredentialsJson } from "../../desktop/backend/anthropic";
import type { DesktopProviderDefinition } from "./provider-types";
import {
  HostMcpRegistry,
  type HostMcpBridgeRequest,
  type HostMcpServerRegistration,
} from "./host-mcp";

const DEFAULT_RUNTIME_DIRECTORY = resolve(process.cwd(), "desktop-container/.local/runtime");
const DEFAULT_WORKSPACE_DIRECTORY = resolve(process.cwd());
const DEFAULT_CONTAINER_IMAGE_ROOT = resolve(
  process.cwd(),
  "desktop-container/container-images",
);
const CONTAINER_HOST_RPC_SOCKET_PATH = "/data/host-rpc/bridge.sock";
const DEFAULT_HOST_RPC_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_HOST_RPC_FETCH_MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_CONTAINER_COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_CONTAINER_IMAGE_LOAD_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_CONTAINER_DAEMON_READY_TIMEOUT_MS = 30_000;
const DEFAULT_DAEMON_REQUEST_TIMEOUT_MS = 30_000;
const HOST_CODEX_HOME = process.env.CODEX_HOME?.trim()
  ? resolve(process.env.CODEX_HOME)
  : resolve(homedir(), ".codex");
const HOST_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR?.trim()
  ? resolve(process.env.CLAUDE_CONFIG_DIR)
  : resolve(homedir(), ".claude");
const HOST_CLAUDE_JSON_PATH = resolve(homedir(), ".claude.json");
const HOST_PI_HOME = resolve(homedir(), ".pi");
const HOST_OPENCODE_DATA_DIR = resolve(homedir(), ".local", "share", "opencode");
const HOST_OPENCODE_CONFIG_DIR = resolve(homedir(), ".config", "opencode");
const FORWARDED_PROVIDER_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENCODE_API_KEY",
] as const;

export interface RuntimeManager {
  getWorkspaceDirectory(): string;
  getManagedWorkspaceDirectory(): string;
  getUserUploadsDirectory(): string;
  getUserOutputsDirectory(): string;
  getRuntimeDirectory(): string;
  getThreadStateDirectory(threadId: string): string;
  getCachedStatus(): DesktopRuntimeStatus;
  registerHostMcpServer(registration: HostMcpServerRegistration): void;
  unregisterHostMcpServer(serverId: string): void;
  dispose(): void;
  ensureRuntime(
    provider: DesktopProviderDefinition,
    onStatus?: (status: DesktopRuntimeStatus) => void,
  ): Promise<DesktopRuntimeStatus>;
  cancelPrompt(options: CancelContainerPromptOptions): Promise<void>;
  streamPrompt(options: StreamContainerPromptOptions): Promise<StreamContainerPromptResult>;
}

export interface CancelContainerPromptOptions {
  provider: DesktopProviderDefinition;
  threadId: string;
  model: string;
}

export interface StreamContainerPromptOptions {
  provider: DesktopProviderDefinition;
  threadId: string;
  content: string;
  model: string;
  sessionId?: string | null;
  onSessionId?: (sessionId: string) => void;
  onDelta?: (delta: string) => void;
  onRuntimeEvent?: (event: unknown) => void;
}

export interface StreamContainerPromptResult {
  finalText: string;
  model: string;
  sessionId: string;
  stopReason: string | null;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function parseTimeoutMs(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function formatTimeoutError(commandLabel: string, timeoutMs: number): Error {
  return new Error(
    `${commandLabel} timed out after ${timeoutMs}ms. Apple container may be stuck; try \`container system stop\` then \`container system start\`.`,
  );
}

function normalizeConfiguredPath(value: string | null | undefined): string | null {
  if (!value?.trim()) {
    return null;
  }

  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

function resolveContainerCommand(): string {
  const configuredPath = normalizeConfiguredPath(
    process.env.DESKTOP_CONTAINER_BIN_PATH,
  );
  if (configuredPath) {
    return configuredPath;
  }

  if (process.env.DESKTOP_CONTAINER_REQUIRE_BUNDLED === "1") {
    throw new Error(
      "Bundled Apple container CLI path is missing. Expected DESKTOP_CONTAINER_BIN_PATH to point at the app-bundled `container` binary.",
    );
  }

  return "container";
}

function resolveContainerImageRoot(): string {
  const configuredPath = normalizeConfiguredPath(
    process.env.DESKTOP_CONTAINER_IMAGE_ROOT,
  );
  if (configuredPath) {
    return configuredPath;
  }

  return DEFAULT_CONTAINER_IMAGE_ROOT;
}

function getClaudeJsonSeedDirectory(runtimeDirectory: string): string {
  return resolve(runtimeDirectory, "seed", "claude-json");
}

function getSharedContainerBaseName(runtimeDirectory: string): string {
  const hash = createHash("sha1")
    .update(`${runtimeDirectory}:shared`)
    .digest("hex")
    .slice(0, 12);
  return `acon-acpx-${hash}`;
}

function buildSharedContainerName(baseContainerName: string): string {
  return `${baseContainerName}-${process.pid.toString(36)}-${Date.now().toString(36)}`;
}

interface ManagedWorkspaceState {
  id: string;
  rootPath: string;
  metadataPath: string;
}

interface ProviderContainerState {
  baseContainerName: string;
  containerName: string;
  ensuredSessions: Map<string, string>;
  startupPromise: Promise<void> | null;
  daemon: ProviderDaemonState | null;
}

interface ProviderDaemonState {
  child: ChildProcessWithoutNullStreams;
  readyPromise: Promise<void>;
  stdoutBuffer: string;
  stderrBuffer: string;
  pendingRequests: Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout | null;
    }
  >;
}

interface ActivePromptListener {
  onDelta?: (delta: string) => void;
  onRuntimeEvent?: (event: unknown) => void;
}

interface CapturedCommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface DaemonEnvelope {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  type?: unknown;
  result?: unknown;
  error?: {
    code?: string;
    message?: string;
  };
}

interface BundledImageManifest {
  images?: Array<{
    archive?: unknown;
    id?: unknown;
    imageName?: unknown;
  }>;
}

function isRecoverableRuntimeError(error: unknown): boolean {
  const message = formatError(error);
  return /failed to create process in container|xpc connection error|connection interrupted|container system start|container daemon exited|daemon is not ready|broken pipe|not running/i.test(
    message,
  );
}

export class ContainerRuntimeManager implements RuntimeManager {
  private lastRuntimeStatus: DesktopRuntimeStatus | null = null;
  private readonly runtimeDirectory =
    process.env.DESKTOP_RUNTIME_DIR || DEFAULT_RUNTIME_DIRECTORY;
  private readonly dataDirectory =
    process.env.DESKTOP_DATA_DIR?.trim() || resolve(this.runtimeDirectory, "..", "data");
  private readonly workspaceDirectory =
    process.env.DESKTOP_WORKSPACE_DIR?.trim() ||
    process.env.DESKTOP_CONTAINER_WORKSPACE_DIR?.trim() ||
    DEFAULT_WORKSPACE_DIRECTORY;
  private readonly containerCommand = resolveContainerCommand();
  private readonly containerImageRoot = resolveContainerImageRoot();
  private readonly checkedImages = new Set<string>();
  private readonly hostMcpRegistry = new HostMcpRegistry();
  private readonly activePromptListeners = new Map<
    string,
    Set<ActivePromptListener>
  >();
  private managedWorkspaceState: ManagedWorkspaceState | null = null;
  private sharedContainerState: ProviderContainerState | null = null;

  getWorkspaceDirectory(): string {
    return this.workspaceDirectory;
  }

  getManagedWorkspaceDirectory(): string {
    return this.ensureManagedWorkspaceInitialized().rootPath;
  }

  getUserUploadsDirectory(): string {
    return this.ensureTransferDirectory("uploads");
  }

  getUserOutputsDirectory(): string {
    return this.ensureTransferDirectory("outputs");
  }

  getRuntimeDirectory(): string {
    return this.runtimeDirectory;
  }

  getThreadStateDirectory(threadId: string): string {
    return resolve(this.runtimeDirectory, "thread-state", threadId);
  }

  getCachedStatus(): DesktopRuntimeStatus {
    return (
      this.lastRuntimeStatus ?? {
        state: "stopped",
        detail: "Apple container runtime is idle.",
        helperPath: this.containerCommand,
        runtimeDirectory: this.runtimeDirectory,
      }
    );
  }

  registerHostMcpServer(registration: HostMcpServerRegistration): void {
    this.hostMcpRegistry.registerServer(registration);
  }

  unregisterHostMcpServer(serverId: string): void {
    this.hostMcpRegistry.unregisterServer(serverId);
  }

  private async ensureContainerSystemStarted(): Promise<void> {
    const result = await this.runCapturedCommand(["system", "start"], {
      timeoutMs: parseTimeoutMs(
        process.env.DESKTOP_CONTAINER_SYSTEM_TIMEOUT_MS,
        DEFAULT_CONTAINER_COMMAND_TIMEOUT_MS,
      ),
      commandLabel: "container system start",
    });
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() ||
          result.stdout.trim() ||
          "Failed to start Apple container system services.",
      );
    }
  }

  dispose(): void {
    this.hostMcpRegistry.dispose();
    if (this.sharedContainerState) {
      const state = this.sharedContainerState;
      this.stopProviderDaemon(state);
      spawnSync(this.containerCommand, ["stop", state.containerName], {
        encoding: "utf8",
      });
    }
    this.lastRuntimeStatus = {
      state: "stopped",
      detail: "Apple container runtime stopped.",
      helperPath: this.containerCommand,
      runtimeDirectory: this.runtimeDirectory,
    };
  }

  async ensureRuntime(
    provider: DesktopProviderDefinition,
    onStatus?: (status: DesktopRuntimeStatus) => void,
  ): Promise<DesktopRuntimeStatus> {
    const startingStatus: DesktopRuntimeStatus = {
      state: "starting",
      detail: `Preparing the ${provider.label} container runtime.`,
      helperPath: this.containerCommand,
      runtimeDirectory: this.runtimeDirectory,
      imageReference: provider.getImageName(),
    };
    this.lastRuntimeStatus = startingStatus;
    onStatus?.(startingStatus);

    try {
      mkdirSync(this.runtimeDirectory, { recursive: true });
      mkdirSync(this.getThreadStateDirectory("bootstrap"), { recursive: true });

      if (!existsSync(this.containerImageRoot)) {
        throw new Error(
          `Bundled container image assets were not found at ${this.containerImageRoot}.`,
        );
      }

      if (this.containerCommand !== "container" && !existsSync(this.containerCommand)) {
        throw new Error(
          `Bundled Apple container CLI was not found at ${this.containerCommand}.`,
        );
      }

      const versionResult = await this.runCapturedCommand(["--version"]);
      if (versionResult.code !== 0) {
        throw new Error(
          versionResult.stderr?.trim() ||
            versionResult.stdout?.trim() ||
            "Apple container CLI is not available.",
        );
      }

      await this.ensureContainerSystemStarted();
      await this.ensureImage(provider, onStatus);
      const startupAttemptLimit = 3;
      for (let attempt = 1; attempt <= startupAttemptLimit; attempt += 1) {
        try {
          await this.ensureProviderContainer(provider, onStatus);
          break;
        } catch (error) {
          if (!isRecoverableRuntimeError(error)) {
            throw error;
          }
          if (attempt >= startupAttemptLimit) {
            throw error;
          }

          logDesktop(
            "desktop-runtime",
            "provider_container:startup_retry",
            {
              provider: provider.id,
              attempt,
              startupAttemptLimit,
              error: formatError(error),
            },
            "warn",
          );
          await this.restartProviderContainer(provider);
        }
      }

      const readyStatus: DesktopRuntimeStatus = {
        state: "running",
        detail: `${provider.label} is ready via Apple containers.`,
        helperPath: this.containerCommand,
        runtimeDirectory: this.runtimeDirectory,
        imageReference: provider.getImageName(),
      };
      this.lastRuntimeStatus = readyStatus;
      onStatus?.(readyStatus);
      return readyStatus;
    } catch (error) {
      const failedStatus: DesktopRuntimeStatus = {
        state: "error",
        detail: formatError(error),
        helperPath: this.containerCommand,
        runtimeDirectory: this.runtimeDirectory,
        imageReference: provider.getImageName(),
      };
      this.lastRuntimeStatus = failedStatus;
      onStatus?.(failedStatus);
      throw error;
    }
  }

  private async ensureImage(
    provider: DesktopProviderDefinition,
    onStatus?: (status: DesktopRuntimeStatus) => void,
  ): Promise<void> {
    const imageName = provider.getImageName();
    if (this.checkedImages.has(imageName)) {
      return;
    }

    const inspect = await this.runCapturedCommand(
      ["image", "inspect", imageName],
      {
        commandLabel: `container image inspect ${imageName}`,
      },
    );
    if (inspect.code === 0) {
      this.checkedImages.add(imageName);
      return;
    }
    const bundledImageArchivePath = this.resolveBundledImageArchivePath(imageName);
    if (bundledImageArchivePath) {
      const loadingStatus: DesktopRuntimeStatus = {
        state: "starting",
        detail: `Loading bundled Apple container image ${imageName}.`,
        helperPath: this.containerCommand,
        runtimeDirectory: this.runtimeDirectory,
        imageReference: imageName,
      };
      this.lastRuntimeStatus = loadingStatus;
      onStatus?.(loadingStatus);

      const loadResult = await this.runCapturedCommand(
        ["image", "load", "--input", bundledImageArchivePath],
        {
          commandLabel: `container image load ${imageName}`,
          timeoutMs: parseTimeoutMs(
            process.env.DESKTOP_CONTAINER_IMAGE_LOAD_TIMEOUT_MS,
            DEFAULT_CONTAINER_IMAGE_LOAD_TIMEOUT_MS,
          ),
        },
      );
      if (loadResult.code === 0) {
        const loadedInspect = await this.runCapturedCommand(
          ["image", "inspect", imageName],
          {
            commandLabel: `container image inspect ${imageName}`,
          },
        );
        if (loadedInspect.code === 0) {
          this.checkedImages.add(imageName);
          return;
        }
      }
    }
    const inspectOutput = inspect.stderr?.trim() || inspect.stdout?.trim();
    const missingImageError = new Error(
      `Missing Apple container image ${imageName}. Run \`bun run prepare:container\` before starting the desktop runtime.${
        inspectOutput ? ` (${inspectOutput})` : ""
      }`,
    );
    const failedStatus: DesktopRuntimeStatus = {
      state: "error",
      detail: missingImageError.message,
      helperPath: this.containerCommand,
      runtimeDirectory: this.runtimeDirectory,
      imageReference: imageName,
    };
    this.lastRuntimeStatus = failedStatus;
    onStatus?.(failedStatus);
    throw missingImageError;
  }

  private resolveBundledImageArchivePath(imageName: string): string | null {
    const manifestPath = resolve(
      this.containerImageRoot,
      "bundled-image-manifest.json",
    );
    if (!existsSync(manifestPath)) {
      return null;
    }

    try {
      const manifest = JSON.parse(
        readFileSync(manifestPath, "utf8"),
      ) as BundledImageManifest;
      const record = manifest.images?.find(
        (candidate) =>
          typeof candidate?.imageName === "string" &&
          candidate.imageName === imageName &&
          typeof candidate.archive === "string" &&
          candidate.archive.trim().length > 0,
      );
      if (!record || typeof record.archive !== "string") {
        return null;
      }

      const archivePath = resolve(this.containerImageRoot, record.archive);
      return existsSync(archivePath) ? archivePath : null;
    } catch {
      return null;
    }
  }

  private getSharedContainerState(): ProviderContainerState {
    if (this.sharedContainerState) {
      return this.sharedContainerState;
    }

    const baseContainerName = getSharedContainerBaseName(this.runtimeDirectory);
    this.sharedContainerState = {
      baseContainerName,
      containerName: buildSharedContainerName(baseContainerName),
      ensuredSessions: new Map<string, string>(),
      startupPromise: null,
      daemon: null,
    };
    return this.sharedContainerState;
  }

  private rotateSharedContainerName(state: ProviderContainerState): string {
    state.containerName = buildSharedContainerName(state.baseContainerName);
    return state.containerName;
  }

  private getManagedWorkspaceState(): ManagedWorkspaceState {
    if (this.managedWorkspaceState) {
      return this.managedWorkspaceState;
    }

    const id = "default";
    const workspaceRoot = resolve(this.dataDirectory, "workspaces", id);
    this.managedWorkspaceState = {
      id,
      rootPath: resolve(workspaceRoot, "root"),
      metadataPath: resolve(workspaceRoot, "metadata.json"),
    };
    return this.managedWorkspaceState;
  }

  private writeManagedWorkspaceMetadata(
    state: ManagedWorkspaceState,
    seedMode: "empty",
  ): void {
    writeFileSync(
      state.metadataPath,
      JSON.stringify(
        {
          workspaceId: state.id,
          containerPath: "/workspace",
          seedMode,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  private ensureManagedWorkspaceInitialized(): ManagedWorkspaceState {
    const state = this.getManagedWorkspaceState();
    if (existsSync(state.rootPath)) {
      chmodSync(state.rootPath, 0o777);
      if (!existsSync(state.metadataPath)) {
        this.writeManagedWorkspaceMetadata(state, "empty");
      }
      return state;
    }

    mkdirSync(state.rootPath, { recursive: true });
    chmodSync(state.rootPath, 0o777);
    this.writeManagedWorkspaceMetadata(state, "empty");
    logDesktop("desktop-runtime", "managed_workspace:initialized", {
      workspaceId: state.id,
      rootPath: state.rootPath,
    });
    return state;
  }

  private async inspectContainerStatus(containerName: string): Promise<string | null> {
    const inspect = await this.runCapturedCommand(["inspect", containerName], {
      commandLabel: `container inspect ${containerName}`,
    });
    if (inspect.code !== 0) {
      return null;
    }

    try {
      const parsed = JSON.parse(inspect.stdout) as Array<{ status?: unknown }>;
      const status = parsed[0]?.status;
      return typeof status === "string" ? status : null;
    } catch {
      return null;
    }
  }

  private async runCapturedCommand(
    args: string[],
    options: {
      cwd?: string;
      stdin?: string;
      timeoutMs?: number;
      commandLabel?: string;
    } = {},
  ): Promise<CapturedCommandResult> {
    return await new Promise<CapturedCommandResult>((resolvePromise, rejectPromise) => {
      const child = spawn(this.containerCommand, args, {
        cwd: options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      const timeoutMs = options.timeoutMs ?? DEFAULT_CONTAINER_COMMAND_TIMEOUT_MS;
      const commandLabel =
        options.commandLabel ??
        `${this.containerCommand} ${args.join(" ")}`.trim();
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null) {
            child.kill("SIGKILL");
          }
        }, 1_000).unref();
        rejectPromise(formatTimeoutError(commandLabel, timeoutMs));
      }, timeoutMs);

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        rejectPromise(error);
      });
      child.on("exit", (code, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolvePromise({
          code,
          signal,
          stdout,
          stderr,
        });
      });

      if (typeof options.stdin === "string") {
        child.stdin.end(options.stdin);
      } else {
        child.stdin.end();
      }
    });
  }

  private async restartProviderContainer(
    provider: DesktopProviderDefinition,
  ): Promise<void> {
    const state = this.getSharedContainerState();
    logDesktop(
      "desktop-runtime",
      "provider_container:restart",
      {
        provider: provider.id,
        containerName: state.containerName,
      },
      "warn",
    );
    await this.ensureContainerSystemStarted();
    state.ensuredSessions.clear();
    state.startupPromise = null;
    this.stopProviderDaemon(state);
    await this.runCapturedCommand(["stop", state.containerName], {
      commandLabel: `container stop ${state.containerName}`,
    });
    await this.ensureProviderContainer(provider);
  }

  private async deleteProviderContainer(
    containerName: string,
    providerId: string,
  ): Promise<void> {
    const removeResult = await this.runCapturedCommand(
      ["delete", "--force", containerName],
      {
        commandLabel: `container delete ${containerName}`,
      },
    );
    if (removeResult.code !== 0) {
      throw new Error(
        removeResult.stderr?.trim() ||
          removeResult.stdout?.trim() ||
          `Failed to delete stale container ${containerName}.`,
      );
    }
    logDesktop("desktop-runtime", "shared_container:deleted_stale", {
      provider: providerId,
      containerName,
    });
  }

  private ensureTransferDirectory(kind: "uploads" | "outputs"): string {
    const directory = resolve(this.dataDirectory, "transfers", kind);
    mkdirSync(directory, { recursive: true });
    chmodSync(directory, 0o777);
    return directory;
  }

  private buildProviderContainerRunArgs(
    provider: DesktopProviderDefinition,
    state: ProviderContainerState,
    managedWorkspace: ManagedWorkspaceState,
    providersDataDirectory: string,
  ): string[] {
    const userUploadsDirectory = this.ensureTransferDirectory("uploads");
    const userOutputsDirectory = this.ensureTransferDirectory("outputs");
    const args = [
      "run",
      "--interactive",
      "--rm",
      "--name",
      state.containerName,
      "--workdir",
      "/workspace",
      "--volume",
      `${providersDataDirectory}:/data/providers`,
      "--volume",
      `${managedWorkspace.rootPath}:/workspace`,
      "--volume",
      `${userUploadsDirectory}:/mnt/user-uploads`,
      "--volume",
      `${userOutputsDirectory}:/mnt/user-outputs`,
      "--env",
      `ACON_HOST_RPC_SOCKET=${CONTAINER_HOST_RPC_SOCKET_PATH}`,
    ];

    if (existsSync(HOST_CODEX_HOME)) {
      args.push(
        "--mount",
        `type=bind,source=${HOST_CODEX_HOME},target=/seed-codex,readonly`,
      );
    }

    if (existsSync(HOST_CLAUDE_CONFIG_DIR)) {
      args.push(
        "--mount",
        `type=bind,source=${HOST_CLAUDE_CONFIG_DIR},target=/seed-claude,readonly`,
      );
    }
    const seedDirectory = this.prepareClaudeSeed(
      resolve(this.runtimeDirectory, "providers", "claude"),
    );
    if (seedDirectory) {
      args.push(
        "--mount",
        `type=bind,source=${seedDirectory},target=/seed-claude-json,readonly`,
      );
    }

    if (existsSync(HOST_PI_HOME)) {
      args.push(
        "--mount",
        `type=bind,source=${HOST_PI_HOME},target=/seed-pi,readonly`,
      );
    }

    if (existsSync(HOST_OPENCODE_DATA_DIR)) {
      args.push(
        "--mount",
        `type=bind,source=${HOST_OPENCODE_DATA_DIR},target=/seed-opencode-data,readonly`,
      );
    }

    if (existsSync(HOST_OPENCODE_CONFIG_DIR)) {
      args.push(
        "--mount",
        `type=bind,source=${HOST_OPENCODE_CONFIG_DIR},target=/seed-opencode-config,readonly`,
      );
    }

    for (const envName of FORWARDED_PROVIDER_ENV_VARS) {
      const value = process.env[envName]?.trim();
      if (!value) {
        continue;
      }
      args.push("--env", `${envName}=${value}`);
    }

    args.push(
      provider.getImageName(),
      "node",
      "/usr/local/lib/acon/acon-agentd.mjs",
    );
    return args;
  }

  private async ensureProviderContainer(
    provider: DesktopProviderDefinition,
    onStatus?: (status: DesktopRuntimeStatus) => void,
  ): Promise<void> {
    await this.ensureContainerSystemStarted();
    const state = this.getSharedContainerState();
    const existingStatus = await this.inspectContainerStatus(state.containerName);
    if (existingStatus === "running" && state.daemon) {
      await state.daemon.readyPromise;
      logDesktop("desktop-runtime", "shared_container:reuse", {
        provider: provider.id,
        containerName: state.containerName,
      });
      return;
    }

    if (state.startupPromise) {
      await state.startupPromise;
      return;
    }

    state.startupPromise = (async () => {
      state.ensuredSessions.clear();
      if (existingStatus) {
        logDesktop(
          "desktop-runtime",
          "shared_container:delete_before_start",
          {
            provider: provider.id,
            containerName: state.containerName,
            status: existingStatus,
          },
          "warn",
        );
        try {
          await this.deleteProviderContainer(state.containerName, provider.id);
        } catch (error) {
          const previousContainerName = state.containerName;
          const nextContainerName = this.rotateSharedContainerName(state);
          logDesktop(
            "desktop-runtime",
            "shared_container:delete_failed_rotate_name",
            {
              provider: provider.id,
              previousContainerName,
              nextContainerName,
              error: formatError(error),
            },
            "warn",
          );
        }
      }
      const managedWorkspace = this.ensureManagedWorkspaceInitialized();
      const providersDataDirectory = resolve(this.runtimeDirectory, "providers");
      mkdirSync(providersDataDirectory, { recursive: true });
      chmodSync(providersDataDirectory, 0o777);
      logDesktop("desktop-runtime", "shared_container:start_requested", {
        provider: provider.id,
        containerName: state.containerName,
        workspaceDirectory: managedWorkspace.rootPath,
        providersDataDirectory,
        imageName: provider.getImageName(),
      });

      const startingStatus: DesktopRuntimeStatus = {
        state: "starting",
        detail: "Starting the shared agent container.",
        helperPath: this.containerCommand,
        runtimeDirectory: this.runtimeDirectory,
        imageReference: provider.getImageName(),
        containerID: state.containerName,
      };
      this.lastRuntimeStatus = startingStatus;
      onStatus?.(startingStatus);

      const args = this.buildProviderContainerRunArgs(
        provider,
        state,
        managedWorkspace,
        providersDataDirectory,
      );
      const child = spawn(
        this.containerCommand,
        args,
        {
          cwd: this.workspaceDirectory,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      const daemon: ProviderDaemonState = {
        child,
        readyPromise: Promise.resolve(),
        stdoutBuffer: "",
        stderrBuffer: "",
        pendingRequests: new Map(),
      };

      const readyPromise = new Promise<void>((resolvePromise, rejectPromise) => {
        let ready = false;
        const timeoutMs = parseTimeoutMs(
          process.env.DESKTOP_CONTAINER_DAEMON_READY_TIMEOUT_MS,
          DEFAULT_CONTAINER_DAEMON_READY_TIMEOUT_MS,
        );
        const readyTimeout = setTimeout(() => {
          if (ready) {
            return;
          }
          ready = true;
          rejectPromise(
            formatTimeoutError(
              `container daemon startup for ${state.containerName}`,
              timeoutMs,
            ),
          );
        }, timeoutMs);
        const fail = (error: unknown) => {
          if (ready) {
            logDesktop(
              "desktop-runtime",
              "provider_daemon:runtime_error",
              {
                provider: provider.id,
                containerName: state.containerName,
                error: formatError(error),
              },
              "warn",
            );
            return;
          }
          ready = true;
          clearTimeout(readyTimeout);
          rejectPromise(error instanceof Error ? error : new Error(formatError(error)));
        };

        child.on("error", fail);
        child.on("exit", (code, signal) => {
          if (state.daemon === daemon) {
            this.stopProviderDaemon(state);
          }
          const detail = `Container daemon exited (code=${code}, signal=${signal}).`;
          for (const [requestId, pending] of daemon.pendingRequests.entries()) {
            pending.timer && clearTimeout(pending.timer);
            pending.reject(
              new Error(
                daemon.stderrBuffer.trim()
                  ? `${detail} ${daemon.stderrBuffer.trim()}`
                  : detail,
              ),
            );
            daemon.pendingRequests.delete(requestId);
          }
          fail(
            new Error(
              daemon.stderrBuffer.trim()
                ? `${detail} ${daemon.stderrBuffer.trim()}`
                : detail,
            ),
          );
        });

        child.stdout.on("data", (chunk: string) => {
          if (state.daemon !== daemon) {
            return;
          }

          daemon.stdoutBuffer += chunk;
          while (true) {
            const newlineIndex = daemon.stdoutBuffer.indexOf("\n");
            if (newlineIndex === -1) {
              break;
            }

            const line = daemon.stdoutBuffer.slice(0, newlineIndex).trim();
            daemon.stdoutBuffer = daemon.stdoutBuffer.slice(newlineIndex + 1);
            if (!line) {
              continue;
            }

            let message: DaemonEnvelope;
            try {
              message = JSON.parse(line) as DaemonEnvelope;
            } catch {
              fail(new Error(`Container daemon returned invalid JSON: ${line}`));
              continue;
            }

            if (message.type === "ready") {
              if (!ready) {
                ready = true;
                clearTimeout(readyTimeout);
                resolvePromise();
              }
              continue;
            }

            if (message.type === "request") {
              void this.handleProviderDaemonRequest(state, message);
              continue;
            }

            if (message.type === "response") {
              const requestId =
                typeof message.id === "string" ? message.id : null;
              if (!requestId) {
                continue;
              }
              const pending = daemon.pendingRequests.get(requestId);
              if (!pending) {
                continue;
              }
              daemon.pendingRequests.delete(requestId);
              pending.timer && clearTimeout(pending.timer);
              if (message.error?.message) {
                pending.reject(new Error(message.error.message));
              } else {
                pending.resolve(message.result ?? null);
              }
              continue;
            }

            if (message.type === "notification") {
              this.handleProviderDaemonNotification(message);
              continue;
            }

            logDesktop(
              "desktop-runtime",
              "provider_daemon:unexpected_message",
              {
                provider: provider.id,
                containerName: state.containerName,
                message,
              },
              "warn",
            );
          }
        });

        child.stderr.on("data", (chunk: string) => {
          if (state.daemon !== daemon) {
            return;
          }

          daemon.stderrBuffer += chunk;
          logDesktop(
            "desktop-runtime",
            "provider_daemon:stderr",
            {
              provider: provider.id,
              containerName: state.containerName,
              chunk: chunk.trim(),
            },
            "debug",
          );
        });
      });
      daemon.readyPromise = readyPromise;
      state.daemon = daemon;

      try {
        await readyPromise;
      } catch (error) {
        this.stopProviderDaemon(state);
        throw error;
      }

      logDesktop("desktop-runtime", "shared_container:started", {
        provider: provider.id,
        containerName: state.containerName,
        workspaceDirectory: managedWorkspace.rootPath,
        providersDataDirectory,
        imageName: provider.getImageName(),
        status: "running",
      });
    })();

    try {
      await state.startupPromise;
    } finally {
      state.startupPromise = null;
    }
  }

  private stopProviderDaemon(state: ProviderContainerState): void {
    const daemon = state.daemon;
    state.daemon = null;
    if (!daemon) {
      return;
    }

    for (const [requestId, pending] of daemon.pendingRequests.entries()) {
      pending.timer && clearTimeout(pending.timer);
      pending.reject(new Error("Container daemon stopped before request completed."));
      daemon.pendingRequests.delete(requestId);
    }

    daemon.child.stdin.end();
    daemon.child.kill("SIGTERM");
  }

  private async handleProviderDaemonRequest(
    state: ProviderContainerState,
    message: DaemonEnvelope,
  ): Promise<void> {
    const id = typeof message.id === "string" ? message.id : null;
    if (!id) {
      return;
    }

    let response: DaemonEnvelope;
    try {
      const result = await this.executeProviderDaemonMethod(
        state,
        typeof message.method === "string" ? message.method : "",
        message.params,
      );
      response = {
        type: "response",
        id,
        result,
      };
    } catch (error) {
      response = {
        type: "response",
        id,
        error: {
          code: "RPC_ERROR",
          message: formatError(error),
        },
      };
    }

    const daemon = state.daemon;
    if (!daemon || daemon.child.stdin.destroyed) {
      return;
    }

    daemon.child.stdin.write(`${JSON.stringify(response)}\n`);
  }

  private handleProviderDaemonNotification(message: DaemonEnvelope): void {
    const method = typeof message.method === "string" ? message.method : "";
    const params =
      message.params && typeof message.params === "object"
        ? (message.params as Record<string, unknown>)
        : null;
    if (!params) {
      return;
    }

    if (method === "session.runtime_event") {
      const sessionName =
        typeof params.sessionName === "string" ? params.sessionName : "";
      for (const listener of this.activePromptListeners.get(sessionName) ?? []) {
        listener.onRuntimeEvent?.(params.event);
      }
      return;
    }

    if (method === "session.delta") {
      const sessionName =
        typeof params.sessionName === "string" ? params.sessionName : "";
      const delta = typeof params.delta === "string" ? params.delta : "";
      if (delta) {
        for (const listener of this.activePromptListeners.get(sessionName) ?? []) {
          listener.onDelta?.(delta);
        }
      }
    }
  }

  private addActivePromptListener(
    sessionName: string,
    listener: ActivePromptListener,
  ): void {
    const listeners = this.activePromptListeners.get(sessionName) ?? new Set();
    listeners.add(listener);
    this.activePromptListeners.set(sessionName, listeners);
  }

  private removeActivePromptListener(
    sessionName: string,
    listener: ActivePromptListener,
  ): void {
    const listeners = this.activePromptListeners.get(sessionName);
    if (!listeners) {
      return;
    }
    listeners.delete(listener);
    if (listeners.size === 0) {
      this.activePromptListeners.delete(sessionName);
    }
  }

  private async callProviderDaemon(
    state: ProviderContainerState,
    method: string,
    params: unknown,
    options: {
      timeoutMs?: number;
    } = {},
  ): Promise<unknown> {
    const daemon = state.daemon;
    if (!daemon || daemon.child.stdin.destroyed) {
      throw new Error("Container daemon is not ready.");
    }

    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    return await new Promise<unknown>((resolvePromise, rejectPromise) => {
      const timeoutMs =
        typeof options.timeoutMs === "number"
          ? options.timeoutMs
          : DEFAULT_DAEMON_REQUEST_TIMEOUT_MS;
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              daemon.pendingRequests.delete(requestId);
              rejectPromise(formatTimeoutError(`container daemon ${method}`, timeoutMs));
            }, timeoutMs)
          : null;
      daemon.pendingRequests.set(requestId, {
        resolve: resolvePromise,
        reject: rejectPromise,
        timer,
      });
      daemon.child.stdin.write(
        `${JSON.stringify({
          type: "request",
          id: requestId,
          method,
          params,
        })}\n`,
      );
    });
  }

  private async executeProviderDaemonMethod(
    state: ProviderContainerState,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    switch (method) {
      case "ping": {
        return {
          ok: true,
          containerName: state.containerName,
          now: new Date().toISOString(),
          pid: process.pid,
          params: params ?? null,
        };
      }
      case "fetch":
        return await this.executeProviderBridgeFetch(params);
      case "mcp.request":
        return await this.executeProviderBridgeMcpRequest(params);
      case "mcp.close":
        return await this.executeProviderBridgeMcpClose(params);
      case "mcp.list_servers":
        return this.hostMcpRegistry.listServers();
      default:
        throw new Error(`Unknown host RPC method: ${method || "<missing>"}.`);
    }
  }

  private async executeProviderBridgeMcpRequest(
    params: unknown,
  ): Promise<unknown> {
    if (!params || typeof params !== "object") {
      throw new Error("mcp.request params must be an object.");
    }

    const record = params as Record<string, unknown>;
    if (!record.message || typeof record.message !== "object") {
      throw new Error("mcp.request params.message must be an object.");
    }

    return await this.hostMcpRegistry.dispatchRequest({
      serverId:
        typeof record.serverId === "string" ? record.serverId : "",
      sessionId:
        typeof record.sessionId === "string" ? record.sessionId : "",
      message: record.message as HostMcpBridgeRequest["message"],
    });
  }

  private async executeProviderBridgeMcpClose(params: unknown): Promise<unknown> {
    if (!params || typeof params !== "object") {
      throw new Error("mcp.close params must be an object.");
    }

    const record = params as Record<string, unknown>;
    await this.hostMcpRegistry.closeSession(
      typeof record.serverId === "string" ? record.serverId : "",
      typeof record.sessionId === "string" ? record.sessionId : "",
    );
    return { ok: true };
  }

  private async executeProviderBridgeFetch(params: unknown): Promise<unknown> {
    if (!params || typeof params !== "object") {
      throw new Error("fetch params must be an object.");
    }

    const record = params as Record<string, unknown>;
    const url = typeof record.url === "string" ? record.url.trim() : "";
    if (!url) {
      throw new Error("fetch params.url must be a non-empty string.");
    }

    const method =
      typeof record.method === "string" && record.method.trim()
        ? record.method.trim().toUpperCase()
        : "GET";
    const timeoutMs =
      typeof record.timeoutMs === "number" && Number.isFinite(record.timeoutMs)
        ? Math.max(1, Math.trunc(record.timeoutMs))
        : DEFAULT_HOST_RPC_FETCH_TIMEOUT_MS;
    const maxBodyBytes =
      typeof record.maxBodyBytes === "number" && Number.isFinite(record.maxBodyBytes)
        ? Math.max(1, Math.trunc(record.maxBodyBytes))
        : DEFAULT_HOST_RPC_FETCH_MAX_BODY_BYTES;
    const body = typeof record.body === "string" ? record.body : undefined;
    const targetUrl = new URL(url);
    if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
      throw new Error(
        `fetch only supports http/https URLs. Received ${targetUrl.protocol || "<missing>"}.`,
      );
    }

    const headers: Record<string, string> = {};
    if (record.headers && typeof record.headers === "object") {
      for (const [key, value] of Object.entries(record.headers as Record<string, unknown>)) {
        if (typeof value === "string") {
          headers[key] = value;
        }
      }
    }
    if (body !== undefined && !Object.keys(headers).some((key) => key.toLowerCase() === "content-length")) {
      headers["content-length"] = Buffer.byteLength(body).toString();
    }

    const response = await new Promise<{
      ok: boolean;
      status: number;
      statusText: string;
      url: string;
      headers: Record<string, string>;
      body: string;
      truncated: boolean;
    }>((resolvePromise, rejectPromise) => {
      const requestFn = targetUrl.protocol === "https:" ? httpsRequest : httpRequest;
      let abortedForTruncation = false;
      const request = requestFn(
        targetUrl,
        {
          method,
          headers,
        },
        (incomingResponse) => {
          const chunks: Buffer[] = [];
          let totalBytes = 0;
          let truncated = false;
          let settled = false;

          const buildResponse = () => ({
            ok:
              typeof incomingResponse.statusCode === "number" &&
              incomingResponse.statusCode >= 200 &&
              incomingResponse.statusCode < 300,
            status: incomingResponse.statusCode ?? 0,
            statusText: incomingResponse.statusMessage ?? "",
            url: targetUrl.toString(),
            headers: Object.fromEntries(
              Object.entries(incomingResponse.headers).flatMap(([key, value]) => {
                if (Array.isArray(value)) {
                  return [[key, value.join(", ")]];
                }
                return typeof value === "string" ? [[key, value]] : [];
              }),
            ),
            body: Buffer.concat(chunks).toString("utf8"),
            truncated,
          });

          const finish = (error?: Error | null) => {
            if (settled) {
              return;
            }
            settled = true;
            if (error) {
              rejectPromise(error);
              return;
            }
            resolvePromise(buildResponse());
          };

          incomingResponse.on("data", (chunk: string | Buffer) => {
            const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (totalBytes >= maxBodyBytes) {
              truncated = true;
              abortedForTruncation = true;
              incomingResponse.destroy();
              request.destroy();
              finish(null);
              return;
            }

            if (totalBytes + chunkBuffer.length > maxBodyBytes) {
              const remainingBytes = maxBodyBytes - totalBytes;
              if (remainingBytes > 0) {
                chunks.push(chunkBuffer.subarray(0, remainingBytes));
                totalBytes += remainingBytes;
              }
              truncated = true;
              abortedForTruncation = true;
              incomingResponse.destroy();
              request.destroy();
              finish(null);
              return;
            }

            chunks.push(chunkBuffer);
            totalBytes += chunkBuffer.length;
          });

          incomingResponse.on("end", () => {
            finish(null);
          });

          incomingResponse.on("error", (error) => {
            if (truncated) {
              return;
            }
            finish(error instanceof Error ? error : new Error(String(error)));
          });
        },
      );

      request.setTimeout(timeoutMs, () => {
        request.destroy(new Error(`Host RPC request timed out after ${timeoutMs}ms.`));
      });
      request.on("error", (error) => {
        if (abortedForTruncation) {
          return;
        }
        rejectPromise(error instanceof Error ? error : new Error(String(error)));
      });
      if (body !== undefined) {
        request.write(body);
      }
      request.end();
    });

    return response;
  }

  private async ensurePromptSession(
    provider: DesktopProviderDefinition,
    threadId: string,
    model: string,
    sessionId?: string | null,
  ): Promise<void> {
    try {
      await this.ensurePromptSessionOnce(provider, threadId, model, sessionId);
    } catch (error) {
      if (!isRecoverableRuntimeError(error)) {
        throw error;
      }

      await this.restartProviderContainer(provider);
      await this.ensurePromptSessionOnce(provider, threadId, model, sessionId);
    }
  }

  async cancelPrompt({
    provider,
    threadId,
    model,
  }: CancelContainerPromptOptions): Promise<void> {
    await this.ensureRuntime(provider);
    await this.ensureContainerSystemStarted();
    const state = this.getSharedContainerState();
    const sessionName = `${provider.id}-${threadId}`;
    await this.callProviderDaemon(state, "session.cancel", {
      provider: provider.id,
      sessionName,
      model,
    }, {
      timeoutMs: parseTimeoutMs(
        process.env.DESKTOP_CONTAINER_EXEC_TIMEOUT_MS,
        30_000,
      ),
    });
  }

  private async ensurePromptSessionOnce(
    provider: DesktopProviderDefinition,
    threadId: string,
    model: string,
    sessionId?: string | null,
  ): Promise<void> {
    await this.ensureContainerSystemStarted();
    const state = this.getSharedContainerState();
    const sessionName = `${provider.id}-${threadId}`;
    const sessionKey = `${model}:${sessionId?.trim() || ""}`;
    if (state.ensuredSessions.get(sessionName) === sessionKey) {
      return;
    }

    await this.callProviderDaemon(state, "session.ensure", {
      provider: provider.id,
      sessionName,
      model,
      sessionId: sessionId ?? null,
    }, {
      timeoutMs: parseTimeoutMs(
        process.env.DESKTOP_CONTAINER_EXEC_TIMEOUT_MS,
        120_000,
      ),
    });

    state.ensuredSessions.set(sessionName, sessionKey);
  }

  private prepareClaudeSeed(runtimeDataDirectory: string): string | null {
    const hostCredentialsJson = getHostClaudeCredentialsJson();
    if (!existsSync(HOST_CLAUDE_JSON_PATH) && !hostCredentialsJson) {
      return null;
    }

    const seedDirectory = getClaudeJsonSeedDirectory(runtimeDataDirectory);
    mkdirSync(seedDirectory, { recursive: true });
    if (existsSync(HOST_CLAUDE_JSON_PATH)) {
      cpSync(HOST_CLAUDE_JSON_PATH, resolve(seedDirectory, ".claude.json"), {
        force: true,
      });
    }
    if (hostCredentialsJson) {
      writeFileSync(
        resolve(seedDirectory, ".credentials.json"),
        hostCredentialsJson,
        "utf8",
      );
    } else {
      rmSync(resolve(seedDirectory, ".credentials.json"), { force: true });
    }
    return seedDirectory;
  }

  async streamPrompt({
    provider,
    threadId,
    content,
    model,
    sessionId,
    onSessionId,
    onDelta,
    onRuntimeEvent,
  }: StreamContainerPromptOptions): Promise<StreamContainerPromptResult> {
    await this.ensureRuntime(provider);
    await this.ensurePromptSession(provider, threadId, model, sessionId);

    try {
      return await this.streamPromptOnce({
        provider,
        threadId,
        content,
        model,
        sessionId,
        onSessionId,
        onDelta,
        onRuntimeEvent,
      });
    } catch (error) {
      if (!isRecoverableRuntimeError(error)) {
        throw error;
      }

      await this.restartProviderContainer(provider);
      await this.ensurePromptSessionOnce(provider, threadId, model, sessionId);
      return this.streamPromptOnce({
        provider,
        threadId,
        content,
        model,
        sessionId,
        onSessionId,
        onDelta,
        onRuntimeEvent,
      });
    }
  }

  private async streamPromptOnce({
    provider,
    threadId,
    content,
    model,
    sessionId,
    onSessionId,
    onDelta,
    onRuntimeEvent,
  }: StreamContainerPromptOptions): Promise<StreamContainerPromptResult> {
    await this.ensureContainerSystemStarted();
    mkdirSync(this.getThreadStateDirectory(threadId), { recursive: true });
    const state = this.getSharedContainerState();
    const sessionName = `${provider.id}-${threadId}`;
    const promptListener =
      onDelta || onRuntimeEvent
        ? {
            onDelta,
            onRuntimeEvent,
          }
        : null;
    if (promptListener) {
      this.addActivePromptListener(sessionName, promptListener);
    }

    try {
      const result = await this.callProviderDaemon(state, "session.prompt", {
        provider: provider.id,
        sessionName,
        content,
        model,
        sessionId: sessionId ?? null,
      }, {
        timeoutMs: 0,
      }) as {
        sessionId?: string;
        finalText?: string;
        stopReason?: string | null;
      };

      const resolvedSessionId =
        typeof result?.sessionId === "string" && result.sessionId.trim()
          ? result.sessionId.trim()
          : typeof sessionId === "string" && sessionId.trim()
            ? sessionId.trim()
          : `${provider.id}-${threadId}-${Date.now()}`;
      onSessionId?.(resolvedSessionId);
      return {
        finalText: typeof result?.finalText === "string" ? result.finalText : "",
        model,
        sessionId: resolvedSessionId,
        stopReason:
          typeof result?.stopReason === "string" ? result.stopReason : null,
      };
    } finally {
      if (promptListener) {
        this.removeActivePromptListener(sessionName, promptListener);
      }
    }
  }
}
