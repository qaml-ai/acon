import { ContainerRuntimeManager, type RuntimeManager } from "./container-runtime";
import { RemoteRuntimeManager, type RemoteRuntimeManagerOptions } from "./remote-runtime";

export type { RuntimeManager } from "./container-runtime";

export interface RuntimeManagerOptions extends RemoteRuntimeManagerOptions {}

export function createRuntimeManager(
  options: RuntimeManagerOptions = {},
): RuntimeManager {
  const mode = process.env.DESKTOP_RUNTIME_MODE?.trim().toLowerCase();
  const remoteUrl = process.env.DESKTOP_REMOTE_RUNTIME_URL?.trim();
  const runtimeProviderId = process.env.DESKTOP_RUNTIME_PROVIDER?.trim();

  if (mode === "remote") {
    return new RemoteRuntimeManager(options);
  }

  if (mode === "container" || mode === "local") {
    return new ContainerRuntimeManager();
  }

  if (remoteUrl || runtimeProviderId) {
    return new RemoteRuntimeManager(options);
  }

  return new ContainerRuntimeManager();
}
