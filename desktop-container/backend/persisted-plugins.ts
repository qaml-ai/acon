import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  readPluginAgentAssetsFromManifest,
  type PluginAgentAssetsRecord,
} from "./plugin-agent-assets";

export interface PersistedPluginManifestRecord {
  id: string;
  name: string;
  version: string;
  agentAssets: PluginAgentAssetsRecord | null;
}

export interface PersistedPluginInstallResult extends PersistedPluginManifestRecord {
  installPath: string;
  replaced: boolean;
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

export function getDesktopPluginDirectory(dataDirectory: string): string {
  return resolve(dataDirectory, "plugins");
}

export function readPluginManifestFromDirectory(
  pluginDirectory: string,
): PersistedPluginManifestRecord {
  const sourcePath = resolve(pluginDirectory);
  if (!sourcePath || !isDirectory(sourcePath)) {
    throw new Error("Plugin selection must be a directory.");
  }

  const packagePath = resolve(sourcePath, "package.json");
  if (!existsSync(packagePath)) {
    throw new Error("Selected folder is missing package.json.");
  }

  let packageJson: Record<string, unknown>;
  try {
    packageJson = readJson(packagePath);
  } catch {
    throw new Error("Selected plugin package.json is not valid JSON.");
  }

  const manifest =
    packageJson.camelai && typeof packageJson.camelai === "object"
      ? (packageJson.camelai as Record<string, unknown>)
      : null;
  const pluginId =
    manifest && typeof manifest.id === "string" && manifest.id.trim().length > 0
      ? manifest.id.trim()
      : null;

  if (!pluginId) {
    throw new Error("Selected folder is not a camelai plugin. Expected package.json camelai.id.");
  }

  if (pluginId === "." || pluginId === "..") {
    throw new Error("Plugin id may not be a dot-segment path.");
  }

  if (!/^[A-Za-z0-9._-]+$/.test(pluginId)) {
    throw new Error("Plugin id may only contain letters, numbers, dots, underscores, and hyphens.");
  }

  const pluginName =
    manifest && typeof manifest.name === "string" && manifest.name.trim().length > 0
      ? manifest.name.trim()
      : typeof packageJson.name === "string" && packageJson.name.trim().length > 0
        ? packageJson.name.trim()
        : pluginId;

  return {
    id: pluginId,
    name: pluginName,
    version:
      typeof packageJson.version === "string" && packageJson.version.trim().length > 0
        ? packageJson.version.trim()
        : "0.0.0",
    agentAssets: readPluginAgentAssetsFromManifest(sourcePath, manifest),
  };
}

export function resolvePluginWorkspaceSourcePath(
  managedWorkspaceDirectory: string,
  pluginPath: string,
): string {
  if (typeof pluginPath !== "string" || !pluginPath.trim()) {
    throw new Error("Plugin workspace path must be a non-empty string.");
  }

  const workspaceRoot = resolve(managedWorkspaceDirectory);
  const requestedPath = pluginPath.trim();
  const resolvedPath = isAbsolute(requestedPath)
    ? resolve(workspaceRoot, requestedPath.replace(/^\/+/, ""))
    : resolve(workspaceRoot, requestedPath);
  const relativePath = relative(workspaceRoot, resolvedPath);

  if (
    relativePath === "" ||
    relativePath === "." ||
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    relativePath.startsWith("..\\") ||
    isAbsolute(relativePath)
  ) {
    throw new Error("Plugin workspace path must stay within the managed workspace.");
  }

  return resolvedPath;
}

export function installPluginFromDirectory(options: {
  dataDirectory: string;
  sourceDirectory: string;
}): PersistedPluginInstallResult {
  const sourcePath = resolve(options.sourceDirectory);
  const manifest = readPluginManifestFromDirectory(sourcePath);
  const pluginDirectory = getDesktopPluginDirectory(options.dataDirectory);
  const targetPath = resolve(pluginDirectory, manifest.id);
  const targetRelativePath = relative(pluginDirectory, targetPath);
  const replacing = existsSync(targetPath);

  if (
    targetRelativePath === "" ||
    targetRelativePath === "." ||
    targetRelativePath === ".." ||
    targetRelativePath.startsWith("../") ||
    targetRelativePath.startsWith("..\\") ||
    isAbsolute(targetRelativePath)
  ) {
    throw new Error("Plugin install target must stay within the desktop plugins directory.");
  }

  mkdirSync(pluginDirectory, { recursive: true });

  if (sourcePath !== targetPath) {
    rmSync(targetPath, { recursive: true, force: true });
    cpSync(sourcePath, targetPath, { recursive: true, force: true });
  }

  return {
    ...manifest,
    installPath: targetPath,
    replaced: replacing,
  };
}

export function listPersistedPlugins(dataDirectory: string): PersistedPluginManifestRecord[] {
  const pluginDirectory = getDesktopPluginDirectory(dataDirectory);
  if (!existsSync(pluginDirectory) || !isDirectory(pluginDirectory)) {
    return [];
  }

  return readdirSync(pluginDirectory)
    .flatMap((entry) => {
      const pluginPath = resolve(pluginDirectory, entry);
      try {
        return isDirectory(pluginPath) ? [readPluginManifestFromDirectory(pluginPath)] : [];
      } catch {
        return [];
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}
