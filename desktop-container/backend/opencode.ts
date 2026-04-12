import {
  DEFAULT_ACP_MODEL,
  DEFAULT_ACP_MODEL_SOURCE,
  getAcpProviderModels,
  getAcpProviderModelSources,
  getOpenCodeAuthState,
  normalizeAcpProviderModel,
  normalizeAcpProviderModelSource,
} from "./acp-provider-shared";
import type { DesktopProviderDefinition } from "./provider-types";

const DEFAULT_OPENCODE_IMAGE =
  process.env.DESKTOP_CONTAINER_AGENT_IMAGE?.trim() ||
  process.env.DESKTOP_CONTAINER_ACPX_IMAGE?.trim() ||
  process.env.DESKTOP_CONTAINER_OPENCODE_IMAGE?.trim() ||
  process.env.DESKTOP_CONTAINER_CODEX_IMAGE?.trim() ||
  process.env.DESKTOP_CONTAINER_CLAUDE_IMAGE?.trim() ||
  "acon-desktop-acpx:0.1";

export const opencodeProvider: DesktopProviderDefinition = {
  id: "opencode",
  label: "OpenCode",
  transport: "container-agentd",
  option: {
    id: "opencode",
    label: "OpenCode",
  },
  getDefaultModel() {
    return DEFAULT_ACP_MODEL;
  },
  getAvailableModels() {
    return getAcpProviderModels("opencode");
  },
  normalizeModel(value) {
    return normalizeAcpProviderModel(value);
  },
  getDefaultModelSource() {
    return DEFAULT_ACP_MODEL_SOURCE;
  },
  getAvailableModelSources() {
    return getAcpProviderModelSources("opencode");
  },
  normalizeModelSource(value) {
    return normalizeAcpProviderModelSource(value);
  },
  getAuthState(modelSource) {
    return getOpenCodeAuthState(modelSource);
  },
  getImageName() {
    return DEFAULT_OPENCODE_IMAGE;
  },
};
