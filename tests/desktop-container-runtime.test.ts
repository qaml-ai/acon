import { describe, expect, it } from "vitest";
import { ContainerRuntimeManager } from "../desktop-container/backend/container-runtime";
import { requireDesktopProvider } from "../desktop-container/backend/providers";

function getExecScript(providerId: "codex" | "claude"): string {
  const runtime = new ContainerRuntimeManager() as ContainerRuntimeManager & {
    buildExecArgs: (
      provider: ReturnType<typeof requireDesktopProvider>,
      model: string,
      containerName: string,
      command: string[],
      interactive?: boolean,
    ) => string[];
  };

  const args = runtime.buildExecArgs(
    requireDesktopProvider(providerId),
    providerId === "codex" ? "gpt-5.4" : "sonnet",
    "test-container",
    ["printf", "ok"],
  );

  return args.at(-1) ?? "";
}

describe("ContainerRuntimeManager", () => {
  it("seeds codex auth and writes built-in instructions into the provider home", () => {
    const script = getExecScript("codex");

    expect(script).toContain('mkdir -p "$HOME" "$CODEX_HOME"');
    expect(script).toContain(
      'if [ -f /seed-codex/auth.json ] && [ ! -f "$CODEX_HOME/auth.json" ]; then cp /seed-codex/auth.json "$CODEX_HOME/auth.json"; fi',
    );
    expect(script).toContain('rm -f "$CODEX_HOME/AGENTS.override.md"');
    expect(script).toContain(`cat > "$CODEX_HOME/AGENTS.md" <<'EOF'`);
    expect(script).toContain("the standalone camelAI desktop app");
    expect(script).toContain("Use the codename `acon` when referring to this app.");
    expect(script).toContain("A bash tool named `acon-mcp` is available in the container.");
    expect(script).toContain("Run `acon-mcp servers` to list available MCP servers.");
    expect(script).toContain(
      "Run `acon-mcp tools <server-id>` to list the tools exposed by a server.",
    );
    expect(script).toContain(
      "Run `acon-mcp <server-id>` to expose that server over stdio for MCP clients in the container.",
    );
    expect(script).toContain("MCP tools are external integrations.");
  });

  it("seeds claude auth and writes built-in instructions into the provider home", () => {
    const script = getExecScript("claude");

    expect(script).toContain('mkdir -p "$HOME" "$CLAUDE_CONFIG_DIR"');
    expect(script).toContain(
      'if [ -f /seed-claude/.credentials.json ] && [ ! -f "$CLAUDE_CONFIG_DIR/.credentials.json" ]; then cp /seed-claude/.credentials.json "$CLAUDE_CONFIG_DIR/.credentials.json"; fi',
    );
    expect(script).toContain(
      'if [ -f /seed-claude-json/.claude.json ] && [ ! -f "$HOME/.claude.json" ]; then cp /seed-claude-json/.claude.json "$HOME/.claude.json"; fi',
    );
    expect(script).toContain(`cat > "$CLAUDE_CONFIG_DIR/CLAUDE.md" <<'EOF'`);
    expect(script).toContain("the standalone camelAI desktop app");
    expect(script).toContain("Use the codename `acon` when referring to this app.");
    expect(script).toContain("A bash tool named `acon-mcp` is available in the container.");
    expect(script).toContain("Run `acon-mcp servers` to list available MCP servers.");
    expect(script).toContain(
      "Run `acon-mcp tools <server-id>` to list the tools exposed by a server.",
    );
    expect(script).toContain(
      "Run `acon-mcp <server-id>` to expose that server over stdio for MCP clients in the container.",
    );
    expect(script).toContain("MCP tools are external integrations.");
  });

  it("restarts the provider container after a recoverable bridge startup failure", async () => {
    const provider = requireDesktopProvider("codex");
    const runtime = new ContainerRuntimeManager() as ContainerRuntimeManager & {
      runCapturedCommand: () => Promise<{ code: number; stdout: string; stderr: string }>;
      ensureContainerSystemStarted: () => Promise<void>;
      ensureImage: () => Promise<void>;
      ensureProviderContainer: () => Promise<void>;
      restartProviderContainer: () => Promise<void>;
    };

    let ensureProviderContainerCalls = 0;
    let restartProviderContainerCalls = 0;

    runtime.runCapturedCommand = async () => ({
      code: 0,
      stdout: "container version 1.0.0",
      stderr: "",
    });
    runtime.ensureContainerSystemStarted = async () => {};
    runtime.ensureImage = async () => {};
    runtime.ensureProviderContainer = async () => {
      ensureProviderContainerCalls += 1;
      throw new Error(
        'Bridge process exited (code=1, signal=null). Error: internalError: "failed to create process in container" (cause: "invalidState: "cannot exec: container is not running"")',
      );
    };
    runtime.restartProviderContainer = async () => {
      restartProviderContainerCalls += 1;
    };

    const status = await runtime.ensureRuntime(provider);

    expect(status.state).toBe("running");
    expect(ensureProviderContainerCalls).toBe(1);
    expect(restartProviderContainerCalls).toBe(1);
  });

  it("deletes a stale non-running shared container before starting a new one", async () => {
    const provider = requireDesktopProvider("codex");
    const runtime = new ContainerRuntimeManager() as ContainerRuntimeManager & {
      ensureContainerSystemStarted: () => Promise<void>;
      inspectContainerStatus: () => Promise<string | null>;
      runCapturedCommand: (
        args: string[],
      ) => Promise<{ code: number; stdout: string; stderr: string }>;
      ensureProviderBridge: () => Promise<void>;
    };

    const commands: string[][] = [];
    let inspectCalls = 0;

    runtime.ensureContainerSystemStarted = async () => {};
    runtime.inspectContainerStatus = async () => {
      inspectCalls += 1;
      return inspectCalls === 1 ? "stopped" : "running";
    };
    runtime.runCapturedCommand = async (args: string[]) => {
      commands.push(args);
      return { code: 0, stdout: "", stderr: "" };
    };
    runtime.ensureProviderBridge = async () => {};

    await runtime.ensureProviderContainer(provider);

    expect(commands[0]).toEqual([
      "delete",
      "--force",
      expect.stringMatching(/^acon-acpx-/),
    ]);
    expect(commands[1]?.[0]).toBe("run");
    expect(commands[1]).toContain("--name");
  });

  it("rotates to a new shared container name when stale delete fails", async () => {
    const provider = requireDesktopProvider("codex");
    const runtime = new ContainerRuntimeManager() as ContainerRuntimeManager & {
      ensureContainerSystemStarted: () => Promise<void>;
      inspectContainerStatus: () => Promise<string | null>;
      runCapturedCommand: (
        args: string[],
      ) => Promise<{ code: number; stdout: string; stderr: string }>;
      ensureProviderBridge: () => Promise<void>;
      deleteProviderContainer: () => Promise<void>;
      rotateSharedContainerName: (
        state: {
          baseContainerName: string;
          containerName: string;
        },
      ) => string;
    };

    const commands: string[][] = [];
    let inspectCalls = 0;

    runtime.ensureContainerSystemStarted = async () => {};
    runtime.inspectContainerStatus = async () => {
      inspectCalls += 1;
      return inspectCalls === 1 ? "stopped" : "running";
    };
    runtime.runCapturedCommand = async (args: string[]) => {
      commands.push(args);
      return { code: 0, stdout: "", stderr: "" };
    };
    runtime.ensureProviderBridge = async () => {};
    runtime.deleteProviderContainer = async () => {
      throw new Error("missing config.json");
    };
    runtime.rotateSharedContainerName = (state) => {
      state.containerName = `${state.baseContainerName}-newboot`;
      return state.containerName;
    };

    await runtime.ensureProviderContainer(provider);

    expect(commands).toHaveLength(1);
    expect(commands[0]?.[0]).toBe("run");
    const nameIndex = commands[0]?.indexOf("--name") ?? -1;
    expect(nameIndex).toBeGreaterThanOrEqual(0);
    expect(commands[0]?.[nameIndex + 1]).toMatch(/^acon-acpx-.*-newboot$/);
  });
});
