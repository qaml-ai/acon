import type {
  DesktopAuthState,
  DesktopModel,
  DesktopModelOption,
} from "../../desktop/shared/protocol";
import { claudeProvider as legacyClaudeProvider } from "../../desktop/backend/anthropic";
import type { DesktopProviderDefinition } from "./provider-types";

const DEFAULT_CLAUDE_IMAGE =
  process.env.DESKTOP_CONTAINER_ACPX_IMAGE?.trim() ||
  process.env.DESKTOP_CONTAINER_CLAUDE_IMAGE?.trim() ||
  process.env.DESKTOP_CONTAINER_CODEX_IMAGE?.trim() ||
  "acon-desktop-acpx:0.1";
const DEFAULT_CLAUDE_MODEL = "sonnet";
const CLAUDE_MODELS = [
  {
    id: "sonnet",
    label: "Claude Sonnet",
    provider: "claude",
  },
  {
    id: "opus",
    label: "Claude Opus",
    provider: "claude",
  },
] as const satisfies DesktopModelOption[];

function getAvailableClaudeModels(): DesktopModelOption[] {
  return [...CLAUDE_MODELS];
}

function getClaudeAuthState(): DesktopAuthState {
  return legacyClaudeProvider.getAuthState();
}

export const claudeProvider: DesktopProviderDefinition = {
  id: "claude",
  label: "Claude",
  transport: "container-acpx",
  option: {
    id: "claude",
    label: "Claude",
  },
  getDefaultModel() {
    return DEFAULT_CLAUDE_MODEL;
  },
  getAvailableModels: getAvailableClaudeModels,
  normalizeModel(value) {
    const normalized = value?.trim();
    return CLAUDE_MODELS.some((option) => option.id === normalized)
      ? (normalized as DesktopModel)
      : DEFAULT_CLAUDE_MODEL;
  },
  getAuthState() {
    return getClaudeAuthState();
  },
  getImageName() {
    return DEFAULT_CLAUDE_IMAGE;
  },
  buildRuntimeEnv(model) {
    const env: Record<string, string> = {
      DESKTOP_PROVIDER: "claude",
      DESKTOP_MODEL: model,
      DESKTOP_ANTHROPIC_MODEL: model,
    };

    const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (anthropicApiKey) {
      env.ANTHROPIC_API_KEY = anthropicApiKey;
    }

    return env;
  },
};
