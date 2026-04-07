import type {
  DesktopAuthState,
  DesktopModel,
  DesktopModelOption,
  DesktopProvider,
  DesktopProviderOption,
} from "../../desktop/shared/protocol";

export interface DesktopProviderDefinition {
  id: DesktopProvider;
  label: string;
  transport: "container-acpx";
  option: DesktopProviderOption;
  getDefaultModel(): DesktopModel;
  getAvailableModels(): DesktopModelOption[];
  normalizeModel(value: string | null | undefined): DesktopModel;
  getAuthState(model?: DesktopModel): DesktopAuthState;
  getImageName(): string;
  buildRuntimeEnv(model: DesktopModel): Record<string, string>;
}
