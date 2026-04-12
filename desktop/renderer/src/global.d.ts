import type {
  DesktopClientEvent,
  DesktopCustomOpenAiCompatibleProviderConfig,
  DesktopSaveCustomOpenAiCompatibleProviderConfigInput,
  DesktopShellCommand,
  DesktopPluginInstallResult,
  DesktopServerEvent,
  DesktopSnapshot,
} from '../../shared/protocol';
import type { PreviewTarget } from '../../../src/types';

interface DesktopShellApi {
  platform: string;
  versions: {
    chrome: string;
    electron: string;
    node: string;
  };
  getSnapshot: () => Promise<DesktopSnapshot | null>;
  pickLocalFiles?: () => Promise<string[]>;
  importLocalFiles?: (
    paths: string[],
  ) => Promise<
    Array<{
      originalName: string;
      relativePath: string;
      absolutePath: string;
      size: number;
    }>
  >;
  importFilePayloads?: (
    payloads: Array<{
      name: string;
      bytes: ArrayBuffer;
    }>,
  ) => Promise<
    Array<{
      originalName: string;
      relativePath: string;
      absolutePath: string;
      size: number;
    }>
  >;
  downloadFile?: (request: {
    source: "workspace" | "upload" | "output";
    path: string;
    filename?: string | null;
  }) => Promise<{
    canceled: boolean;
    destinationPath: string | null;
  }>;
  resolvePreviewSrc?: (target: PreviewTarget) => Promise<string | null>;
  installPlugin?: () => Promise<DesktopPluginInstallResult>;
  openPluginDirectory?: () => Promise<string>;
  resolveWebviewSrc?: (entrypoint: string) => Promise<string>;
  getCustomOpenAiCompatibleProviderConfig?: () => Promise<
    DesktopCustomOpenAiCompatibleProviderConfig | null
  >;
  saveCustomOpenAiCompatibleProviderConfig?: (
    config: DesktopSaveCustomOpenAiCompatibleProviderConfigInput,
  ) => Promise<DesktopCustomOpenAiCompatibleProviderConfig>;
  clearCustomOpenAiCompatibleProviderConfig?: () => Promise<void>;
  sendEvent: (event: DesktopClientEvent) => void;
  reportReady: (payload: {
    activeThreadId: string | null;
    provider: DesktopSnapshot['provider'];
    authSource: DesktopSnapshot['auth']['source'];
    hasAuth: boolean;
    runtimeState: DesktopSnapshot['runtimeStatus']['state'];
  }) => void;
  onEvent: (listener: (event: DesktopServerEvent) => void) => () => void;
  onCommand?: (listener: (command: DesktopShellCommand) => void) => () => void;
}

declare global {
  interface Window {
    desktopShell?: DesktopShellApi;
  }
}

export {};
