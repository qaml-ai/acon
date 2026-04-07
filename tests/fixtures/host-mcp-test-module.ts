import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DesktopService } from "../../desktop-container/backend/service";

const HOST_MCP_TEST_SERVER_ID = "integration-host-tools";

function createHostMcpTestServer(): McpServer {
  const server = new McpServer({
    name: HOST_MCP_TEST_SERVER_ID,
    version: "1.0.0",
  });

  server.registerTool(
    "host_echo",
    {
      description: "Echo a string via the host MCP registry.",
      inputSchema: z.object({
        provider: z.string(),
        text: z.string(),
      }),
      outputSchema: z.object({
        echoedText: z.string(),
        provider: z.string(),
      }),
    },
    async ({ provider, text }) => ({
      content: [
        {
          type: "text",
          text: `echo:${provider}:${text}`,
        },
      ],
      structuredContent: {
        echoedText: text,
        provider,
      },
    }),
  );

  return server;
}

export function configureHostMcp(service: DesktopService): void {
  service.registerHostMcpServer({
    id: HOST_MCP_TEST_SERVER_ID,
    createServer: createHostMcpTestServer,
  });
}

export default configureHostMcp;
