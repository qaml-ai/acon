import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type {
  DesktopAuthState,
  DesktopModel,
  DesktopModelOption,
  DesktopProvider,
} from "../../desktop/shared/protocol";
import {
  getCustomOpenAiCompatibleProviderLabel,
  getCustomOpenAiCompatibleProviderModel,
  isCustomOpenAiCompatibleProviderConfigured,
  readCustomOpenAiCompatibleProviderConfig,
} from "./custom-openai-compatible-provider";

export const DEFAULT_ACP_MODEL = "default";

const HOST_PI_AUTH_PATH = resolve(homedir(), ".pi", "agent", "auth.json");
const HOST_PI_MODELS_PATH = resolve(homedir(), ".pi", "agent", "models.json");
const HOST_OPENCODE_AUTH_PATH = resolve(
  homedir(),
  ".local",
  "share",
  "opencode",
  "auth.json",
);

const ACP_PROVIDER_FAMILY_OPTIONS = [
  {
    id: DEFAULT_ACP_MODEL,
    label: "Default",
  },
  {
    id: "openrouter/default",
    label: "OpenRouter",
  },
  {
    id: "opencode-go/default",
    label: "OpenCode Go",
  },
  {
    id: "opencode/default",
    label: "OpenCode Zen",
  },
  {
    id: getCustomOpenAiCompatibleProviderModel(),
    label: getCustomOpenAiCompatibleProviderLabel(),
  },
] as const;

const ACP_PROVIDER_FAMILY_LABELS: Record<string, string> = {
  openrouter: "OpenRouter",
  opencode: "OpenCode Zen",
  "opencode-go": "OpenCode Go",
  "openai-compatible": getCustomOpenAiCompatibleProviderLabel(),
};

const PI_AUTH_KEYS = ["openrouter", "opencode", "opencode-go"] as const;
const PI_RELEVANT_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENCODE_API_KEY",
] as const;
const OPENCODE_RELEVANT_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENCODE_API_KEY",
] as const;

function readJsonRecord(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function hasEnvVar(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

function hasAuthKey(
  authRecord: Record<string, unknown> | null,
  key: string,
): boolean {
  return Boolean(authRecord && Object.prototype.hasOwnProperty.call(authRecord, key));
}

function getRequestedProviderFamily(
  model: DesktopModel | null | undefined,
): string | null {
  const normalized = model?.trim();
  if (!normalized || normalized === DEFAULT_ACP_MODEL) {
    return null;
  }

  if (normalized === "openrouter/default" || normalized.startsWith("openrouter/")) {
    return "openrouter";
  }
  if (normalized === "opencode-go/default" || normalized.startsWith("opencode-go/")) {
    return "opencode-go";
  }
  if (normalized === "opencode/default" || normalized.startsWith("opencode/")) {
    return "opencode";
  }
  if (
    normalized === getCustomOpenAiCompatibleProviderModel() ||
    normalized.startsWith("openai-compatible/")
  ) {
    return "openai-compatible";
  }

  return null;
}

function getFamilyLabel(family: string | null): string {
  return family ? (ACP_PROVIDER_FAMILY_LABELS[family] ?? family) : "Configured providers";
}

export function getAcpProviderModels(provider: DesktopProvider): DesktopModelOption[] {
  return ACP_PROVIDER_FAMILY_OPTIONS.map((option) => ({
    ...option,
    provider,
  }));
}

export function normalizeAcpProviderModel(
  value: string | null | undefined,
): DesktopModel {
  const normalized = value?.trim();
  if (!normalized) {
    return DEFAULT_ACP_MODEL;
  }

  return ACP_PROVIDER_FAMILY_OPTIONS.some((option) => option.id === normalized)
    ? normalized
    : DEFAULT_ACP_MODEL;
}

export function getPiAuthState(model?: DesktopModel): DesktopAuthState {
  const requestedFamily = getRequestedProviderFamily(model);
  const authRecord = readJsonRecord(HOST_PI_AUTH_PATH);
  const missingSuffix = requestedFamily ? ` for ${getFamilyLabel(requestedFamily)}` : "";

  if (requestedFamily === "openrouter") {
    if (hasAuthKey(authRecord, "openrouter") || hasEnvVar("OPENROUTER_API_KEY")) {
      return {
        provider: "pi",
        available: true,
        source: "api-key",
        label: "OpenRouter",
      };
    }
  } else if (requestedFamily === "opencode" || requestedFamily === "opencode-go") {
    if (
      hasAuthKey(authRecord, requestedFamily) ||
      hasEnvVar("OPENCODE_API_KEY")
    ) {
      return {
        provider: "pi",
        available: true,
        source: "api-key",
        label: getFamilyLabel(requestedFamily),
      };
    }
  } else if (requestedFamily === "openai-compatible") {
    const config = readCustomOpenAiCompatibleProviderConfig();
    if (config) {
      return {
        provider: "pi",
        available: true,
        source: "api-key",
        label: config.label || getFamilyLabel(requestedFamily),
      };
    }
  } else if (
    existsSync(HOST_PI_AUTH_PATH) ||
    existsSync(HOST_PI_MODELS_PATH) ||
    isCustomOpenAiCompatibleProviderConfigured() ||
    PI_RELEVANT_ENV_VARS.some((name) => hasEnvVar(name))
  ) {
    return {
      provider: "pi",
      available: true,
      source: "api-key",
      label: "Configured providers",
    };
  }

  return {
    provider: "pi",
    available: false,
    source: "missing",
    label: `PI auth missing${missingSuffix}`,
  };
}

export function getOpenCodeAuthState(model?: DesktopModel): DesktopAuthState {
  const requestedFamily = getRequestedProviderFamily(model);
  const authRecord = readJsonRecord(HOST_OPENCODE_AUTH_PATH);
  const missingSuffix = requestedFamily ? ` for ${getFamilyLabel(requestedFamily)}` : "";

  if (requestedFamily === "openrouter") {
    if (hasAuthKey(authRecord, "openrouter") || hasEnvVar("OPENROUTER_API_KEY")) {
      return {
        provider: "opencode",
        available: true,
        source: "api-key",
        label: "OpenRouter",
      };
    }
  } else if (requestedFamily === "opencode" || requestedFamily === "opencode-go") {
    if (
      hasAuthKey(authRecord, requestedFamily) ||
      hasEnvVar("OPENCODE_API_KEY")
    ) {
      return {
        provider: "opencode",
        available: true,
        source: "api-key",
        label: getFamilyLabel(requestedFamily),
      };
    }
  } else if (requestedFamily === "openai-compatible") {
    const config = readCustomOpenAiCompatibleProviderConfig();
    if (config) {
      return {
        provider: "opencode",
        available: true,
        source: "api-key",
        label: config.label || getFamilyLabel(requestedFamily),
      };
    }
  } else if (
    existsSync(HOST_OPENCODE_AUTH_PATH) ||
    isCustomOpenAiCompatibleProviderConfigured() ||
    OPENCODE_RELEVANT_ENV_VARS.some((name) => hasEnvVar(name))
  ) {
    return {
      provider: "opencode",
      available: true,
      source: "api-key",
      label: "OpenCode credentials",
    };
  }

  return {
    provider: "opencode",
    available: false,
    source: "missing",
    label: `OpenCode auth missing${missingSuffix}`,
  };
}
