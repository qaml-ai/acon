import type {
  DesktopAuthState,
  DesktopModel,
  DesktopModelOption,
} from "../../desktop/shared/protocol";
import { codexProvider as legacyCodexProvider } from "../../desktop/backend/codex";
import type { DesktopProviderDefinition } from "./provider-types";

const DEFAULT_CODEX_IMAGE =
  process.env.DESKTOP_CONTAINER_CODEX_IMAGE?.trim() ||
  "acon-desktop-codex:0.2";
const DEFAULT_CODEX_MODEL = "gpt-5.4";

function getAvailableCodexModels(): DesktopModelOption[] {
  return [
    {
      id: DEFAULT_CODEX_MODEL,
      label: "GPT-5.4",
      provider: "codex",
    },
  ];
}

function getCodexAuthState(): DesktopAuthState {
  return legacyCodexProvider.getAuthState();
}

export const codexProvider: DesktopProviderDefinition = {
  id: "codex",
  label: "Codex",
  transport: "container-acpx",
  option: {
    id: "codex",
    label: "Codex",
  },
  getDefaultModel() {
    return DEFAULT_CODEX_MODEL;
  },
  getAvailableModels: getAvailableCodexModels,
  normalizeModel(value) {
    return value?.trim() === DEFAULT_CODEX_MODEL
      ? DEFAULT_CODEX_MODEL
      : DEFAULT_CODEX_MODEL;
  },
  getAuthState() {
    return getCodexAuthState();
  },
  getImageName() {
    return DEFAULT_CODEX_IMAGE;
  },
  buildRuntimeEnv(model) {
    const env: Record<string, string> = {
      DESKTOP_PROVIDER: "codex",
      DESKTOP_MODEL: model,
      DESKTOP_CODEX_MODEL: model,
    };

    const openAiApiKey = process.env.OPENAI_API_KEY?.trim();
    if (openAiApiKey) {
      env.OPENAI_API_KEY = openAiApiKey;
    }

    return env;
  },
};
