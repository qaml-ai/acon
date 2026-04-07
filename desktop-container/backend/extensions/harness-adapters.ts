import type {
  DesktopHarness,
  DesktopProvider,
} from "../../../desktop/shared/protocol";

export interface CamelAIHarnessAdapterInfo {
  id: DesktopHarness;
  label: string;
}

const HARNESS_ADAPTERS: CamelAIHarnessAdapterInfo[] = [
  { id: "codex", label: "Codex" },
  { id: "claude-code", label: "Claude Code" },
  { id: "opencode", label: "OpenCode" },
];

export function getHarnessAdapters(): CamelAIHarnessAdapterInfo[] {
  return [...HARNESS_ADAPTERS];
}

export function getHarnessAdapterForProvider(
  provider: DesktopProvider,
): CamelAIHarnessAdapterInfo {
  switch (provider) {
    case "codex":
      return HARNESS_ADAPTERS[0];
    case "claude":
      return HARNESS_ADAPTERS[1];
  }
}
