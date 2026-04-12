import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export type AgentAssetProvider = "codex" | "claude" | "pi" | "opencode";

const VALID_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const CODEX_MCP_BLOCK_PREFIX = "# >>> acon managed agent assets:";
const CODEX_MCP_BLOCK_SUFFIX = "# <<< acon managed agent assets:";
const CLAUDE_PROJECT_PATH = "/workspace";
const AGENT_ASSET_LEDGER_FILENAME = "plugin-agent-assets-ledger.json";
const AGENT_ASSET_PROVIDERS = ["codex", "claude", "pi", "opencode"] as const;

export interface PluginAgentSkillAssetRecord {
  id: string;
  path: string;
}

export interface PluginAgentMcpServerStdioRecord {
  id: string;
  transport: "stdio";
  command: string;
  args: string[];
  cwd: string | null;
  env: Record<string, string>;
  name: string | null;
  version: string | null;
}

export interface PluginAgentMcpServerHttpRecord {
  id: string;
  transport: "streamable-http" | "sse";
  url: string;
  headers: Record<string, string>;
  name: string | null;
  version: string | null;
}

export type PluginAgentMcpServerRecord =
  | PluginAgentMcpServerStdioRecord
  | PluginAgentMcpServerHttpRecord;

export interface PluginAgentAssetsRecord {
  skillsPath: string | null;
  mcpServersPath: string | null;
  skills: PluginAgentSkillAssetRecord[];
  mcpServers: PluginAgentMcpServerRecord[];
}

export interface InstalledPluginAgentAssetsStatus {
  provider: AgentAssetProvider;
  installedSkillIds: string[];
  installedMcpServerIds: string[];
}

export interface PluginAgentAssetsBundleRecord {
  pluginId: string;
  pluginName: string;
  pluginVersion: string;
  source: "builtin" | "user";
  path: string;
  agentAssets: PluginAgentAssetsRecord;
  installedByProvider: InstalledPluginAgentAssetsStatus[];
}

interface ApplyPluginAgentAssetsResult {
  pluginId: string;
  pluginName: string;
  pluginVersion: string;
  provider: AgentAssetProvider;
  installedSkills: Array<{
    id: string;
    installPath: string;
  }>;
  installedMcpServers: Array<{
    id: string;
    targetId: string;
  }>;
  replaced: boolean;
}

interface RemovePluginAgentAssetsResult {
  pluginId: string;
  provider: AgentAssetProvider;
  removedSkills: Array<{
    id: string;
    installPath: string;
  }>;
  removedMcpServerIds: string[];
  removed: boolean;
}

interface PluginAgentAssetsLedgerRecord {
  codex: string[];
  claude: string[];
  pi: string[];
  opencode: string[];
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

function normalizeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  const normalized = value.trim();
  if (!VALID_ID_PATTERN.test(normalized)) {
    throw new Error(
      `${label} may only contain letters, numbers, dots, underscores, and hyphens.`,
    );
  }
  return normalized;
}

function normalizeOptionalString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string when provided.`);
  }
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function normalizeStringArray(value: unknown, label: string): string[] {
  if (value === undefined || value === null) {
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

function normalizeStringRecord(
  value: unknown,
  label: string,
): Record<string, string> {
  if (value === undefined || value === null) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object of string values.`);
  }
  const normalized: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new Error(`${label} must only contain string values.`);
    }
    normalized[key] = entry;
  }
  return normalized;
}

function resolvePluginRelativePath(
  pluginDirectory: string,
  relativePath: string,
  label: string,
): string {
  if (typeof relativePath !== "string" || !relativePath.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  const resolvedPath = resolve(pluginDirectory, relativePath.trim());
  const relativeToPlugin = relative(resolve(pluginDirectory), resolvedPath);
  if (
    relativeToPlugin === "" ||
    relativeToPlugin === "." ||
    relativeToPlugin === ".." ||
    relativeToPlugin.startsWith("../") ||
    relativeToPlugin.startsWith("..\\") ||
    isAbsolute(relativeToPlugin)
  ) {
    throw new Error(`${label} must stay within the plugin directory.`);
  }
  return resolvedPath;
}

function parseSkillAssets(
  pluginDirectory: string,
  relativePath: string,
): {
  skillsPath: string;
  skills: PluginAgentSkillAssetRecord[];
} {
  const skillsPath = resolvePluginRelativePath(
    pluginDirectory,
    relativePath,
    "camelai.agentAssets.skills",
  );
  if (!isDirectory(skillsPath)) {
    throw new Error("camelai.agentAssets.skills must point to a directory.");
  }

  const skills = readdirSync(skillsPath)
    .flatMap((entry) => {
      const skillDirectory = resolve(skillsPath, entry);
      const skillFile = resolve(skillDirectory, "SKILL.md");
      if (!isDirectory(skillDirectory) || !existsSync(skillFile)) {
        return [];
      }
      return [
        {
          id: normalizeId(entry, "Skill id"),
          path: skillDirectory,
        } satisfies PluginAgentSkillAssetRecord,
      ];
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    skillsPath,
    skills,
  };
}

function parseMcpServerRecord(
  id: string,
  value: unknown,
): PluginAgentMcpServerRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`MCP server ${id} must be an object.`);
  }

  const record = value as Record<string, unknown>;
  const transport =
    typeof record.transport === "string" && record.transport.trim()
      ? record.transport.trim()
      : "stdio";

  if (transport === "stdio") {
    const command = normalizeOptionalString(record.command, `MCP server ${id} command`);
    if (!command) {
      throw new Error(`MCP server ${id} command must be a non-empty string.`);
    }
    return {
      id,
      transport,
      command,
      args: normalizeStringArray(record.args, `MCP server ${id} args`),
      cwd: normalizeOptionalString(record.cwd, `MCP server ${id} cwd`),
      env: normalizeStringRecord(record.env, `MCP server ${id} env`),
      name: normalizeOptionalString(record.name, `MCP server ${id} name`),
      version: normalizeOptionalString(record.version, `MCP server ${id} version`),
    };
  }

  if (transport !== "streamable-http" && transport !== "sse") {
    throw new Error(
      `MCP server ${id} transport must be stdio, streamable-http, or sse.`,
    );
  }

  const url = normalizeOptionalString(record.url, `MCP server ${id} url`);
  if (!url) {
    throw new Error(`MCP server ${id} url must be a non-empty string.`);
  }

  return {
    id,
    transport,
    url,
    headers: normalizeStringRecord(record.headers, `MCP server ${id} headers`),
    name: normalizeOptionalString(record.name, `MCP server ${id} name`),
    version: normalizeOptionalString(record.version, `MCP server ${id} version`),
  };
}

function parseMcpServerAssets(
  pluginDirectory: string,
  relativePath: string,
): {
  mcpServersPath: string;
  mcpServers: PluginAgentMcpServerRecord[];
} {
  const mcpServersPath = resolvePluginRelativePath(
    pluginDirectory,
    relativePath,
    "camelai.agentAssets.mcpServers",
  );
  if (!existsSync(mcpServersPath)) {
    throw new Error("camelai.agentAssets.mcpServers file does not exist.");
  }

  let json: Record<string, unknown>;
  try {
    json = readJson(mcpServersPath);
  } catch {
    throw new Error("camelai.agentAssets.mcpServers must be valid JSON.");
  }

  const serversValue =
    json.mcpServers && typeof json.mcpServers === "object" && !Array.isArray(json.mcpServers)
      ? (json.mcpServers as Record<string, unknown>)
      : null;

  if (!serversValue) {
    throw new Error("camelai.agentAssets.mcpServers must define an mcpServers object.");
  }

  const mcpServers = Object.entries(serversValue)
    .map(([serverId, server]) =>
      parseMcpServerRecord(normalizeId(serverId, "MCP server id"), server),
    )
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    mcpServersPath,
    mcpServers,
  };
}

export function readPluginAgentAssetsFromManifest(
  pluginDirectory: string,
  manifest: Record<string, unknown> | null | undefined,
): PluginAgentAssetsRecord | null {
  const agentAssets =
    manifest?.agentAssets &&
    typeof manifest.agentAssets === "object" &&
    !Array.isArray(manifest.agentAssets)
      ? (manifest.agentAssets as Record<string, unknown>)
      : null;
  if (!agentAssets) {
    return null;
  }

  const skillsPointer =
    typeof agentAssets.skills === "string" ? agentAssets.skills : null;
  const mcpServersPointer =
    typeof agentAssets.mcpServers === "string" ? agentAssets.mcpServers : null;

  if (!skillsPointer && !mcpServersPointer) {
    throw new Error(
      "camelai.agentAssets must define at least one of skills or mcpServers.",
    );
  }

  const parsedSkills = skillsPointer
    ? parseSkillAssets(pluginDirectory, skillsPointer)
    : { skillsPath: null, skills: [] };
  const parsedMcpServers = mcpServersPointer
    ? parseMcpServerAssets(pluginDirectory, mcpServersPointer)
    : { mcpServersPath: null, mcpServers: [] };

  return {
    skillsPath: parsedSkills.skillsPath,
    mcpServersPath: parsedMcpServers.mcpServersPath,
    skills: parsedSkills.skills,
    mcpServers: parsedMcpServers.mcpServers,
  };
}

function getProviderHome(runtimeDirectory: string, provider: AgentAssetProvider): string {
  return resolve(runtimeDirectory, "providers", provider, "home");
}

function getAgentAssetsLedgerPath(runtimeDirectory: string): string {
  return resolve(runtimeDirectory, AGENT_ASSET_LEDGER_FILENAME);
}

function getCodexHome(runtimeDirectory: string): string {
  return resolve(getProviderHome(runtimeDirectory, "codex"), ".codex");
}

function getClaudeConfigDir(runtimeDirectory: string): string {
  return resolve(getProviderHome(runtimeDirectory, "claude"), ".claude");
}

function getCodexSkillDirectory(runtimeDirectory: string): string {
  return resolve(getCodexHome(runtimeDirectory), "skills");
}

function getClaudeSkillDirectory(runtimeDirectory: string): string {
  return resolve(getClaudeConfigDir(runtimeDirectory), "skills");
}

function getPiSkillDirectory(runtimeDirectory: string): string {
  return resolve(getProviderHome(runtimeDirectory, "pi"), ".pi", "agent", "skills");
}

function getOpenCodeSkillDirectory(runtimeDirectory: string): string {
  return resolve(
    getProviderHome(runtimeDirectory, "opencode"),
    ".config",
    "opencode",
    "skills",
  );
}

function getProviderSkillDirectory(
  runtimeDirectory: string,
  provider: AgentAssetProvider,
): string {
  switch (provider) {
    case "codex":
      return getCodexSkillDirectory(runtimeDirectory);
    case "claude":
      return getClaudeSkillDirectory(runtimeDirectory);
    case "pi":
      return getPiSkillDirectory(runtimeDirectory);
    case "opencode":
      return getOpenCodeSkillDirectory(runtimeDirectory);
  }
}

function providerSupportsMcpAssetSync(
  provider: AgentAssetProvider,
): provider is "codex" | "claude" {
  return provider === "codex" || provider === "claude";
}

function getCodexConfigPath(runtimeDirectory: string): string {
  return resolve(getCodexHome(runtimeDirectory), "config.toml");
}

function getClaudeStatePath(runtimeDirectory: string): string {
  return resolve(getProviderHome(runtimeDirectory, "claude"), ".claude.json");
}

function getInstalledSkillDirectoryName(pluginId: string, skillId: string): string {
  return `${pluginId}--${skillId}`;
}

function getNamespacedMcpServerId(pluginId: string, serverId: string): string {
  return `plugin.${pluginId}.${serverId}`;
}

function getInstalledSkillDirectory(
  runtimeDirectory: string,
  provider: AgentAssetProvider,
  pluginId: string,
  skillId: string,
): string {
  const skillRoot = getProviderSkillDirectory(runtimeDirectory, provider);
  return resolve(skillRoot, getInstalledSkillDirectoryName(pluginId, skillId));
}

function listInstalledSkillIds(
  runtimeDirectory: string,
  provider: AgentAssetProvider,
  pluginId: string,
): string[] {
  const skillRoot = getProviderSkillDirectory(runtimeDirectory, provider);
  if (!isDirectory(skillRoot)) {
    return [];
  }

  const prefix = `${pluginId}--`;
  return readdirSync(skillRoot)
    .flatMap((entry) => {
      if (!entry.startsWith(prefix)) {
        return [];
      }
      const skillDirectory = resolve(skillRoot, entry);
      if (!isDirectory(skillDirectory) || !existsSync(resolve(skillDirectory, "SKILL.md"))) {
        return [];
      }
      return [entry.slice(prefix.length)];
    })
    .sort((left, right) => left.localeCompare(right));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readTextFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function readAgentAssetsLedger(runtimeDirectory: string): PluginAgentAssetsLedgerRecord {
  const path = getAgentAssetsLedgerPath(runtimeDirectory);
  if (!existsSync(path)) {
    return {
      codex: [],
      claude: [],
      pi: [],
      opencode: [],
    };
  }

  try {
    const parsed = readJson(path);
    return {
      codex: Array.isArray(parsed.codex)
        ? parsed.codex.filter((entry): entry is string => typeof entry === "string")
        : [],
      claude: Array.isArray(parsed.claude)
        ? parsed.claude.filter((entry): entry is string => typeof entry === "string")
        : [],
      pi: Array.isArray(parsed.pi)
        ? parsed.pi.filter((entry): entry is string => typeof entry === "string")
        : [],
      opencode: Array.isArray(parsed.opencode)
        ? parsed.opencode.filter((entry): entry is string => typeof entry === "string")
        : [],
    };
  } catch {
    return {
      codex: [],
      claude: [],
      pi: [],
      opencode: [],
    };
  }
}

function writeAgentAssetsLedger(
  runtimeDirectory: string,
  ledger: PluginAgentAssetsLedgerRecord,
): void {
  const path = getAgentAssetsLedgerPath(runtimeDirectory);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        codex: [...new Set(ledger.codex)].sort((left, right) => left.localeCompare(right)),
        claude: [...new Set(ledger.claude)].sort((left, right) => left.localeCompare(right)),
        pi: [...new Set(ledger.pi)].sort((left, right) => left.localeCompare(right)),
        opencode: [...new Set(ledger.opencode)].sort((left, right) =>
          left.localeCompare(right),
        ),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function updateAgentAssetsLedger(
  runtimeDirectory: string,
  provider: AgentAssetProvider,
  pluginId: string,
  installed: boolean,
): void {
  const ledger = readAgentAssetsLedger(runtimeDirectory);
  const next = new Set(ledger[provider]);
  if (installed) {
    next.add(pluginId);
  } else {
    next.delete(pluginId);
  }
  ledger[provider] = [...next];
  writeAgentAssetsLedger(runtimeDirectory, ledger);
}

function removeManagedCodexBlock(contents: string, pluginId: string): string {
  const blockLabel = escapeRegExp(`${CODEX_MCP_BLOCK_PREFIX}${pluginId}`);
  const blockSuffix = escapeRegExp(`${CODEX_MCP_BLOCK_SUFFIX}${pluginId}`);
  return contents
    .replace(new RegExp(`\\n?${blockLabel}[\\s\\S]*?${blockSuffix}\\n?`, "g"), "\n")
    .replace(/^\s+|\s+$/g, "")
    .trim();
}

function renderTomlString(value: string): string {
  return JSON.stringify(value);
}

function renderTomlArray(values: string[]): string {
  return `[${values.map((value) => renderTomlString(value)).join(", ")}]`;
}

function renderTomlInlineTable(values: Record<string, string>): string {
  const entries = Object.entries(values).sort(([left], [right]) => left.localeCompare(right));
  return `{ ${entries
    .map(([key, value]) => `${key} = ${renderTomlString(value)}`)
    .join(", ")} }`;
}

function resolveProviderWorkspacePath(value: string | null): string | null {
  if (!value) {
    return null;
  }
  return isAbsolute(value) ? value : resolve("/workspace", value);
}

function renderManagedCodexBlock(
  pluginId: string,
  mcpServers: PluginAgentMcpServerRecord[],
): string {
  if (mcpServers.length === 0) {
    return "";
  }

  const lines = [`${CODEX_MCP_BLOCK_PREFIX}${pluginId}`];
  for (const server of mcpServers) {
    const targetId = getNamespacedMcpServerId(pluginId, server.id);
    lines.push(`[mcp_servers.${renderTomlString(targetId)}]`);
    if (server.transport === "stdio") {
      lines.push(`command = ${renderTomlString(server.command)}`);
      if (server.args.length > 0) {
        lines.push(`args = ${renderTomlArray(server.args)}`);
      }
      const cwd = resolveProviderWorkspacePath(server.cwd);
      if (cwd) {
        lines.push(`cwd = ${renderTomlString(cwd)}`);
      }
      if (Object.keys(server.env).length > 0) {
        lines.push(`env = ${renderTomlInlineTable(server.env)}`);
      }
    } else {
      lines.push(`url = ${renderTomlString(server.url)}`);
      if (server.transport === "sse") {
        lines.push(`transport = ${renderTomlString("sse")}`);
      }
      if (Object.keys(server.headers).length > 0) {
        lines.push(`http_headers = ${renderTomlInlineTable(server.headers)}`);
      }
    }
    lines.push(`enabled = true`);
    if (server.name) {
      lines.push(`name = ${renderTomlString(server.name)}`);
    }
    if (server.version) {
      lines.push(`version = ${renderTomlString(server.version)}`);
    }
    lines.push("");
  }
  lines.push(`${CODEX_MCP_BLOCK_SUFFIX}${pluginId}`);
  return lines.join("\n").trim();
}

function upsertCodexManagedMcpBlock(
  runtimeDirectory: string,
  pluginId: string,
  mcpServers: PluginAgentMcpServerRecord[],
): string[] {
  const configPath = getCodexConfigPath(runtimeDirectory);
  mkdirSync(dirname(configPath), { recursive: true });
  const existing = readTextFile(configPath);
  const withoutBlock = removeManagedCodexBlock(existing, pluginId);
  const block = renderManagedCodexBlock(pluginId, mcpServers);
  const nextContents = [withoutBlock, block].filter(Boolean).join("\n\n").trim();
  writeFileSync(configPath, `${nextContents}\n`, "utf8");
  return mcpServers.map((server) => getNamespacedMcpServerId(pluginId, server.id));
}

function removeCodexManagedMcpBlock(
  runtimeDirectory: string,
  pluginId: string,
): string[] {
  const configPath = getCodexConfigPath(runtimeDirectory);
  const existing = readTextFile(configPath);
  if (!existing) {
    return [];
  }
  const removedIds = listInstalledCodexMcpServerIds(runtimeDirectory, pluginId);
  const nextContents = removeManagedCodexBlock(existing, pluginId);
  if (nextContents) {
    writeFileSync(configPath, `${nextContents}\n`, "utf8");
  } else {
    rmSync(configPath, { force: true });
  }
  return removedIds;
}

function listInstalledCodexMcpServerIds(
  runtimeDirectory: string,
  pluginId: string,
): string[] {
  const configContents = readTextFile(getCodexConfigPath(runtimeDirectory));
  if (!configContents) {
    return [];
  }
  const prefix = escapeRegExp(`plugin.${pluginId}.`);
  return Array.from(
    configContents.matchAll(new RegExp(`\\[mcp_servers\\.\"(${prefix}[^\"]+)\"\\]`, "g")),
  )
    .map((match) => match[1] ?? "")
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

function readClaudeState(runtimeDirectory: string): Record<string, unknown> {
  const statePath = getClaudeStatePath(runtimeDirectory);
  if (!existsSync(statePath)) {
    return {};
  }
  try {
    return readJson(statePath);
  } catch {
    return {};
  }
}

function writeClaudeState(runtimeDirectory: string, state: Record<string, unknown>): void {
  const statePath = getClaudeStatePath(runtimeDirectory);
  mkdirSync(resolve(statePath, ".."), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function ensureClaudeProjectState(
  state: Record<string, unknown>,
): Record<string, unknown> {
  const projects =
    state.projects && typeof state.projects === "object" && !Array.isArray(state.projects)
      ? (state.projects as Record<string, unknown>)
      : {};
  state.projects = projects;
  const project =
    projects[CLAUDE_PROJECT_PATH] &&
    typeof projects[CLAUDE_PROJECT_PATH] === "object" &&
    !Array.isArray(projects[CLAUDE_PROJECT_PATH])
      ? (projects[CLAUDE_PROJECT_PATH] as Record<string, unknown>)
      : {};
  projects[CLAUDE_PROJECT_PATH] = project;
  const mcpServers =
    project.mcpServers &&
    typeof project.mcpServers === "object" &&
    !Array.isArray(project.mcpServers)
      ? (project.mcpServers as Record<string, unknown>)
      : {};
  project.mcpServers = mcpServers;
  return mcpServers;
}

function listInstalledClaudeMcpServerIds(
  runtimeDirectory: string,
  pluginId: string,
): string[] {
  const state = readClaudeState(runtimeDirectory);
  const projects =
    state.projects && typeof state.projects === "object" && !Array.isArray(state.projects)
      ? (state.projects as Record<string, unknown>)
      : {};
  const project =
    projects[CLAUDE_PROJECT_PATH] &&
    typeof projects[CLAUDE_PROJECT_PATH] === "object" &&
    !Array.isArray(projects[CLAUDE_PROJECT_PATH])
      ? (projects[CLAUDE_PROJECT_PATH] as Record<string, unknown>)
      : {};
  const mcpServers =
    project.mcpServers &&
    typeof project.mcpServers === "object" &&
    !Array.isArray(project.mcpServers)
      ? (project.mcpServers as Record<string, unknown>)
      : {};
  const prefix = `plugin.${pluginId}.`;
  return Object.keys(mcpServers)
    .filter((serverId) => serverId.startsWith(prefix))
    .sort((left, right) => left.localeCompare(right));
}

function upsertClaudeManagedMcpServers(
  runtimeDirectory: string,
  pluginId: string,
  mcpServers: PluginAgentMcpServerRecord[],
): string[] {
  const state = readClaudeState(runtimeDirectory);
  const target = ensureClaudeProjectState(state);
  const prefix = `plugin.${pluginId}.`;
  for (const key of Object.keys(target)) {
    if (key.startsWith(prefix)) {
      delete target[key];
    }
  }
  for (const server of mcpServers) {
    const targetId = getNamespacedMcpServerId(pluginId, server.id);
    target[targetId] =
      server.transport === "stdio"
        ? {
            command: server.command,
            args: server.args,
            cwd: resolveProviderWorkspacePath(server.cwd),
            env: server.env,
          }
        : {
            transport: server.transport,
            url: server.url,
            headers: server.headers,
          };
  }
  writeClaudeState(runtimeDirectory, state);
  return mcpServers.map((server) => getNamespacedMcpServerId(pluginId, server.id));
}

function removeClaudeManagedMcpServers(
  runtimeDirectory: string,
  pluginId: string,
): string[] {
  const state = readClaudeState(runtimeDirectory);
  const target = ensureClaudeProjectState(state);
  const prefix = `plugin.${pluginId}.`;
  const removedIds = Object.keys(target)
    .filter((serverId) => serverId.startsWith(prefix))
    .sort((left, right) => left.localeCompare(right));
  for (const serverId of removedIds) {
    delete target[serverId];
  }
  writeClaudeState(runtimeDirectory, state);
  return removedIds;
}

export function getInstalledPluginAgentAssetsStatus(options: {
  runtimeDirectory: string;
  pluginId: string;
}): InstalledPluginAgentAssetsStatus[] {
  return AGENT_ASSET_PROVIDERS.map((provider) => ({
    provider,
    installedSkillIds: listInstalledSkillIds(
      options.runtimeDirectory,
      provider,
      options.pluginId,
    ),
    installedMcpServerIds:
      provider === "codex"
        ? listInstalledCodexMcpServerIds(options.runtimeDirectory, options.pluginId)
        : provider === "claude"
          ? listInstalledClaudeMcpServerIds(options.runtimeDirectory, options.pluginId)
          : [],
  }));
}

function applyPluginAgentAssets(options: {
  runtimeDirectory: string;
  pluginId: string;
  pluginName: string;
  pluginVersion: string;
  provider: AgentAssetProvider;
  agentAssets: PluginAgentAssetsRecord;
  installSkills?: boolean;
  installMcpServers?: boolean;
}): ApplyPluginAgentAssetsResult {
  const installSkills = options.installSkills !== false;
  const installMcpServers = options.installMcpServers !== false;
  if (!installSkills && !installMcpServers) {
    throw new Error("At least one of skills or mcpServers must be selected.");
  }

  mkdirSync(getProviderHome(options.runtimeDirectory, options.provider), {
    recursive: true,
  });
  const previousStatus = getInstalledPluginAgentAssetsStatus({
    runtimeDirectory: options.runtimeDirectory,
    pluginId: options.pluginId,
  }).find((entry) => entry.provider === options.provider);

  const installedSkills = installSkills
    ? options.agentAssets.skills.map((skill) => {
        const installPath = getInstalledSkillDirectory(
          options.runtimeDirectory,
          options.provider,
          options.pluginId,
          skill.id,
        );
        mkdirSync(resolve(installPath, ".."), { recursive: true });
        rmSync(installPath, { recursive: true, force: true });
        cpSync(skill.path, installPath, { recursive: true, force: true });
        return {
          id: skill.id,
          installPath,
        };
      })
    : [];

  const installedMcpServers = installMcpServers
    ? providerSupportsMcpAssetSync(options.provider)
      ? (
        options.provider === "codex"
          ? upsertCodexManagedMcpBlock(
              options.runtimeDirectory,
              options.pluginId,
              options.agentAssets.mcpServers,
            )
          : upsertClaudeManagedMcpServers(
              options.runtimeDirectory,
              options.pluginId,
              options.agentAssets.mcpServers,
            )
      ).map((targetId) => ({
          id: targetId.replace(`plugin.${options.pluginId}.`, ""),
          targetId,
        }))
      : []
    : [];

  const result = {
    pluginId: options.pluginId,
    pluginName: options.pluginName,
    pluginVersion: options.pluginVersion,
    provider: options.provider,
    installedSkills,
    installedMcpServers,
    replaced:
      Boolean(previousStatus?.installedSkillIds.length) ||
      Boolean(previousStatus?.installedMcpServerIds.length),
  };
  updateAgentAssetsLedger(
    options.runtimeDirectory,
    options.provider,
    options.pluginId,
    true,
  );
  return result;
}

function removePluginAgentAssets(options: {
  runtimeDirectory: string;
  pluginId: string;
  provider: AgentAssetProvider;
}): RemovePluginAgentAssetsResult {
  const removedSkills = listInstalledSkillIds(
    options.runtimeDirectory,
    options.provider,
    options.pluginId,
  ).map((skillId) => {
    const installPath = getInstalledSkillDirectory(
      options.runtimeDirectory,
      options.provider,
      options.pluginId,
      skillId,
    );
    rmSync(installPath, { recursive: true, force: true });
    return {
      id: skillId,
      installPath,
    };
  });

  const removedMcpServerIds =
    options.provider === "codex"
      ? removeCodexManagedMcpBlock(options.runtimeDirectory, options.pluginId)
      : options.provider === "claude"
        ? removeClaudeManagedMcpServers(options.runtimeDirectory, options.pluginId)
        : [];

  const result = {
    pluginId: options.pluginId,
    provider: options.provider,
    removedSkills,
    removedMcpServerIds,
    removed: removedSkills.length > 0 || removedMcpServerIds.length > 0,
  };
  updateAgentAssetsLedger(
    options.runtimeDirectory,
    options.provider,
    options.pluginId,
    false,
  );
  return result;
}

export function reconcilePluginAgentAssets(options: {
  runtimeDirectory: string;
  plugins: Array<{
    pluginId: string;
    pluginName: string;
    pluginVersion: string;
    enabled: boolean;
    agentAssets: PluginAgentAssetsRecord | null;
  }>;
}): void {
  const desiredPlugins = options.plugins.filter(
    (plugin) => plugin.enabled && plugin.agentAssets,
  ) as Array<{
    pluginId: string;
    pluginName: string;
    pluginVersion: string;
    enabled: true;
    agentAssets: PluginAgentAssetsRecord;
  }>;
  const desiredPluginIds = new Set(desiredPlugins.map((plugin) => plugin.pluginId));
  const ledger = readAgentAssetsLedger(options.runtimeDirectory);

  for (const provider of AGENT_ASSET_PROVIDERS) {
    for (const plugin of desiredPlugins) {
      applyPluginAgentAssets({
        runtimeDirectory: options.runtimeDirectory,
        pluginId: plugin.pluginId,
        pluginName: plugin.pluginName,
        pluginVersion: plugin.pluginVersion,
        provider,
        agentAssets: plugin.agentAssets,
      });
    }

    for (const pluginId of ledger[provider]) {
      if (desiredPluginIds.has(pluginId)) {
        continue;
      }
      removePluginAgentAssets({
        runtimeDirectory: options.runtimeDirectory,
        pluginId,
        provider,
      });
    }

    ledger[provider] = desiredPlugins.map((plugin) => plugin.pluginId);
  }

  writeAgentAssetsLedger(options.runtimeDirectory, ledger);
}
