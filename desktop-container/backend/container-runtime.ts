import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
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

function sanitizeContainerNamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 48) || "thread";
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

function getBuildContext(
  imageRoot: string,
  provider: DesktopProviderDefinition,
): string {
  return resolve(imageRoot, provider.id === "claude" ? "acpx-claude" : "acpx-codex");
}

function getClaudeJsonSeedDirectory(runtimeDirectory: string): string {
  return resolve(runtimeDirectory, "seed", "claude-json");
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

interface ProviderContainerState {
  containerName: string;
  ensuredSessions: Map<string, string>;
  startupPromise: Promise<void> | null;
}

interface CapturedCommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
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
  private readonly providerContainers = new Map<string, ProviderContainerState>();

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
    for (const state of this.providerContainers.values()) {
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

    const inspect = await this.runCapturedCommand(
      ["image", "inspect", imageName],
    );
    if (inspect.code === 0) {
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

    const buildContext = getBuildContext(this.containerImageRoot, provider);
    const buildArgs = [
      "build",
      "--progress",
      "plain",
      "--file",
      resolve(buildContext, "Containerfile"),
      "--tag",
      imageName,
      buildContext,
    ];

    if (provider.id === "codex" && process.env.DESKTOP_CODEX_IMAGE_VERSION?.trim()) {
      buildArgs.splice(4, 0, "--build-arg", `CODEX_VERSION=${process.env.DESKTOP_CODEX_IMAGE_VERSION.trim()}`);
    }
    if (provider.id === "claude" && process.env.DESKTOP_CLAUDE_IMAGE_VERSION?.trim()) {
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
  }

  private getProviderDataDirectory(provider: DesktopProviderDefinition): string {
    return resolve(this.runtimeDirectory, "providers", provider.id);
  }

  private getProviderContainerState(
    provider: DesktopProviderDefinition,
  ): ProviderContainerState {
    const existing = this.providerContainers.get(provider.id);
    if (existing) {
      return existing;
    }

    const hash = createHash("sha1")
      .update(`${this.runtimeDirectory}:${this.workspaceDirectory}:${provider.id}`)
      .digest("hex")
      .slice(0, 12);
    const created: ProviderContainerState = {
      containerName: `acon-${provider.id}-${hash}`,
      ensuredSessions: new Map<string, string>(),
      startupPromise: null,
    };
    this.providerContainers.set(provider.id, created);
    return created;
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
    const state = this.getProviderContainerState(provider);
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
    await this.runCapturedCommand(["stop", state.containerName]);
    await this.ensureProviderContainer(provider);
  }

  private buildProviderHomeEnv(
    provider: DesktopProviderDefinition,
  ): Record<string, string> {
    const env: Record<string, string> = {
      DESKTOP_DATA_ROOT: "/data",
      HOME: "/data/home",
    };

    if (provider.id === "codex") {
      return {
        ...env,
        CODEX_HOME: "/data/home/.codex",
      };
    }

    return {
      ...env,
      CLAUDE_CONFIG_DIR: "/data/home/.claude",
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
    const state = this.getProviderContainerState(provider);
    if ((await this.inspectContainerStatus(state.containerName)) === "running") {
      return;
    }

    if (state.startupPromise) {
      await state.startupPromise;
      return;
    }

    state.startupPromise = (async () => {
      state.ensuredSessions.clear();
      const runtimeDataDirectory = this.getProviderDataDirectory(provider);
      mkdirSync(runtimeDataDirectory, { recursive: true });

      const startingStatus: DesktopRuntimeStatus = {
        state: "starting",
        detail: `Starting the ${provider.label} session container.`,
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
        `${runtimeDataDirectory}:/data`,
        "--volume",
        `${this.workspaceDirectory}:/workspace`,
      ];

      for (const [key, value] of Object.entries(this.buildProviderHomeEnv(provider))) {
        if (value.trim()) {
          args.push("--env", `${key}=${value}`);
        }
      }

      if (provider.id === "codex" && existsSync(HOST_CODEX_HOME)) {
        args.push(
          "--mount",
          `type=bind,source=${HOST_CODEX_HOME},target=/seed-codex,readonly`,
        );
      }

      if (provider.id === "claude") {
        if (existsSync(HOST_CLAUDE_CONFIG_DIR)) {
          args.push(
            "--mount",
            `type=bind,source=${HOST_CLAUDE_CONFIG_DIR},target=/seed-claude,readonly`,
          );
        }
        const seedDirectory = this.prepareClaudeSeed(runtimeDataDirectory);
        if (seedDirectory) {
          args.push(
            "--mount",
            `type=bind,source=${seedDirectory},target=/seed-claude-json,readonly`,
          );
        }
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
    })();

    try {
      await state.startupPromise;
    } finally {
      state.startupPromise = null;
    }
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
    const state = this.getProviderContainerState(provider);
    const sessionName = threadId;
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
    const state = this.getProviderContainerState(provider);
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
        threadId,
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
