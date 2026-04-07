import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "integration-stdio-host-tools",
  version: "1.0.0",
});

server.registerTool(
  "stdio_echo",
  {
    description: "Echo a string from a host stdio MCP server.",
    inputSchema: z.object({
      provider: z.string(),
      text: z.string(),
    }),
    outputSchema: z.object({
      echoedText: z.string(),
      provider: z.string(),
      transport: z.literal("stdio"),
    }),
  },
  async ({ provider, text }) => ({
    content: [
      {
        type: "text",
        text: `stdio:${provider}:${text}`,
      },
    ],
    structuredContent: {
      echoedText: text,
      provider,
      transport: "stdio",
    },
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
