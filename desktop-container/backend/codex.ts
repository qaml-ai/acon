import type {
  DesktopAuthState,
  DesktopModel,
  DesktopModelOption,
  DesktopModelSourceOption,
} from "../../desktop/shared/protocol";
import { codexProvider as legacyCodexProvider } from "../../desktop/backend/codex";
import type { DesktopProviderDefinition } from "./provider-types";

const DEFAULT_CODEX_IMAGE =
  process.env.DESKTOP_CONTAINER_AGENT_IMAGE?.trim() ||
  process.env.DESKTOP_CONTAINER_ACPX_IMAGE?.trim() ||
  process.env.DESKTOP_CONTAINER_CODEX_IMAGE?.trim() ||
  process.env.DESKTOP_CONTAINER_CLAUDE_IMAGE?.trim() ||
  "acon-desktop-acpx:0.1";
const DEFAULT_CODEX_MODEL = "gpt-5.4";
const DEFAULT_CODEX_MODEL_SOURCE = "default";

function getAvailableCodexModels(): DesktopModelOption[] {
  return [
    {
      id: DEFAULT_CODEX_MODEL,
      label: "GPT-5.4",
      provider: "codex",
    },
  ];
}

function getAvailableCodexModelSources(): DesktopModelSourceOption[] {
  return [
    {
      id: DEFAULT_CODEX_MODEL_SOURCE,
      label: "Default",
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
  transport: "container-agentd",
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
  getDefaultModelSource() {
    return DEFAULT_CODEX_MODEL_SOURCE;
  },
  getAvailableModelSources: getAvailableCodexModelSources,
  normalizeModelSource() {
    return DEFAULT_CODEX_MODEL_SOURCE;
  },
  getAuthState() {
    return getCodexAuthState();
  },
  getImageName() {
    return DEFAULT_CODEX_IMAGE;
  },
};
