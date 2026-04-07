import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type {
  CamelAIManifest,
  DiscoveredCamelAIExtension,
} from "./types";

const BUILTIN_EXTENSION_DIRECTORY = resolve(
  process.cwd(),
  "desktop-agentos/plugins/builtin",
);
const USER_EXTENSION_DIRECTORY = resolve(
  process.env.DESKTOP_DATA_DIR || resolve(process.cwd(), "desktop-agentos/.local"),
  "plugins",
);

export const DEFAULT_EXTENSION_DIRECTORIES = [
  { path: BUILTIN_EXTENSION_DIRECTORY, builtin: true },
  { path: USER_EXTENSION_DIRECTORY, builtin: false },
].filter((entry) => Boolean(entry.path));

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

function resolveSkillDirectories(
  extensionPath: string,
  manifest: Record<string, unknown>,
): string[] {
  const discovered = new Set<string>();
  const explicit =
    typeof manifest.skills === "string"
      ? [manifest.skills]
      : Array.isArray(manifest.skills)
        ? manifest.skills.filter((value): value is string => typeof value === "string")
        : [];

  for (const relativePath of explicit) {
    const resolvedPath = resolve(extensionPath, relativePath);
    if (isDirectory(resolvedPath)) {
      discovered.add(resolvedPath);
    }
  }

  for (const conventionalPath of ["skills", ".agents/skills"]) {
    const resolvedPath = resolve(extensionPath, conventionalPath);
    if (isDirectory(resolvedPath)) {
      discovered.add(resolvedPath);
    }
  }

  return Array.from(discovered.values()).sort((left, right) =>
    left.localeCompare(right),
  );
}

export function discoverExtensions(): DiscoveredCamelAIExtension[] {
  const discovered: DiscoveredCamelAIExtension[] = [];

  for (const root of DEFAULT_EXTENSION_DIRECTORIES) {
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
          skills:
            typeof rawManifest.skills === "string"
              ? [rawManifest.skills]
              : Array.isArray(rawManifest.skills)
                ? rawManifest.skills.filter(
                    (value): value is string => typeof value === "string",
                  )
                : undefined,
          settings:
            typeof rawManifest.settings === "string"
              ? rawManifest.settings
              : undefined,
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
          skillDirectories: resolveSkillDirectories(extensionPath, rawManifest),
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
