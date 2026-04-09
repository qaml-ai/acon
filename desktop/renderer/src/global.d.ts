import type {
  DesktopClientEvent,
  DesktopShellCommand,
  DesktopPluginInstallResult,
  DesktopServerEvent,
  DesktopSnapshot,
} from '../../shared/protocol';

interface DesktopShellApi {
  platform: string;
  versions: {
    chrome: string;
    electron: string;
    node: string;
  };
  getSnapshot: () => Promise<DesktopSnapshot | null>;
  installPlugin?: () => Promise<DesktopPluginInstallResult>;
  openPluginDirectory?: () => Promise<string>;
  resolveWebviewSrc?: (entrypoint: string) => Promise<string>;
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
