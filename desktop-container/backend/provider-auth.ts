import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { getPersistedHostSecret } from "./host-secrets";

export type ManagedProviderAuthKey =
  | "anthropic"
  | "openai"
  | "openrouter"
  | "opencode";

interface ManagedProviderAuthConfigEntry {
  provider: ManagedProviderAuthKey;
  envVar: string;
  secretRef: string;
  legacySourcePriority: Array<"pi" | "opencode">;
}

interface ProviderAuthPaths {
  piAuthPath?: string;
  opencodeAuthPath?: string;
}

export interface ManagedProviderAuthOptions extends ProviderAuthPaths {
  dataDirectory: string;
}

const HOST_PI_AUTH_PATH = resolve(homedir(), ".pi", "agent", "auth.json");
const HOST_OPENCODE_AUTH_PATH = resolve(
  homedir(),
  ".local",
  "share",
  "opencode",
  "auth.json",
);

const MANAGED_PROVIDER_AUTH_CONFIG: readonly ManagedProviderAuthConfigEntry[] = [
  {
    provider: "anthropic",
    envVar: "ANTHROPIC_API_KEY",
    secretRef: "provider-auth/anthropic",
    legacySourcePriority: ["pi", "opencode"],
  },
  {
    provider: "openai",
    envVar: "OPENAI_API_KEY",
    secretRef: "provider-auth/openai",
    legacySourcePriority: ["pi", "opencode"],
  },
  {
    provider: "openrouter",
    envVar: "OPENROUTER_API_KEY",
    secretRef: "provider-auth/openrouter",
    legacySourcePriority: ["opencode", "pi"],
  },
  {
    provider: "opencode",
    envVar: "OPENCODE_API_KEY",
    secretRef: "provider-auth/opencode",
    legacySourcePriority: ["opencode", "pi"],
  },
] as const;

function getPiAuthPath(options?: ProviderAuthPaths): string {
  return options?.piAuthPath ?? HOST_PI_AUTH_PATH;
}

function getOpenCodeAuthPath(options?: ProviderAuthPaths): string {
  return options?.opencodeAuthPath ?? HOST_OPENCODE_AUTH_PATH;
}

function readJsonRecord(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function normalizeSecretValue(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getApiKeyFromCredential(record: Record<string, unknown>, key: string): string | null {
  const credential = record[key];
  if (!credential || typeof credential !== "object" || Array.isArray(credential)) {
    return null;
  }

  const type = (credential as { type?: unknown }).type;
  const apiKey = (credential as { key?: unknown }).key;
  if (type !== "api_key" || typeof apiKey !== "string" || !apiKey.trim()) {
    return null;
  }

  return apiKey.trim();
}

function getLegacyApiKey(
  provider: ManagedProviderAuthKey,
  paths?: ProviderAuthPaths,
): string | null {
  const records = {
    pi: readJsonRecord(getPiAuthPath(paths)),
    opencode: readJsonRecord(getOpenCodeAuthPath(paths)),
  } as const;
  const config = MANAGED_PROVIDER_AUTH_CONFIG.find((entry) => entry.provider === provider);
  if (!config) {
    return null;
  }

  for (const source of config.legacySourcePriority) {
    const value = getApiKeyFromCredential(records[source], provider);
    if (value) {
      return value;
    }
  }

  return null;
}

function getResolvedProviderApiKey(
  options: ManagedProviderAuthOptions,
  provider: ManagedProviderAuthKey,
): string | null {
  const config = MANAGED_PROVIDER_AUTH_CONFIG.find((entry) => entry.provider === provider);
  if (!config) {
    return null;
  }

  const managed = normalizeSecretValue(
    getPersistedHostSecret(options.dataDirectory, config.secretRef),
  );
  if (managed) {
    return managed;
  }

  const envValue = normalizeSecretValue(process.env[config.envVar]);
  if (envValue) {
    return envValue;
  }

  return getLegacyApiKey(provider, options);
}

export function getManagedProviderEnv(
  options: ManagedProviderAuthOptions,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of MANAGED_PROVIDER_AUTH_CONFIG) {
    const value = getResolvedProviderApiKey(options, entry.provider);
    if (!value) {
      continue;
    }
    env[entry.envVar] = value;
  }
  return env;
}
