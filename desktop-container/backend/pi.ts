import {
  DEFAULT_ACP_MODEL,
  DEFAULT_ACP_MODEL_SOURCE,
  getAcpProviderModels,
  getAcpProviderModelSources,
  getPiAuthState,
  normalizeAcpProviderModel,
  normalizeAcpProviderModelSource,
} from "./acp-provider-shared";
import type { DesktopProviderDefinition } from "./provider-types";

const DEFAULT_PI_IMAGE =
  process.env.DESKTOP_CONTAINER_AGENT_IMAGE?.trim() ||
  process.env.DESKTOP_CONTAINER_ACPX_IMAGE?.trim() ||
  process.env.DESKTOP_CONTAINER_PI_IMAGE?.trim() ||
  process.env.DESKTOP_CONTAINER_CODEX_IMAGE?.trim() ||
  process.env.DESKTOP_CONTAINER_CLAUDE_IMAGE?.trim() ||
  "acon-desktop-acpx:0.1";

export const piProvider: DesktopProviderDefinition = {
  id: "pi",
  label: "Pi",
  transport: "container-agentd",
  option: {
    id: "pi",
    label: "Pi",
  },
  getDefaultModel() {
    return DEFAULT_ACP_MODEL;
  },
  getAvailableModels() {
    return getAcpProviderModels("pi");
  },
  normalizeModel(value) {
    return normalizeAcpProviderModel(value);
  },
  getDefaultModelSource() {
    return DEFAULT_ACP_MODEL_SOURCE;
  },
  getAvailableModelSources() {
    return getAcpProviderModelSources("pi");
  },
  normalizeModelSource(value) {
    return normalizeAcpProviderModelSource(value);
  },
  getAuthState(modelSource) {
    return getPiAuthState(modelSource);
  },
  getImageName() {
    return DEFAULT_PI_IMAGE;
  },
};
