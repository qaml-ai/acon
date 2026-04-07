import { DesktopService } from "./service";
export type { HostMcpServerRegistration } from "./host-mcp";

export { DesktopService };

export function createDesktopService(): DesktopService {
  return new DesktopService();
}
