import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { ContainerRuntimeManager } from "../desktop-container/backend/container-runtime";
import { requireDesktopProvider } from "../desktop-container/backend/providers";

function getRunArgs(providerId: "codex" | "claude"): string[] {
  const runtime = new ContainerRuntimeManager() as ContainerRuntimeManager & {
    buildProviderContainerRunArgs: (
      provider: ReturnType<typeof requireDesktopProvider>,
      state: {
        containerName: string;
      },
      managedWorkspace: {
        rootPath: string;
      },
      providersDataDirectory: string,
    ) => string[];
  };

  return runtime.buildProviderContainerRunArgs(
    requireDesktopProvider(providerId),
    {
      containerName: "test-container",
    },
    {
      rootPath: "/managed/workspace",
    },
    "/runtime/providers",
  );
}

describe("ContainerRuntimeManager", () => {
  it("ships built-in agent instructions in the guest daemon", () => {
    const daemonSource = readFileSync(
      resolve(
        process.cwd(),
        "desktop-container/container-images/bridge/acon-agentd.mjs",
      ),
      "utf8",
    );

    expect(daemonSource).toContain("the standalone camelAI desktop app");
    expect(daemonSource).toContain("Use the codename \\`acon\\` when referring to this app.");
    expect(daemonSource).toContain("A bash tool named \\`acon-mcp\\` is available in the container.");
    expect(daemonSource).toContain("Run \\`acon-mcp servers\\` to list available MCP servers.");
    expect(daemonSource).toContain(
      "Run \\`acon-mcp tools <server-id>\\` to list the tools exposed by a server.",
    );
    expect(daemonSource).toContain(
      "Run \\`acon-mcp call <server-id> <tool-name> --input '{\"key\":\"value\"}'\\` for one-shot tool calls.",
    );
    expect(daemonSource).toContain(
      "A typed JavaScript package named \\`@acon/host-rpc\\` is preinstalled for guest code.",
    );
    expect(daemonSource).toContain("callMcpTool(serverId, toolName, args)");
    expect(daemonSource).toContain("getMcpPrompt(serverId, promptName, args)");
    expect(daemonSource).toContain("readMcpResource(serverId, uri)");
    expect(daemonSource).toContain(
      'import { createHostRpcClient } from "@acon/host-rpc";',
    );
    expect(daemonSource).toContain("MCP tools are external integrations.");
    expect(daemonSource).toContain('"--dangerously-bypass-approvals-and-sandbox"');
    expect(daemonSource).toContain('"bypassPermissions"');
  });

  it("loads the guest host RPC package from the bundled node_modules path", () => {
    const mcpBridgeSource = readFileSync(
      resolve(
        process.cwd(),
        "desktop-container/container-images/bridge/acon-mcp.mjs",
      ),
      "utf8",
    );

    expect(mcpBridgeSource).toContain('"/opt/acon/npm-global/node_modules"');
    expect(mcpBridgeSource).toContain('resolve(');
    expect(mcpBridgeSource).toContain('"@acon/host-rpc/index.js"');
    expect(mcpBridgeSource).toContain('require.resolve("@acon/host-rpc")');
  });

  it("ships typed metadata for the guest host RPC package", () => {
    const packageJson = readFileSync(
      resolve(
        process.cwd(),
        "desktop-container/container-images/npm-packages/acon-host-rpc/package.json",
      ),
      "utf8",
    );
    const typeDefinitions = readFileSync(
      resolve(
        process.cwd(),
        "desktop-container/container-images/npm-packages/acon-host-rpc/index.d.ts",
      ),
      "utf8",
    );

    expect(packageJson).toContain('"name": "@acon/host-rpc"');
    expect(packageJson).toContain('"types": "./index.d.ts"');
    expect(typeDefinitions).toContain("export class HostRpcClient");
    expect(typeDefinitions).toContain("listMcpServers(): Promise<HostMcpServerSummary[]>");
    expect(typeDefinitions).toContain("callMcpTool<TResult = unknown>(");
    expect(typeDefinitions).toContain("listMcpPrompts(");
    expect(typeDefinitions).toContain("readMcpResource(");
    expect(typeDefinitions).toContain("withMcpSession<TResult = unknown>(");
  });

  it("keeps the guest host RPC client version constant in sync with package metadata", async () => {
    const packageJson = JSON.parse(
      readFileSync(
        resolve(
          process.cwd(),
          "desktop-container/container-images/npm-packages/acon-host-rpc/package.json",
        ),
        "utf8",
      ),
    ) as { version: string };
    const hostRpcModule = (await import(
      pathToFileURL(
        resolve(
          process.cwd(),
          "desktop-container/container-images/npm-packages/acon-host-rpc/index.js",
        ),
      ).href
    )) as {
      DEFAULT_MCP_CLIENT_INFO: { version: string };
      DEFAULT_MCP_CLIENT_VERSION: string;
    };

    expect(hostRpcModule.DEFAULT_MCP_CLIENT_VERSION).toBe(packageJson.version);
    expect(hostRpcModule.DEFAULT_MCP_CLIENT_INFO.version).toBe(packageJson.version);
  });

  it("bootstraps the host RPC directory before dropping root", () => {
    const entrypointSource = readFileSync(
      resolve(
        process.cwd(),
        "desktop-container/container-images/acpx-shared/entrypoint.sh",
      ),
      "utf8",
    );

    expect(entrypointSource).toContain("mkdir -p /data/providers /workspace /data/host-rpc");
    expect(entrypointSource).toContain('ACON_UID=1000');
    expect(entrypointSource).toContain('ACON_GID=1000');
    expect(entrypointSource).toContain('chown "${ACON_UID}:${ACON_GID}" /data/host-rpc');
  });

  it("uses the shared image's fixed uid/gid for the container runtime user", () => {
    const containerfileSource = readFileSync(
      resolve(
        process.cwd(),
        "desktop-container/container-images/acpx-shared/Containerfile",
      ),
      "utf8",
    );

    expect(containerfileSource).not.toContain("groupadd --gid 1000");
    expect(containerfileSource).not.toContain("useradd --uid 1000");
  });

  it("installs the shared guest toolchain in the image definition", () => {
    const containerfileSource = readFileSync(
      resolve(
        process.cwd(),
        "desktop-container/container-images/acpx-shared/Containerfile",
      ),
      "utf8",
    );

    for (const packageName of [
      "python3",
      "python3-pip",
      "ruby",
      "default-jdk-headless",
      "ffmpeg",
      "freetds-bin",
      "imagemagick",
      "tesseract-ocr",
      "tesseract-ocr-eng",
      "pandoc",
      "libreoffice",
      "postgresql-client",
      "sqlite3",
      "tdsodbc",
      "unixodbc",
      "unixodbc-dev",
      "jq",
      "git",
      "curl",
      "wget",
    ]) {
      expect(containerfileSource).toContain(packageName);
    }
  });

  it("preinstalls curated Python packages in the shared image definition", () => {
    const containerfileSource = readFileSync(
      resolve(
        process.cwd(),
        "desktop-container/container-images/acpx-shared/Containerfile",
      ),
      "utf8",
    );
    const requirementsSource = readFileSync(
      resolve(
        process.cwd(),
        "desktop-container/container-images/acpx-shared/python-requirements.txt",
      ),
      "utf8",
    );

    expect(containerfileSource).toContain("python-requirements.txt");
    expect(containerfileSource).toContain("--break-system-packages");
    expect(containerfileSource).toContain("ghostscript");
    expect(containerfileSource).toContain("graphviz");
    expect(containerfileSource).toContain("poppler-utils");

    for (const packageName of [
      "openpyxl",
      "xlsxwriter",
      "python-docx",
      "python-pptx",
      "odfpy",
      "pdfplumber",
      "pdfminer.six",
      "pypdf",
      "pypdfium2",
      "pikepdf",
      "pdf2image",
      "img2pdf",
      "reportlab",
      "pycairo",
      "rlPyCairo",
      "camelot-py",
      "tabula-py",
      "onnxruntime",
      "magika",
      "opencv-python",
      "numpy",
      "pandas",
      "matplotlib",
      "seaborn",
      "sympy",
      "graphviz",
      "pyarrow",
      "duckdb",
      "psycopg[binary]",
      "google-cloud-bigquery",
      "google-cloud-bigquery-storage",
      "pandas-gbq",
      "db-dtypes",
      "snowflake-connector-python[pandas]",
      "databricks-sql-connector[pyarrow]",
      "pyodbc",
      "python-tds",
      "beautifulsoup4",
      "lxml",
      "requests",
      "markitdown",
      "markdownify",
      "pillow",
      "imageio",
      "imageio-ffmpeg",
      "wand",
      "freetype-py",
      "pytesseract",
      "pyoo",
      "unoserver",
    ]) {
      expect(requirementsSource).toContain(packageName);
    }
  });

  it("restarts the provider container after a recoverable daemon startup failure", async () => {
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
      if (ensureProviderContainerCalls === 1) {
        throw new Error(
          'Container daemon exited (code=1, signal=null). Error: internalError: "failed to create process in container" (cause: "invalidState: "cannot exec: container is not running"")',
        );
      }
    };
    runtime.restartProviderContainer = async () => {
      restartProviderContainerCalls += 1;
    };

    const status = await runtime.ensureRuntime(provider);

    expect(status.state).toBe("running");
    expect(ensureProviderContainerCalls).toBe(2);
    expect(restartProviderContainerCalls).toBe(1);
  });

  it("builds shared container run args for the daemon and managed workspace", () => {
    const args = getRunArgs("codex");

    expect(args[0]).toBe("run");
    expect(args).toContain("--interactive");
    expect(args).toContain("--name");
    expect(args).toContain("/runtime/providers:/data/providers");
    expect(args).toContain("/managed/workspace:/workspace");
    expect(args).toContain("ACON_HOST_RPC_SOCKET=/data/host-rpc/bridge.sock");
    expect(args.at(-3)).toBe("acon-desktop-acpx:0.1");
    expect(args.at(-2)).toBe("node");
    expect(args.at(-1)).toBe("/usr/local/lib/acon/acon-agentd.mjs");
  });

  it("creates a persistent empty managed workspace under app data", () => {
    const sandboxRoot = mkdtempSync(join(tmpdir(), "acon-runtime-test-"));
    const dataDirectory = resolve(sandboxRoot, "data");
    const runtimeDirectory = resolve(sandboxRoot, "runtime");
    const previousDataDirectory = process.env.DESKTOP_DATA_DIR;
    const previousRuntimeDirectory = process.env.DESKTOP_RUNTIME_DIR;

    process.env.DESKTOP_DATA_DIR = dataDirectory;
    process.env.DESKTOP_RUNTIME_DIR = runtimeDirectory;

    try {
      const runtime = new ContainerRuntimeManager() as ContainerRuntimeManager & {
        ensureManagedWorkspaceInitialized: () => {
          id: string;
          rootPath: string;
          metadataPath: string;
        };
      };

      const firstState = runtime.ensureManagedWorkspaceInitialized();
      const secondRuntime = new ContainerRuntimeManager() as ContainerRuntimeManager & {
        ensureManagedWorkspaceInitialized: () => {
          id: string;
          rootPath: string;
          metadataPath: string;
        };
      };
      const secondState = secondRuntime.ensureManagedWorkspaceInitialized();

      expect(firstState.rootPath).toBe(secondState.rootPath);
      expect(firstState.rootPath.startsWith(resolve(dataDirectory, "workspaces"))).toBe(
        true,
      );
      expect(firstState.id).toBe("default");
      expect(existsSync(firstState.rootPath)).toBe(true);
      expect(statSync(firstState.rootPath).mode & 0o777).toBe(0o777);
      expect(readFileSync(firstState.metadataPath, "utf8")).toContain('"seedMode": "empty"');
    } finally {
      if (previousDataDirectory === undefined) {
        delete process.env.DESKTOP_DATA_DIR;
      } else {
        process.env.DESKTOP_DATA_DIR = previousDataDirectory;
      }
      if (previousRuntimeDirectory === undefined) {
        delete process.env.DESKTOP_RUNTIME_DIR;
      } else {
        process.env.DESKTOP_RUNTIME_DIR = previousRuntimeDirectory;
      }
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });

  it("fans out daemon runtime events to every active prompt listener for a session", () => {
    const runtime = new ContainerRuntimeManager() as ContainerRuntimeManager & {
      addActivePromptListener: (
        sessionName: string,
        listener: {
          onRuntimeEvent?: (event: unknown) => void;
        },
      ) => void;
      handleProviderDaemonNotification: (message: {
        method: string;
        params: {
          sessionName: string;
          event: unknown;
        };
      }) => void;
    };

    const received: unknown[] = [];
    runtime.addActivePromptListener("codex-thread-1", {
      onRuntimeEvent: (event) => {
        received.push({ listener: "first", event });
      },
    });
    runtime.addActivePromptListener("codex-thread-1", {
      onRuntimeEvent: (event) => {
        received.push({ listener: "second", event });
      },
    });

    runtime.handleProviderDaemonNotification({
      method: "session.runtime_event",
      params: {
        sessionName: "codex-thread-1",
        event: {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "session-1",
          },
        },
      },
    });

    expect(received).toEqual([
      {
        listener: "first",
        event: {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "session-1",
          },
        },
      },
      {
        listener: "second",
        event: {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "session-1",
          },
        },
      },
    ]);
  });
});
