import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, resolve } from "node:path";
import {
  createStdioProxyHostMcpServer,
  type HostMcpServerRegistration,
} from "./host-mcp";

const HOST_MCP_DIRECTORY_NAME = "host-mcp";
const HOST_MCP_SERVERS_DIRECTORY_NAME = "servers";
const HOST_MCP_SERVER_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface PersistedHostMcpServerRecord {
  id: string;
  transport: "stdio";
  command: string;
  args: string[];
  cwd: string | null;
  env: Record<string, string>;
  name: string | null;
  version: string | null;
}

export interface PersistedHostMcpStdioInstallOptions {
  id: string;
  command: string;
  args?: string[];
  cwd?: string | null;
  env?: Record<string, string>;
  name?: string | null;
  version?: string | null;
}

export interface PersistedHostMcpInstallResult extends PersistedHostMcpServerRecord {
  configPath: string;
  replaced: boolean;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function normalizeServerId(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("Host MCP server id must be a non-empty string.");
  }
  if (!HOST_MCP_SERVER_ID_PATTERN.test(normalized)) {
    throw new Error(
      "Host MCP server id may only contain letters, numbers, dots, underscores, and hyphens.",
    );
  }
  return normalized;
}

function normalizeStringArray(value: unknown, label: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings.`);
  }
  return value.map((entry) => {
    if (typeof entry !== "string") {
      throw new Error(`${label} must contain only strings.`);
    }
    return entry;
  });
}

function normalizeEnv(value: unknown): Record<string, string> {
  if (value === undefined || value === null) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Host MCP server env must be an object of string values.");
  }

  const env: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (typeof rawValue !== "string") {
      throw new Error("Host MCP server env must only contain string values.");
    }
    env[key] = rawValue;
  }
  return env;
}

function normalizeOptionalString(
  value: unknown,
  label: string,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string when provided.`);
  }
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function getHostMcpServerDirectory(dataDirectory: string): string {
  return resolve(
    dataDirectory,
    HOST_MCP_DIRECTORY_NAME,
    HOST_MCP_SERVERS_DIRECTORY_NAME,
  );
}

function getHostMcpServerConfigPath(dataDirectory: string, serverId: string): string {
  return resolve(getHostMcpServerDirectory(dataDirectory), `${serverId}.json`);
}

function normalizeCwd(
  cwd: string | null,
  workspaceDirectory: string,
): string | null {
  if (!cwd) {
    return null;
  }

  return isAbsolute(cwd) ? cwd : resolve(workspaceDirectory, cwd);
}

export function normalizePersistedHostMcpServerRecord(
  raw: unknown,
  options: {
    workspaceDirectory: string;
  },
): PersistedHostMcpServerRecord {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Persisted host MCP server config must be an object.");
  }

  const record = raw as Record<string, unknown>;
  const transport =
    typeof record.transport === "string" ? record.transport.trim() : "stdio";
  if (transport !== "stdio") {
    throw new Error(`Unsupported persisted host MCP transport: ${transport}.`);
  }

  const command = normalizeOptionalString(record.command, "Host MCP command");
  if (!command) {
    throw new Error("Host MCP command must be a non-empty string.");
  }

  return {
    id: normalizeServerId(String(record.id ?? "")),
    transport: "stdio",
    command,
    args: normalizeStringArray(record.args, "Host MCP args"),
    cwd: normalizeCwd(
      normalizeOptionalString(record.cwd, "Host MCP cwd"),
      options.workspaceDirectory,
    ),
    env: normalizeEnv(record.env),
    name: normalizeOptionalString(record.name, "Host MCP name"),
    version: normalizeOptionalString(record.version, "Host MCP version"),
  };
}

export function listPersistedHostMcpServers(options: {
  dataDirectory: string;
  workspaceDirectory: string;
}): PersistedHostMcpServerRecord[] {
  const directory = getHostMcpServerDirectory(options.dataDirectory);
  if (!existsSync(directory) || !isDirectory(directory)) {
    return [];
  }

  const servers: PersistedHostMcpServerRecord[] = [];
  for (const entry of readdirSync(directory)) {
    if (extname(entry) !== ".json") {
      continue;
    }

    const configPath = resolve(directory, entry);
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
      const normalized = normalizePersistedHostMcpServerRecord(parsed, {
        workspaceDirectory: options.workspaceDirectory,
      });
      if (basename(entry, ".json") !== normalized.id) {
        continue;
      }
      servers.push(normalized);
    } catch {
      continue;
    }
  }

  return servers.sort((left, right) => left.id.localeCompare(right.id));
}

export function installPersistedHostMcpServer(options: {
  dataDirectory: string;
  workspaceDirectory: string;
  server: PersistedHostMcpStdioInstallOptions;
}): PersistedHostMcpInstallResult {
  const normalized = normalizePersistedHostMcpServerRecord(
    {
      ...options.server,
      transport: "stdio",
    },
    {
      workspaceDirectory: options.workspaceDirectory,
    },
  );
  const directory = getHostMcpServerDirectory(options.dataDirectory);
  const configPath = getHostMcpServerConfigPath(options.dataDirectory, normalized.id);
  const replaced = existsSync(configPath);

  mkdirSync(directory, { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        ...normalized,
        cwd: normalized.cwd,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    ...normalized,
    configPath,
    replaced,
  };
}

export function uninstallPersistedHostMcpServer(options: {
  dataDirectory: string;
  serverId: string;
}): boolean {
  const serverId = normalizeServerId(options.serverId);
  const configPath = getHostMcpServerConfigPath(options.dataDirectory, serverId);
  if (!existsSync(configPath)) {
    return false;
  }

  rmSync(configPath, { force: true });
  return true;
}

export function createPersistedHostMcpServerRegistration(
  server: PersistedHostMcpServerRecord,
): HostMcpServerRegistration {
  return {
    id: server.id,
    createServer: () =>
      createStdioProxyHostMcpServer(
        {
          command: server.command,
          args: server.args,
          cwd: server.cwd ?? undefined,
          env: {
            ...process.env,
            ...server.env,
          },
          stderr: "pipe",
        },
        {
          name: server.name ?? server.id,
          version: server.version ?? "1.0.0",
        },
      ),
  };
}
