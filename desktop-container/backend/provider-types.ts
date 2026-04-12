import type {
  DesktopAuthState,
  DesktopModel,
  DesktopModelOption,
  DesktopModelSource,
  DesktopModelSourceOption,
  DesktopProvider,
  DesktopProviderOption,
} from "../../desktop/shared/protocol";

export interface DesktopProviderDefinition {
  id: DesktopProvider;
  label: string;
  transport: "container-agentd";
  option: DesktopProviderOption;
  getDefaultModel(): DesktopModel;
  getAvailableModels(): DesktopModelOption[];
  normalizeModel(value: string | null | undefined): DesktopModel;
  getDefaultModelSource(): DesktopModelSource;
  getAvailableModelSources(): DesktopModelSourceOption[];
  normalizeModelSource(value: string | null | undefined): DesktopModelSource;
  getAuthState(modelSource?: DesktopModelSource): DesktopAuthState;
  getImageName(): string;
}
