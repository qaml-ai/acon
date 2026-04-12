import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import type {
  DesktopCustomOpenAiCompatibleMaxTokensField as CustomOpenAiCompatibleMaxTokensField,
  DesktopCustomOpenAiCompatibleProviderConfig as CustomOpenAiCompatibleProviderConfig,
  DesktopSaveCustomOpenAiCompatibleProviderConfigInput as SaveCustomOpenAiCompatibleProviderConfigInput,
} from "../../desktop/shared/protocol";
import type { CamelAIResolvedProcessEnvMap } from "./extensions/types";
import {
  getPersistedHostSecret,
  setPersistedHostSecret,
} from "./host-secrets";

const DEFAULT_RUNTIME_DIRECTORY = resolve(
  process.cwd(),
  "desktop-container/.local/runtime",
);
const DEFAULT_DATA_DIRECTORY = resolve(
  process.cwd(),
  "desktop-container/.local/data",
);

const CUSTOM_PROVIDER_DIRECTORY = "provider-settings";
const CUSTOM_PROVIDER_FILENAME = "openai-compatible.json";
const CUSTOM_PROVIDER_ID = "openai-compatible";
const CUSTOM_PROVIDER_LABEL = "Custom OpenAI-Compatible";
const CUSTOM_PROVIDER_SECRET_ENV = "ACON_OPENAI_COMPATIBLE_API_KEY";
const CUSTOM_PROVIDER_VERSION_ENV = "ACON_OPENAI_COMPATIBLE_CONFIG_VERSION";
const CUSTOM_PROVIDER_SECRET_REF = "openai-compatible-provider-api-key";

interface PersistedCustomOpenAiCompatibleProviderConfig {
  version: string;
  label: string | null;
  baseUrl: string;
  modelId: string;
  modelName: string | null;
  headers: Record<string, string>;
  reasoning: boolean;
  imageInput: boolean;
  contextWindow: number | null;
  maxTokens: number | null;
  supportsDeveloperRole: boolean | null;
  supportsReasoningEffort: boolean | null;
  maxTokensField: CustomOpenAiCompatibleMaxTokensField | null;
}

function getRuntimeDirectory(runtimeDirectory = process.env.DESKTOP_RUNTIME_DIR): string {
  return runtimeDirectory?.trim() || DEFAULT_RUNTIME_DIRECTORY;
}

function getDataDirectory(dataDirectory = process.env.DESKTOP_DATA_DIR): string {
  return dataDirectory?.trim() || DEFAULT_DATA_DIRECTORY;
}

function getConfigFilePath(dataDirectory = getDataDirectory()): string {
  return resolve(
    dataDirectory,
    CUSTOM_PROVIDER_DIRECTORY,
    CUSTOM_PROVIDER_FILENAME,
  );
}

function ensureParentDirectory(path: string): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
}

function readJsonFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function writeJsonFile(path: string, value: unknown): void {
  ensureParentDirectory(path);
  writeFileSync(`${path}`, JSON.stringify(value, null, 2), "utf8");
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeBaseUrl(value: unknown): string {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    throw new Error("Base URL is required.");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Base URL must be a valid absolute URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Base URL must use http or https.");
  }

  const normalized = parsed.toString();
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function normalizeRequiredId(value: unknown, label: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function normalizeHeaders(
  value: unknown,
): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const headers: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.trim();
    if (!normalizedKey || typeof rawValue !== "string") {
      continue;
    }
    const normalizedValue = rawValue.trim();
    if (!normalizedValue) {
      continue;
    }
    headers[normalizedKey] = normalizedValue;
  }
  return headers;
}

function normalizeOptionalPositiveInteger(value: unknown): number | null {
  if (value == null || value === "") {
    return null;
  }
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error("Numeric limits must be positive integers.");
  }
  return Math.trunc(numeric);
}

function normalizeOptionalBoolean(value: unknown): boolean | null {
  if (value == null) {
    return null;
  }
  return value === true;
}

function normalizeMaxTokensField(
  value: unknown,
): CustomOpenAiCompatibleMaxTokensField | null {
  if (value == null || value === "") {
    return null;
  }
  if (value === "max_completion_tokens" || value === "max_tokens") {
    return value;
  }
  throw new Error(
    'Max tokens field must be "max_completion_tokens" or "max_tokens".',
  );
}

function normalizePersistedConfig(
  value: unknown,
): PersistedCustomOpenAiCompatibleProviderConfig | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  try {
    return {
      version: normalizeRequiredId(record.version, "Config version"),
      label: normalizeOptionalString(record.label),
      baseUrl: normalizeBaseUrl(record.baseUrl),
      modelId: normalizeRequiredId(record.modelId, "Model ID"),
      modelName: normalizeOptionalString(record.modelName),
      headers: normalizeHeaders(record.headers),
      reasoning: record.reasoning === true,
      imageInput: record.imageInput === true,
      contextWindow: normalizeOptionalPositiveInteger(record.contextWindow),
      maxTokens: normalizeOptionalPositiveInteger(record.maxTokens),
      supportsDeveloperRole: normalizeOptionalBoolean(
        record.supportsDeveloperRole,
      ),
      supportsReasoningEffort: normalizeOptionalBoolean(
        record.supportsReasoningEffort,
      ),
      maxTokensField: normalizeMaxTokensField(record.maxTokensField),
    };
  } catch {
    return null;
  }
}

function buildPersistedConfig(
  input: SaveCustomOpenAiCompatibleProviderConfigInput,
): PersistedCustomOpenAiCompatibleProviderConfig {
  return {
    version: randomUUID(),
    label: normalizeOptionalString(input.label),
    baseUrl: normalizeBaseUrl(input.baseUrl),
    modelId: normalizeRequiredId(input.modelId, "Model ID"),
    modelName: normalizeOptionalString(input.modelName),
    headers: normalizeHeaders(input.headers),
    reasoning: input.reasoning === true,
    imageInput: input.imageInput === true,
    contextWindow: normalizeOptionalPositiveInteger(input.contextWindow),
    maxTokens: normalizeOptionalPositiveInteger(input.maxTokens),
    supportsDeveloperRole: normalizeOptionalBoolean(
      input.supportsDeveloperRole,
    ),
    supportsReasoningEffort: normalizeOptionalBoolean(
      input.supportsReasoningEffort,
    ),
    maxTokensField: normalizeMaxTokensField(input.maxTokensField),
  };
}

function buildPiProviderConfig(
  config: PersistedCustomOpenAiCompatibleProviderConfig,
  hasApiKey: boolean,
): Record<string, unknown> {
  const providerCompat: Record<string, unknown> = {};
  if (config.supportsDeveloperRole !== null) {
    providerCompat.supportsDeveloperRole = config.supportsDeveloperRole;
  }
  if (config.supportsReasoningEffort !== null) {
    providerCompat.supportsReasoningEffort = config.supportsReasoningEffort;
  }
  if (config.maxTokensField) {
    providerCompat.maxTokensField = config.maxTokensField;
  }

  const modelRecord: Record<string, unknown> = {
    id: config.modelId,
    reasoning: config.reasoning,
    input: config.imageInput ? ["text", "image"] : ["text"],
  };
  if (config.modelName) {
    modelRecord.name = config.modelName;
  }
  if (config.contextWindow) {
    modelRecord.contextWindow = config.contextWindow;
  }
  if (config.maxTokens) {
    modelRecord.maxTokens = config.maxTokens;
  }
  if (Object.keys(providerCompat).length > 0) {
    modelRecord.compat = providerCompat;
  }

  const providerRecord: Record<string, unknown> = {
    baseUrl: config.baseUrl,
    api: "openai-completions",
    apiKey: hasApiKey ? CUSTOM_PROVIDER_SECRET_ENV : "acon",
    models: [modelRecord],
  };
  if (Object.keys(config.headers).length > 0) {
    providerRecord.headers = config.headers;
  }
  if (Object.keys(providerCompat).length > 0) {
    providerRecord.compat = providerCompat;
  }
  return providerRecord;
}

function buildOpenCodeProviderConfig(
  config: PersistedCustomOpenAiCompatibleProviderConfig,
  hasApiKey: boolean,
): Record<string, unknown> {
  const modelOptions: Record<string, unknown> = {};
  if (config.modelName) {
    modelOptions.name = config.modelName;
  }
  if (config.contextWindow || config.maxTokens) {
    modelOptions.limit = {
      ...(config.contextWindow ? { context: config.contextWindow } : {}),
      ...(config.maxTokens ? { output: config.maxTokens } : {}),
    };
  }

  const options: Record<string, unknown> = {
    baseURL: config.baseUrl,
  };
  if (hasApiKey) {
    options.apiKey = `{env:${CUSTOM_PROVIDER_SECRET_ENV}}`;
  }
  if (Object.keys(config.headers).length > 0) {
    options.headers = config.headers;
  }

  return {
    npm: "@ai-sdk/openai-compatible",
    name: config.label || CUSTOM_PROVIDER_LABEL,
    options,
    models: {
      [config.modelId]: modelOptions,
    },
  };
}

function getPiModelsPath(runtimeDirectory = getRuntimeDirectory()): string {
  return resolve(runtimeDirectory, "providers", "pi", "home", ".pi", "agent", "models.json");
}

function getOpenCodeConfigPath(runtimeDirectory = getRuntimeDirectory()): string {
  return resolve(
    runtimeDirectory,
    "providers",
    "opencode",
    "home",
    ".config",
    "opencode",
    "opencode.json",
  );
}

function syncPiConfig(
  runtimeDirectory: string,
  config: PersistedCustomOpenAiCompatibleProviderConfig | null,
  hasApiKey: boolean,
): void {
  const path = getPiModelsPath(runtimeDirectory);
  const current = readJsonFile(path) ?? {};
  const providers =
    current.providers && typeof current.providers === "object"
      ? { ...(current.providers as Record<string, unknown>) }
      : {};

  if (config) {
    providers[CUSTOM_PROVIDER_ID] = buildPiProviderConfig(config, hasApiKey);
  } else {
    delete providers[CUSTOM_PROVIDER_ID];
  }

  const next =
    Object.keys(providers).length > 0
      ? { ...current, providers }
      : Object.fromEntries(
          Object.entries(current).filter(([key]) => key !== "providers"),
        );
  writeJsonFile(path, next);
}

function syncOpenCodeConfig(
  runtimeDirectory: string,
  config: PersistedCustomOpenAiCompatibleProviderConfig | null,
  hasApiKey: boolean,
): void {
  const path = getOpenCodeConfigPath(runtimeDirectory);
  const current = readJsonFile(path) ?? {};
  const provider =
    current.provider && typeof current.provider === "object"
      ? { ...(current.provider as Record<string, unknown>) }
      : {};

  if (config) {
    provider[CUSTOM_PROVIDER_ID] = buildOpenCodeProviderConfig(config, hasApiKey);
  } else {
    delete provider[CUSTOM_PROVIDER_ID];
  }

  const next =
    Object.keys(provider).length > 0
      ? { ...current, provider }
      : Object.fromEntries(
          Object.entries(current).filter(([key]) => key !== "provider"),
        );
  writeJsonFile(path, next);
}

function syncHarnessConfigs(
  runtimeDirectory: string,
  config: PersistedCustomOpenAiCompatibleProviderConfig | null,
  hasApiKey: boolean,
): void {
  syncPiConfig(runtimeDirectory, config, hasApiKey);
  syncOpenCodeConfig(runtimeDirectory, config, hasApiKey);
}

export function getCustomOpenAiCompatibleProviderId(): string {
  return CUSTOM_PROVIDER_ID;
}

export function getCustomOpenAiCompatibleProviderModel(): string {
  return `${CUSTOM_PROVIDER_ID}/default`;
}

export function getCustomOpenAiCompatibleProviderLabel(): string {
  return CUSTOM_PROVIDER_LABEL;
}

export function getCustomOpenAiCompatibleSecretEnvName(): string {
  return CUSTOM_PROVIDER_SECRET_ENV;
}

export function getCustomOpenAiCompatibleSecretRef(): string {
  return CUSTOM_PROVIDER_SECRET_REF;
}

export function readCustomOpenAiCompatibleProviderConfig(
  options: {
    dataDirectory?: string;
  } = {},
): CustomOpenAiCompatibleProviderConfig | null {
  const dataDirectory = getDataDirectory(options.dataDirectory);
  const config = normalizePersistedConfig(readJsonFile(getConfigFilePath(dataDirectory)));
  if (!config) {
    return null;
  }

  return {
    ...config,
    hasApiKey: Boolean(
      getPersistedHostSecret(dataDirectory, CUSTOM_PROVIDER_SECRET_REF),
    ),
  };
}

export function isCustomOpenAiCompatibleProviderConfigured(
  options: {
    dataDirectory?: string;
  } = {},
): boolean {
  return readCustomOpenAiCompatibleProviderConfig(options) !== null;
}

export function saveCustomOpenAiCompatibleProviderConfig(
  input: SaveCustomOpenAiCompatibleProviderConfigInput,
  options: {
    dataDirectory?: string;
    runtimeDirectory?: string;
  } = {},
): CustomOpenAiCompatibleProviderConfig {
  const dataDirectory = getDataDirectory(options.dataDirectory);
  const runtimeDirectory = getRuntimeDirectory(options.runtimeDirectory);
  const config = buildPersistedConfig(input);
  const apiKey = normalizeOptionalString(input.apiKey);
  const existingSecret = getPersistedHostSecret(
    dataDirectory,
    CUSTOM_PROVIDER_SECRET_REF,
  );
  if (apiKey !== null) {
    setPersistedHostSecret(dataDirectory, CUSTOM_PROVIDER_SECRET_REF, apiKey);
  }
  const hasApiKey = Boolean(apiKey ?? existingSecret);
  writeJsonFile(getConfigFilePath(dataDirectory), config);
  syncHarnessConfigs(runtimeDirectory, config, hasApiKey);
  return {
    ...config,
    hasApiKey,
  };
}

export function clearCustomOpenAiCompatibleProviderConfig(
  options: {
    dataDirectory?: string;
    runtimeDirectory?: string;
  } = {},
): void {
  const dataDirectory = getDataDirectory(options.dataDirectory);
  const runtimeDirectory = getRuntimeDirectory(options.runtimeDirectory);
  rmSync(getConfigFilePath(dataDirectory), { force: true });
  setPersistedHostSecret(dataDirectory, CUSTOM_PROVIDER_SECRET_REF, null);
  syncHarnessConfigs(runtimeDirectory, null, false);
}

export function getCustomOpenAiCompatibleProcessEnv(
  provider: "pi" | "opencode",
  options: {
    dataDirectory?: string;
  } = {},
): CamelAIResolvedProcessEnvMap {
  const config = readCustomOpenAiCompatibleProviderConfig(options);
  if (!config) {
    return {};
  }

  const processEnv: CamelAIResolvedProcessEnvMap = {
    [CUSTOM_PROVIDER_VERSION_ENV]: {
      kind: "literal",
      value: `${provider}:${config.version}`,
    },
  };
  const dataDirectory = getDataDirectory(options.dataDirectory);
  const secret = getPersistedHostSecret(dataDirectory, CUSTOM_PROVIDER_SECRET_REF);
  if (secret) {
    processEnv[CUSTOM_PROVIDER_SECRET_ENV] = {
      kind: "literal",
      value: secret,
    };
  }
  return processEnv;
}

export function getCustomOpenAiCompatibleDefaultConfig(): SaveCustomOpenAiCompatibleProviderConfigInput {
  return {
    label: CUSTOM_PROVIDER_LABEL,
    baseUrl: "https://api.example.com/v1",
    modelId: "my-model",
    modelName: null,
    headers: {},
    reasoning: false,
    imageInput: false,
    contextWindow: null,
    maxTokens: null,
    supportsDeveloperRole: null,
    supportsReasoningEffort: null,
    maxTokensField: null,
    apiKey: null,
  };
}
