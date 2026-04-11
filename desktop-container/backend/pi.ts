import {
  DEFAULT_ACP_MODEL,
  getAcpProviderModels,
  getPiAuthState,
  normalizeAcpProviderModel,
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
  label: "PI",
  transport: "container-agentd",
  option: {
    id: "pi",
    label: "PI",
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
  getAuthState(model) {
    return getPiAuthState(model);
  },
  getImageName() {
    return DEFAULT_PI_IMAGE;
  },
};
