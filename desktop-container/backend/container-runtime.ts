import { createHash } from "node:crypto";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { DesktopRuntimeStatus } from "../../desktop/shared/protocol";
import { logDesktop } from "../../desktop/backend/log";
import type { DesktopProviderDefinition } from "./provider-types";

const DEFAULT_RUNTIME_DIRECTORY = resolve(process.cwd(), "desktop-container/.local/runtime");
const DEFAULT_WORKSPACE_DIRECTORY = resolve(process.cwd());
const DEFAULT_CONTAINER_IMAGE_ROOT = resolve(
  process.cwd(),
  "desktop-container/container-images",
);
const CONTAINER_HOST_RPC_SOCKET_PATH = "/data/host-rpc/bridge.sock";
const DEFAULT_HOST_RPC_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_HOST_RPC_FETCH_MAX_BODY_BYTES = 256 * 1024;
const HOST_CODEX_HOME = process.env.CODEX_HOME?.trim()
  ? resolve(process.env.CODEX_HOME)
  : resolve(homedir(), ".codex");
const HOST_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR?.trim()
  ? resolve(process.env.CLAUDE_CONFIG_DIR)
  : resolve(homedir(), ".claude");
const HOST_CLAUDE_JSON_PATH = resolve(homedir(), ".claude.json");

export interface RuntimeManager {
  getWorkspaceDirectory(): string;
  getRuntimeDirectory(): string;
  getThreadStateDirectory(threadId: string): string;
  getCachedStatus(): DesktopRuntimeStatus;
  dispose(): void;
  ensureRuntime(
    provider: DesktopProviderDefinition,
    onStatus?: (status: DesktopRuntimeStatus) => void,
  ): Promise<DesktopRuntimeStatus>;
  streamPrompt(options: StreamContainerPromptOptions): Promise<StreamContainerPromptResult>;
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
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function extractAcpChunkText(update: unknown): string {
  if (!update || typeof update !== "object") {
    return "";
  }

  const content = (update as { content?: unknown }).content;
  if (content && typeof content === "object") {
    const text = (content as { text?: unknown }).text;
    if (typeof text === "string") {
      return text;
    }
  }

  return "";
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

function getBuildContext(imageRoot: string): string {
  return imageRoot;
}

function getContainerfilePath(imageRoot: string): string {
  return resolve(imageRoot, "acpx-shared/Containerfile");
}

function getClaudeJsonSeedDirectory(runtimeDirectory: string): string {
  return resolve(runtimeDirectory, "seed", "claude-json");
}

function collectFilesRecursively(rootDirectory: string): string[] {
  if (!existsSync(rootDirectory)) {
    return [];
  }

  const entries = readdirSync(rootDirectory)
    .map((entry) => resolve(rootDirectory, entry))
    .sort((left, right) => left.localeCompare(right));
  const files: string[] = [];
  for (const entry of entries) {
    const stats = statSync(entry);
    if (stats.isDirectory()) {
      files.push(...collectFilesRecursively(entry));
      continue;
    }
    if (stats.isFile()) {
      files.push(entry);
    }
  }
  return files;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

interface ProviderContainerState {
  containerName: string;
  ensuredSessions: Map<string, string>;
  startupPromise: Promise<void> | null;
  bridge: ProviderBridgeState | null;
}

interface ProviderBridgeState {
  child: ChildProcessWithoutNullStreams;
  readyPromise: Promise<void>;
  stdoutBuffer: string;
  stderrBuffer: string;
}

interface CapturedCommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface HostRpcRequest {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  type?: unknown;
}

interface HostRpcResponse {
  type: "response";
  id: string;
  result?: unknown;
  error?: {
    code?: string;
    message: string;
  };
}

function isRecoverableContainerExecError(error: unknown): boolean {
  const message = formatError(error);
  return /failed to create process in container|xpc connection error|connection interrupted|container system start/i.test(
    message,
  );
}

export class ContainerRuntimeManager implements RuntimeManager {
  private lastRuntimeStatus: DesktopRuntimeStatus | null = null;
  private readonly runtimeDirectory =
    process.env.DESKTOP_RUNTIME_DIR || DEFAULT_RUNTIME_DIRECTORY;
  private readonly workspaceDirectory =
    process.env.DESKTOP_WORKSPACE_DIR?.trim() ||
    process.env.DESKTOP_CONTAINER_WORKSPACE_DIR?.trim() ||
    DEFAULT_WORKSPACE_DIRECTORY;
  private readonly containerCommand = resolveContainerCommand();
  private readonly containerImageRoot = resolveContainerImageRoot();
  private readonly checkedImages = new Set<string>();
  private sharedContainerState: ProviderContainerState | null = null;

  getWorkspaceDirectory(): string {
    return this.workspaceDirectory;
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

  private async ensureContainerSystemStarted(): Promise<void> {
    const result = await this.runCapturedCommand(["system", "start"]);
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() ||
          result.stdout.trim() ||
          "Failed to start Apple container system services.",
      );
    }
  }

  dispose(): void {
    if (this.sharedContainerState) {
      const state = this.sharedContainerState;
      this.stopProviderBridge(state);
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
      await this.ensureProviderContainer(provider, onStatus);

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

    const imageSignature = this.computeImageBuildSignature(provider);
    const imageStampPath = this.getImageBuildStampPath(imageName);
    const storedImageSignature = existsSync(imageStampPath)
      ? readFileSync(imageStampPath, "utf8").trim()
      : null;

    const inspect = await this.runCapturedCommand(
      ["image", "inspect", imageName],
    );
    if (inspect.code === 0 && storedImageSignature === imageSignature) {
      this.checkedImages.add(imageName);
      return;
    }

    const buildingStatus: DesktopRuntimeStatus = {
      state: "starting",
      detail: `Building the ${provider.label} Apple container image.`,
      helperPath: this.containerCommand,
      runtimeDirectory: this.runtimeDirectory,
      imageReference: imageName,
    };
    this.lastRuntimeStatus = buildingStatus;
    onStatus?.(buildingStatus);

    const buildContext = getBuildContext(this.containerImageRoot);
    const buildArgs = [
      "build",
      "--progress",
      "plain",
      "--file",
      getContainerfilePath(this.containerImageRoot),
      "--tag",
      imageName,
      buildContext,
    ];

    if (process.env.DESKTOP_CODEX_IMAGE_VERSION?.trim()) {
      buildArgs.splice(4, 0, "--build-arg", `CODEX_VERSION=${process.env.DESKTOP_CODEX_IMAGE_VERSION.trim()}`);
    }
    if (process.env.DESKTOP_CLAUDE_IMAGE_VERSION?.trim()) {
      buildArgs.splice(4, 0, "--build-arg", `CLAUDE_VERSION=${process.env.DESKTOP_CLAUDE_IMAGE_VERSION.trim()}`);
    }
    if (process.env.DESKTOP_ACPX_IMAGE_VERSION?.trim()) {
      buildArgs.splice(4, 0, "--build-arg", `ACPX_VERSION=${process.env.DESKTOP_ACPX_IMAGE_VERSION.trim()}`);
    }

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn(this.containerCommand, buildArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        process.stderr.write(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
        process.stderr.write(chunk);
      });
      child.on("error", rejectPromise);
      child.on("exit", (code) => {
        if (code === 0) {
          resolvePromise();
          return;
        }
        rejectPromise(
          new Error(stderr.trim() || `Failed to build ${imageName}.`),
        );
      });
    });

    this.checkedImages.add(imageName);
    mkdirSync(resolve(this.runtimeDirectory, "image-stamps"), { recursive: true });
    writeFileSync(imageStampPath, imageSignature, "utf8");
  }

  private getImageBuildStampPath(imageName: string): string {
    const imageHash = createHash("sha1").update(imageName).digest("hex").slice(0, 12);
    return resolve(this.runtimeDirectory, "image-stamps", `${imageHash}.sha1`);
  }

  private computeImageBuildSignature(provider: DesktopProviderDefinition): string {
    const sharedImageDirectory = resolve(this.containerImageRoot, "acpx-shared");
    const bridgeDirectory = resolve(this.containerImageRoot, "bridge");
    const claudeEntrypointDirectory = resolve(this.containerImageRoot, "acpx-claude");
    const hash = createHash("sha1");

    hash.update(provider.getImageName());
    hash.update(process.env.DESKTOP_ACPX_IMAGE_VERSION?.trim() || "");
    hash.update(process.env.DESKTOP_CODEX_IMAGE_VERSION?.trim() || "");
    hash.update(process.env.DESKTOP_CLAUDE_IMAGE_VERSION?.trim() || "");

    for (const filePath of [
      ...collectFilesRecursively(sharedImageDirectory),
      ...collectFilesRecursively(bridgeDirectory),
      ...collectFilesRecursively(claudeEntrypointDirectory),
    ]) {
      hash.update(filePath);
      hash.update(readFileSync(filePath));
    }

    return hash.digest("hex");
  }

  private getSharedContainerState(): ProviderContainerState {
    if (this.sharedContainerState) {
      return this.sharedContainerState;
    }

    const hash = createHash("sha1")
      .update(`${this.runtimeDirectory}:${this.workspaceDirectory}:shared`)
      .digest("hex")
      .slice(0, 12);
    this.sharedContainerState = {
      containerName: `acon-acpx-${hash}`,
      ensuredSessions: new Map<string, string>(),
      startupPromise: null,
      bridge: null,
    };
    return this.sharedContainerState;
  }

  private async inspectContainerStatus(containerName: string): Promise<string | null> {
    const inspect = await this.runCapturedCommand(["inspect", containerName]);
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
    } = {},
  ): Promise<CapturedCommandResult> {
    return await new Promise<CapturedCommandResult>((resolvePromise, rejectPromise) => {
      const child = spawn(this.containerCommand, args, {
        cwd: options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", rejectPromise);
      child.on("exit", (code, signal) => {
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
    this.stopProviderBridge(state);
    await this.runCapturedCommand(["stop", state.containerName]);
    await this.ensureProviderContainer(provider);
  }

  private buildProviderHomeEnv(
    provider: DesktopProviderDefinition,
  ): Record<string, string> {
    const providerDataRoot = `/data/providers/${provider.id}`;
    const providerHome = `${providerDataRoot}/home`;
    const env: Record<string, string> = {
      DESKTOP_DATA_ROOT: providerDataRoot,
      HOME: providerHome,
      ACON_HOST_RPC_SOCKET: CONTAINER_HOST_RPC_SOCKET_PATH,
    };

    if (provider.id === "codex") {
      return {
        ...env,
        CODEX_HOME: `${providerHome}/.codex`,
      };
    }

    return {
      ...env,
      CLAUDE_CONFIG_DIR: `${providerHome}/.claude`,
    };
  }

  private buildExecArgs(
    provider: DesktopProviderDefinition,
    model: string,
    containerName: string,
    command: string[],
    interactive = false,
  ): string[] {
    const args = ["exec"];
    if (interactive) {
      args.push("--interactive");
    }

    args.push("--workdir", "/workspace");
    for (const [key, value] of Object.entries({
      ...this.buildProviderHomeEnv(provider),
      ...provider.buildRuntimeEnv(model),
    })) {
      if (value.trim()) {
        args.push("--env", `${key}=${value}`);
      }
    }

    const setupScript =
      provider.id === "codex"
        ? [
            'mkdir -p "$HOME" "$CODEX_HOME"',
            'if [ -f /seed-codex/auth.json ] && [ ! -f "$CODEX_HOME/auth.json" ]; then cp /seed-codex/auth.json "$CODEX_HOME/auth.json"; fi',
          ].join("; ")
        : [
            'mkdir -p "$HOME" "$CLAUDE_CONFIG_DIR"',
            'if [ -f /seed-claude/.credentials.json ] && [ ! -f "$CLAUDE_CONFIG_DIR/.credentials.json" ]; then cp /seed-claude/.credentials.json "$CLAUDE_CONFIG_DIR/.credentials.json"; fi',
            'if [ -f /seed-claude-json/.claude.json ] && [ ! -f "$HOME/.claude.json" ]; then cp /seed-claude-json/.claude.json "$HOME/.claude.json"; fi',
          ].join("; ");
    const execScript = `${setupScript}; exec ${command.map(shellEscape).join(" ")}`;

    args.push(containerName, "sh", "-lc", execScript);
    return args;
  }

  private async ensureProviderContainer(
    provider: DesktopProviderDefinition,
    onStatus?: (status: DesktopRuntimeStatus) => void,
  ): Promise<void> {
    await this.ensureContainerSystemStarted();
    const state = this.getSharedContainerState();
    if ((await this.inspectContainerStatus(state.containerName)) === "running") {
      await this.ensureProviderBridge(provider, state);
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
      const providersDataDirectory = resolve(this.runtimeDirectory, "providers");
      mkdirSync(providersDataDirectory, { recursive: true });
      logDesktop("desktop-runtime", "shared_container:start_requested", {
        provider: provider.id,
        containerName: state.containerName,
        workspaceDirectory: this.workspaceDirectory,
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

      const args = [
        "run",
        "--detach",
        "--rm",
        "--name",
        state.containerName,
        "--workdir",
        "/workspace",
        "--volume",
        `${providersDataDirectory}:/data/providers`,
        "--volume",
        `${this.workspaceDirectory}:/workspace`,
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

      args.push(
        provider.getImageName(),
        "sh",
        "-lc",
        "while true; do sleep 3600; done",
      );

      const start = await this.runCapturedCommand(args);
      if (start.code !== 0) {
        throw new Error(
          start.stderr?.trim() ||
            start.stdout?.trim() ||
            `Failed to start container ${state.containerName}.`,
        );
      }

      const runningStatus = await this.inspectContainerStatus(state.containerName);
      if (runningStatus !== "running") {
        throw new Error(
          `Container ${state.containerName} failed to reach running state.`,
        );
      }

      await this.ensureProviderBridge(provider, state);
      logDesktop("desktop-runtime", "shared_container:started", {
        provider: provider.id,
        containerName: state.containerName,
        workspaceDirectory: this.workspaceDirectory,
        providersDataDirectory,
        imageName: provider.getImageName(),
        status: runningStatus,
      });
    })();

    try {
      await state.startupPromise;
    } finally {
      state.startupPromise = null;
    }
  }

  private stopProviderBridge(state: ProviderContainerState): void {
    const bridge = state.bridge;
    state.bridge = null;
    if (!bridge) {
      return;
    }

    bridge.child.stdin.end();
    bridge.child.kill("SIGTERM");
  }

  private async ensureProviderBridge(
    provider: DesktopProviderDefinition,
    state = this.getSharedContainerState(),
  ): Promise<void> {
    if (state.bridge) {
      await state.bridge.readyPromise;
      return;
    }

    const args = this.buildExecArgs(
      provider,
      provider.getDefaultModel(),
      state.containerName,
      ["node", "/usr/local/lib/acon/acon-host-bridge.mjs"],
      true,
    );

    const child = spawn(this.containerCommand, args, {
      cwd: this.workspaceDirectory,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    const bridge: ProviderBridgeState = {
      child,
      readyPromise: Promise.resolve(),
      stdoutBuffer: "",
      stderrBuffer: "",
    };

    const readyPromise = new Promise<void>((resolvePromise, rejectPromise) => {
      let ready = false;
      const fail = (error: unknown) => {
        if (ready) {
          logDesktop(
            "desktop-runtime",
            "provider_bridge:runtime_error",
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
        rejectPromise(error instanceof Error ? error : new Error(formatError(error)));
      };

      child.on("error", fail);
      child.on("exit", (code, signal) => {
        state.bridge = null;
        const detail = `Bridge process exited (code=${code}, signal=${signal}).`;
        fail(
          new Error(
            bridge.stderrBuffer.trim()
              ? `${detail} ${bridge.stderrBuffer.trim()}`
              : detail,
          ),
        );
      });

      child.stdout.on("data", (chunk: string) => {
        if (state.bridge !== bridge) {
          return;
        }

        bridge.stdoutBuffer += chunk;
        while (true) {
          const newlineIndex = bridge.stdoutBuffer.indexOf("\n");
          if (newlineIndex === -1) {
            break;
          }

          const line = bridge.stdoutBuffer.slice(0, newlineIndex).trim();
          bridge.stdoutBuffer = bridge.stdoutBuffer.slice(newlineIndex + 1);
          if (!line) {
            continue;
          }

          let message: HostRpcRequest;
          try {
            message = JSON.parse(line) as HostRpcRequest;
          } catch {
            fail(new Error(`Bridge returned invalid JSON: ${line}`));
            continue;
          }

          if (message.type === "ready") {
            if (!ready) {
              ready = true;
              resolvePromise();
            }
            continue;
          }

          if (message.type !== "request") {
            logDesktop(
              "desktop-runtime",
              "provider_bridge:unexpected_message",
              {
                provider: provider.id,
                containerName: state.containerName,
                message,
              },
              "warn",
            );
            continue;
          }

          void this.handleProviderBridgeRequest(provider, state, message);
        }
      });

      child.stderr.on("data", (chunk: string) => {
        if (state.bridge !== bridge) {
          return;
        }

        bridge.stderrBuffer += chunk;
        logDesktop(
          "desktop-runtime",
          "provider_bridge:stderr",
          {
            provider: provider.id,
            containerName: state.containerName,
            chunk: chunk.trim(),
          },
          "debug",
        );
      });
    });

    bridge.readyPromise = readyPromise;
    state.bridge = bridge;

    try {
      await readyPromise;
    } catch (error) {
      this.stopProviderBridge(state);
      throw error;
    }
  }

  private async handleProviderBridgeRequest(
    provider: DesktopProviderDefinition,
    state: ProviderContainerState,
    message: HostRpcRequest,
  ): Promise<void> {
    const id = typeof message.id === "string" ? message.id : null;
    if (!id) {
      logDesktop(
        "desktop-runtime",
        "provider_bridge:request_missing_id",
        {
          provider: provider.id,
          containerName: state.containerName,
          message,
        },
        "warn",
      );
      return;
    }

    let response: HostRpcResponse;
    try {
      const result = await this.executeProviderBridgeMethod(
        provider,
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

    const bridge = state.bridge;
    if (!bridge || bridge.child.stdin.destroyed) {
      return;
    }

    bridge.child.stdin.write(`${JSON.stringify(response)}\n`);
  }

  private async executeProviderBridgeMethod(
    provider: DesktopProviderDefinition,
    state: ProviderContainerState,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    switch (method) {
      case "ping":
        return {
          ok: true,
          provider: provider.id,
          containerName: state.containerName,
          now: new Date().toISOString(),
          pid: process.pid,
          params: params ?? null,
        };
      case "fetch":
        return await this.executeProviderBridgeFetch(params);
      default:
        throw new Error(`Unknown host RPC method: ${method || "<missing>"}.`);
    }
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

          incomingResponse.on("data", (chunk: string | Buffer) => {
            const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (totalBytes >= maxBodyBytes) {
              truncated = true;
              return;
            }

            if (totalBytes + chunkBuffer.length > maxBodyBytes) {
              const remainingBytes = maxBodyBytes - totalBytes;
              if (remainingBytes > 0) {
                chunks.push(chunkBuffer.subarray(0, remainingBytes));
                totalBytes += remainingBytes;
              }
              truncated = true;
              return;
            }

            chunks.push(chunkBuffer);
            totalBytes += chunkBuffer.length;
          });

          incomingResponse.on("end", () => {
            resolvePromise({
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
          });

          incomingResponse.on("error", rejectPromise);
        },
      );

      request.setTimeout(timeoutMs, () => {
        request.destroy(new Error(`Host RPC request timed out after ${timeoutMs}ms.`));
      });
      request.on("error", rejectPromise);
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
  ): Promise<void> {
    try {
      await this.ensurePromptSessionOnce(provider, threadId, model);
    } catch (error) {
      if (!isRecoverableContainerExecError(error)) {
        throw error;
      }

      await this.restartProviderContainer(provider);
      await this.ensurePromptSessionOnce(provider, threadId, model);
    }
  }

  private async ensurePromptSessionOnce(
    provider: DesktopProviderDefinition,
    threadId: string,
    model: string,
  ): Promise<void> {
    await this.ensureContainerSystemStarted();
    const state = this.getSharedContainerState();
    const sessionName = `${provider.id}-${threadId}`;
    if (state.ensuredSessions.get(sessionName) === model) {
      return;
    }

    const args = this.buildExecArgs(
      provider,
      model,
      state.containerName,
      [
        "acpx",
        "--json-strict",
        "--format",
        "json",
        "--approve-all",
        "--cwd",
        "/workspace",
        provider.id,
        "sessions",
        "ensure",
        "--name",
        sessionName,
      ],
    );

    const ensureResult = await this.runCapturedCommand(args, {
      cwd: this.workspaceDirectory,
    });
    if (ensureResult.code !== 0) {
      throw new Error(
        ensureResult.stderr?.trim() ||
          ensureResult.stdout?.trim() ||
          `Failed to ensure ACPX session ${sessionName}.`,
      );
    }

    const jsonLines = ensureResult.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const finalLine = jsonLines.at(-1);
    if (!finalLine) {
      throw new Error(`ACPX session ensure for ${sessionName} returned no output.`);
    }

    let message: any;
    try {
      message = JSON.parse(finalLine);
    } catch {
      throw new Error(`ACPX session ensure returned non-JSON output: ${finalLine}`);
    }

    if (message.error) {
      throw new Error(
        typeof message.error?.message === "string"
          ? message.error.message
          : JSON.stringify(message.error),
      );
    }

    const setModelArgs = this.buildExecArgs(
      provider,
      model,
      state.containerName,
      [
        "acpx",
        "--json-strict",
        "--format",
        "json",
        "--approve-all",
        "--cwd",
        "/workspace",
        provider.id,
        "set",
        "--session",
        sessionName,
        "model",
        model,
      ],
    );

    const setModelResult = await this.runCapturedCommand(setModelArgs, {
      cwd: this.workspaceDirectory,
    });
    if (setModelResult.code !== 0) {
      throw new Error(
        setModelResult.stderr?.trim() ||
          setModelResult.stdout?.trim() ||
          `Failed to set ACPX session model ${model} for ${sessionName}.`,
      );
    }

    state.ensuredSessions.set(sessionName, model);
  }

  private prepareClaudeSeed(runtimeDataDirectory: string): string | null {
    if (!existsSync(HOST_CLAUDE_JSON_PATH)) {
      return null;
    }

    const seedDirectory = getClaudeJsonSeedDirectory(runtimeDataDirectory);
    mkdirSync(seedDirectory, { recursive: true });
    cpSync(HOST_CLAUDE_JSON_PATH, resolve(seedDirectory, ".claude.json"), {
      force: true,
    });
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
    await this.ensurePromptSession(provider, threadId, model);

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
      if (!isRecoverableContainerExecError(error)) {
        throw error;
      }

      await this.restartProviderContainer(provider);
      await this.ensurePromptSessionOnce(provider, threadId, model);
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
    const args = this.buildExecArgs(
      provider,
      model,
      state.containerName,
      [
        "acpx",
        "--json-strict",
        "--format",
        "json",
        "--approve-all",
        "--model",
        model,
        "--ttl",
        "0",
        "--cwd",
        "/workspace",
        provider.id,
        "prompt",
        "--session",
        sessionName,
        "--file",
        "-",
      ],
      true,
    );

    const child = spawn(this.containerCommand, args, {
      cwd: this.workspaceDirectory,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    let stdoutBuffer = "";
    let accumulatedText = "";
    let resolvedSessionId = "";
    let stopReason: string | null = null;

    const resultPromise = new Promise<StreamContainerPromptResult>((resolvePromise, rejectPromise) => {
      let settled = false;

      const rejectOnce = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill("SIGTERM");
        rejectPromise(error instanceof Error ? error : new Error(formatError(error)));
      };

      const resolveOnce = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolvePromise({
          finalText: accumulatedText,
          model,
          sessionId: resolvedSessionId || `${provider.id}-${threadId}-${Date.now()}`,
        });
      };

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });

      child.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk.toString("utf8");
        while (true) {
          const newlineIndex = stdoutBuffer.indexOf("\n");
          if (newlineIndex === -1) {
            break;
          }

          const line = stdoutBuffer.slice(0, newlineIndex).trim();
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          if (!line) {
            continue;
          }

          let message: any;
          try {
            message = JSON.parse(line);
          } catch {
            rejectOnce(new Error(`Container returned non-JSON output: ${line}`));
            return;
          }

          if (message.error) {
            rejectOnce(
              new Error(
                typeof message.error?.message === "string"
                  ? message.error.message
                  : JSON.stringify(message.error),
              ),
            );
            return;
          }

          if (
            message.result &&
            typeof message.result.sessionId === "string" &&
            message.result.sessionId.length > 0
          ) {
            resolvedSessionId = message.result.sessionId;
            onSessionId?.(resolvedSessionId);
            continue;
          }

          if (message.method === "session/update") {
            const text = extractAcpChunkText(message.params?.update);
            if (text) {
              accumulatedText += text;
              onDelta?.(text);
            }
            onRuntimeEvent?.(message);
            continue;
          }

          if (message.result && typeof message.result.stopReason === "string") {
            stopReason = message.result.stopReason;
            resolveOnce();
            return;
          }
        }
      });

      child.on("error", rejectOnce);
      child.on("exit", (code, signal) => {
        if (settled) {
          return;
        }

        if (code === 0 && (accumulatedText || stopReason)) {
          resolveOnce();
          return;
        }

        logDesktop(
          "desktop-runtime",
          "container_exit",
          {
            provider: provider.id,
            threadId,
            containerName: state.containerName,
            code,
            signal,
            stderr,
          },
          "warn",
        );
        rejectOnce(
          new Error(
            stderr.trim() ||
              `Container exited before completion (code=${code}, signal=${signal}).`,
          ),
        );
      });
    });

    child.stdin.end(`${content}\n`);
    return resultPromise;
  }
}
