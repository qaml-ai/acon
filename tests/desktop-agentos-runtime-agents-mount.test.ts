// @vitest-environment node

import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentOs } from "@rivet-dev/agent-os-core";

function createActivationContext(runtimeDirectory: string, workspaceDirectory: string) {
  return {
    provider: "agentos" as const,
    harness: "pi" as const,
    model: "claude-sonnet-4-20250514",
    activeThreadId: "thread-1",
    runtimeStatus: {
      state: "running" as const,
      detail: "Runtime ready",
      helperPath: null,
      runtimeDirectory,
    },
    runtimeDirectory,
    workspaceDirectory,
    threadStateDirectory: resolve(runtimeDirectory, "camelai-state", "thread-1"),
  };
}

function writePlugin(options: {
  rootDirectory: string;
  pluginId: string;
  skillName: string;
  description?: string;
}) {
  const pluginDirectory = resolve(options.rootDirectory, options.pluginId);
  mkdirSync(pluginDirectory, { recursive: true });
  writeFileSync(
    resolve(pluginDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: `@test/${options.pluginId}`,
        version: "0.0.1",
        camelai: {
          id: options.pluginId,
          name: options.pluginId,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(
    resolve(pluginDirectory, "index.ts"),
    "export default {};\n",
    "utf8",
  );

  const skillDirectory = resolve(
    pluginDirectory,
    ".agents",
    "skills",
    options.skillName,
  );
  mkdirSync(skillDirectory, { recursive: true });
  writeFileSync(
    resolve(skillDirectory, "SKILL.md"),
    [
      "---",
      `name: ${options.skillName}`,
      `description: ${options.description ?? `${options.skillName} test skill`}`,
      "---",
      "",
      `# ${options.skillName}`,
      "",
      "Test skill body.",
      "",
    ].join("\n"),
    "utf8",
  );
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

function getRuntimeVm(runtimeManager: unknown): AgentOs {
  const vm = (runtimeManager as { vm: AgentOs | null }).vm;
  if (!vm) {
    throw new Error("Expected AgentOS runtime VM to be available.");
  }
  return vm;
}

function parsePiRpcCommands(stdout: string): Array<{
  name?: string;
  path?: string;
  source?: string;
}> {
  return stdout
    .trim()
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      const parsed = JSON.parse(line) as {
        type?: string;
        command?: string;
        success?: boolean;
        data?: {
          commands?: Array<{
            name?: string;
            path?: string;
            source?: string;
          }>;
        };
      };
      if (
        parsed.type === "response" &&
        parsed.command === "get_commands" &&
        parsed.success === true
      ) {
        return parsed.data?.commands ?? [];
      }
      return [];
    });
}

describe("AgentOS synthesized .agents mount", () => {
  const originalDesktopDataDir = process.env.DESKTOP_DATA_DIR;
  const originalRuntimeDir = process.env.DESKTOP_RUNTIME_DIR;
  const originalWorkspaceDir = process.env.DESKTOP_AGENTOS_WORKSPACE_DIR;
  const testRoot = mkdtempSync(join(tmpdir(), "desktop-agentos-agents-mount-"));
  const runtimeDirectory = resolve(testRoot, "runtime");
  const workspaceDirectory = resolve(testRoot, "workspace");
  const dataDirectory = resolve(testRoot, "data");
  const pluginDirectory = resolve(dataDirectory, "plugins");

  afterEach(() => {
    restoreEnv("DESKTOP_DATA_DIR", originalDesktopDataDir);
    restoreEnv("DESKTOP_RUNTIME_DIR", originalRuntimeDir);
    restoreEnv("DESKTOP_AGENTOS_WORKSPACE_DIR", originalWorkspaceDir);
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("materializes plugin-provided .agents skills into the runtime directory on refresh", async () => {
    mkdirSync(runtimeDirectory, { recursive: true });
    mkdirSync(workspaceDirectory, { recursive: true });
    mkdirSync(pluginDirectory, { recursive: true });

    process.env.DESKTOP_DATA_DIR = dataDirectory;
    process.env.DESKTOP_RUNTIME_DIR = runtimeDirectory;
    process.env.DESKTOP_AGENTOS_WORKSPACE_DIR = workspaceDirectory;

    const { CamelAIExtensionHost } = await import(
      "../desktop-agentos/backend/extensions/host"
    );
    const { AgentOsRuntimeManager } = await import(
      "../desktop-agentos/backend/runtime"
    );

    writePlugin({
      rootDirectory: pluginDirectory,
      pluginId: "user-skill-pack",
      skillName: "first-skill",
    });

    const host = new CamelAIExtensionHost();
    const context = createActivationContext(runtimeDirectory, workspaceDirectory);
    await host.initialize(context);

    const runtimeManager = new AgentOsRuntimeManager();
    runtimeManager.syncAgentsDirectory(
      host.getSnapshot(context).plugins.map((plugin) => ({
        id: plugin.id,
        path: plugin.path,
      })),
    );

    const firstSkillPath = resolve(
      runtimeDirectory,
      "agents-home",
      ".agents",
      "skills",
      "user-skill-pack",
      "first-skill",
      "SKILL.md",
    );
    expect(existsSync(firstSkillPath)).toBe(true);
    expect(readFileSync(firstSkillPath, "utf8")).toContain("name: first-skill");

    rmSync(resolve(pluginDirectory, "user-skill-pack"), {
      recursive: true,
      force: true,
    });
    writePlugin({
      rootDirectory: pluginDirectory,
      pluginId: "replacement-skill-pack",
      skillName: "second-skill",
    });

    await host.refresh(context);
    runtimeManager.syncAgentsDirectory(
      host.getSnapshot(context).plugins.map((plugin) => ({
        id: plugin.id,
        path: plugin.path,
      })),
    );

    expect(existsSync(firstSkillPath)).toBe(false);

    const secondSkillPath = resolve(
      runtimeDirectory,
      "agents-home",
      ".agents",
      "skills",
      "replacement-skill-pack",
      "second-skill",
      "SKILL.md",
    );
    expect(existsSync(secondSkillPath)).toBe(true);
    expect(readFileSync(secondSkillPath, "utf8")).toContain("name: second-skill");
  });

  it("exposes plugin-provided .agents skills to Pi inside the VM", async () => {
    mkdirSync(runtimeDirectory, { recursive: true });
    mkdirSync(workspaceDirectory, { recursive: true });
    mkdirSync(pluginDirectory, { recursive: true });

    process.env.DESKTOP_DATA_DIR = dataDirectory;
    process.env.DESKTOP_RUNTIME_DIR = runtimeDirectory;
    process.env.DESKTOP_AGENTOS_WORKSPACE_DIR = workspaceDirectory;

    const { CamelAIExtensionHost } = await import(
      "../desktop-agentos/backend/extensions/host"
    );
    const { AgentOsRuntimeManager } = await import(
      "../desktop-agentos/backend/runtime"
    );

    writePlugin({
      rootDirectory: pluginDirectory,
      pluginId: "user-skill-pack",
      skillName: "first-skill",
    });

    const host = new CamelAIExtensionHost();
    const context = createActivationContext(runtimeDirectory, workspaceDirectory);
    await host.initialize(context);

    const runtimeManager = new AgentOsRuntimeManager();
    runtimeManager.syncAgentsDirectory(
      host.getSnapshot(context).plugins.map((plugin) => ({
        id: plugin.id,
        path: plugin.path,
      })),
    );

    try {
      await runtimeManager.ensureRuntime();

      const vm = getRuntimeVm(runtimeManager);
      const vmSkillPath =
        "/home/user/.agents/skills/user-skill-pack/first-skill/SKILL.md";
      const stdoutDecoder = new TextDecoder();
      const stderrDecoder = new TextDecoder();
      let stdout = "";
      let stderr = "";

      expect(await vm.exists(vmSkillPath)).toBe(true);

      const { pid } = vm.spawn(
        "pi",
        [
          "--mode",
          "rpc",
          "--model",
          "openai/gpt-4o-mini",
          "--no-session",
          "--offline",
        ],
        {
          cwd: "/workspace",
          env: {
            HOME: "/home/user",
            OPENAI_API_KEY: "test",
          },
          streamStdin: true,
        },
      );
      const unsubscribeStdout = vm.onProcessStdout(pid, (chunk) => {
        stdout += stdoutDecoder.decode(chunk);
      });
      const unsubscribeStderr = vm.onProcessStderr(pid, (chunk) => {
        stderr += stderrDecoder.decode(chunk);
      });
      vm.writeProcessStdin(pid, "{\"type\":\"get_commands\"}\n");
      vm.closeProcessStdin(pid);

      const exitCode = await vm.waitProcess(pid);
      unsubscribeStdout();
      unsubscribeStderr();

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");

      const commands = parsePiRpcCommands(stdout);
      expect(commands).toContainEqual(
        expect.objectContaining({
          name: "skill:first-skill",
          source: "skill",
          path: vmSkillPath,
        }),
      );
    } finally {
      runtimeManager.dispose();
    }
  }, 60_000);
});
