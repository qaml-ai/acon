import { resolve } from "node:path";
import {
  createStdioProxyHostMcpServer,
  type HostMcpServerRegistration,
} from "../../desktop-container/backend/host-mcp";
import type { DesktopService } from "../../desktop-container/backend/service";

const HOST_MCP_STDIO_TEST_SERVER_ID = "integration-stdio-host-tools";

function createRegistration(): HostMcpServerRegistration {
  return {
    id: HOST_MCP_STDIO_TEST_SERVER_ID,
    createServer: () =>
      createStdioProxyHostMcpServer(
        {
          command: process.execPath,
          args: [
            "--import",
            "tsx/esm",
            resolve(process.cwd(), "tests/fixtures/simple-stdio-mcp-server.ts"),
          ],
          cwd: process.cwd(),
          env: {
            ...process.env,
          },
          stderr: "pipe",
        },
        {
          name: HOST_MCP_STDIO_TEST_SERVER_ID,
          version: "1.0.0",
        },
      ),
  };
}

export function configureHostMcp(service: DesktopService): void {
  service.registerHostMcpServer(createRegistration());
}

export default configureHostMcp;
