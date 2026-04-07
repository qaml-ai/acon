import {
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { DesktopService } from "../../desktop-container/backend/service";

const HOST_MCP_ERROR_TEST_SERVER_ID = "integration-host-tools-error";

function createHostMcpErrorServer(): Server {
  const server = new Server(
    {
      name: HOST_MCP_ERROR_TEST_SERVER_ID,
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {
          listChanged: false,
        },
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    throw new Error("Host MCP tools/list failed intentionally for integration testing.");
  });

  return server;
}

export function configureHostMcp(service: DesktopService): void {
  service.registerHostMcpServer({
    id: HOST_MCP_ERROR_TEST_SERVER_ID,
    createServer: createHostMcpErrorServer,
  });
}

export default configureHostMcp;
