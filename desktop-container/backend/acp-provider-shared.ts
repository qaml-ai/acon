import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type {
  DesktopAuthState,
  DesktopModel,
  DesktopModelOption,
  DesktopModelSource,
  DesktopModelSourceOption,
  DesktopProvider,
} from "../../desktop/shared/protocol";

export const DEFAULT_ACP_MODEL = "default";
export const DEFAULT_ACP_MODEL_SOURCE = "default";

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
    id: DEFAULT_ACP_MODEL_SOURCE,
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
] as const;

const ACP_PROVIDER_FAMILY_LABELS: Record<string, string> = {
  openrouter: "OpenRouter",
  opencode: "OpenCode Zen",
  "opencode-go": "OpenCode Go",
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

  return null;
}

function getFamilyLabel(family: string | null): string {
  return family ? (ACP_PROVIDER_FAMILY_LABELS[family] ?? family) : "Configured providers";
}

export function getAcpProviderModelSources(
  provider: DesktopProvider,
): DesktopModelSourceOption[] {
  return ACP_PROVIDER_FAMILY_OPTIONS.map((option) => ({
    ...option,
    provider,
  }));
}

function isAcpProviderFamilyModel(value: string): boolean {
  return ACP_PROVIDER_FAMILY_OPTIONS.some((option) => option.id === value);
}

export function normalizeAcpProviderModel(
  value: string | null | undefined,
): DesktopModel {
  const normalized = value?.trim();
  if (!normalized || isAcpProviderFamilyModel(normalized)) {
    return DEFAULT_ACP_MODEL;
  }

  return normalized;
}

export function normalizeAcpProviderModelSource(
  value: string | null | undefined,
): DesktopModelSource {
  const normalized = value?.trim();
  if (!normalized) {
    return DEFAULT_ACP_MODEL_SOURCE;
  }

  return isAcpProviderFamilyModel(normalized)
    ? normalized
    : DEFAULT_ACP_MODEL_SOURCE;
}

function matchesAcpProviderModelSource(
  model: DesktopModel,
  modelSource: DesktopModelSource,
): boolean {
  if (
    !model ||
    model === DEFAULT_ACP_MODEL ||
    modelSource === DEFAULT_ACP_MODEL_SOURCE
  ) {
    return true;
  }
  if (!modelSource.endsWith("/default")) {
    return true;
  }
  const prefix = modelSource.slice(0, -"/default".length);
  return model === prefix || model.startsWith(`${prefix}/`);
}

function formatAcpModelLabel(model: string): string {
  for (const [family, label] of Object.entries(ACP_PROVIDER_FAMILY_LABELS)) {
    if (model === family) {
      return label;
    }
    if (model.startsWith(`${family}/`)) {
      return model.slice(family.length + 1) || label;
    }
  }
  return model;
}

export function getAcpProviderModels(
  provider: DesktopProvider,
  modelSource: DesktopModelSource = DEFAULT_ACP_MODEL_SOURCE,
  discoveredModelIds: readonly string[] = [],
  currentModelId: string | null = null,
): DesktopModelOption[] {
  const normalizedSource = normalizeAcpProviderModelSource(modelSource);
  const currentModelLabel =
    currentModelId && matchesAcpProviderModelSource(currentModelId, normalizedSource)
      ? formatAcpModelLabel(currentModelId)
      : null;
  const discoveredOptions = Array.from(new Set(discoveredModelIds))
    .filter((model): model is string => Boolean(model.trim()))
    .filter((model) => matchesAcpProviderModelSource(model, normalizedSource))
    .map((model) => ({
      id: model,
      label: formatAcpModelLabel(model),
      provider,
    }));

  return [
    {
      id: DEFAULT_ACP_MODEL,
      label: currentModelLabel ? `Auto (${currentModelLabel})` : "Auto",
      provider,
    },
    ...discoveredOptions,
  ];
}

export function getAcpModelPreference(
  model: DesktopModel,
  modelSource: DesktopModelSource,
): DesktopModel {
  return model && model !== DEFAULT_ACP_MODEL
    ? model
    : normalizeAcpProviderModelSource(modelSource);
}

export function isAcpModelInSource(
  model: DesktopModel,
  modelSource: DesktopModelSource,
): boolean {
  return matchesAcpProviderModelSource(model, normalizeAcpProviderModelSource(modelSource));
}

export function getPiAuthState(modelSource?: DesktopModelSource): DesktopAuthState {
  const requestedFamily = getRequestedProviderFamily(modelSource);
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
  } else if (
    existsSync(HOST_PI_AUTH_PATH) ||
    existsSync(HOST_PI_MODELS_PATH) ||
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
    label: `Pi auth missing${missingSuffix}`,
  };
}

export function getOpenCodeAuthState(modelSource?: DesktopModelSource): DesktopAuthState {
  const requestedFamily = getRequestedProviderFamily(modelSource);
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
  } else if (
    existsSync(HOST_OPENCODE_AUTH_PATH) ||
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
