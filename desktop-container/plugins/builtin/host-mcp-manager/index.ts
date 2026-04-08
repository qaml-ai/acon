import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CamelAIExtensionModule } from "../../../sdk";

const HOST_MCP_MANAGER_ID = "host-mcp-manager";

const listInstalledServersOutputSchema = z.object({
  servers: z.array(
    z.object({
      id: z.string(),
      transport: z.literal("stdio"),
      command: z.string(),
      args: z.array(z.string()),
      cwd: z.string().nullable(),
      env: z.record(z.string(), z.string()),
      name: z.string().nullable(),
      version: z.string().nullable(),
    }),
  ),
});

const installServerInputSchema = z.object({
  id: z.string(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  cwd: z.string().nullable().optional(),
  env: z.record(z.string(), z.string()).optional(),
  name: z.string().nullable().optional(),
  version: z.string().nullable().optional(),
});

const installServerOutputSchema = z.object({
  id: z.string(),
  transport: z.literal("stdio"),
  command: z.string(),
  args: z.array(z.string()),
  cwd: z.string().nullable(),
  env: z.record(z.string(), z.string()),
  name: z.string().nullable(),
  version: z.string().nullable(),
  configPath: z.string(),
  replaced: z.boolean(),
});

const uninstallServerInputSchema = z.object({
  id: z.string(),
});

const uninstallServerOutputSchema = z.object({
  id: z.string(),
  removed: z.boolean(),
});

const extension: CamelAIExtensionModule = {
  activate(api) {
    api.registerHostMcpServer({
      id: HOST_MCP_MANAGER_ID,
      createServer: () => {
        const server = new McpServer({
          name: HOST_MCP_MANAGER_ID,
          version: "1.0.0",
        });

        server.registerTool(
          "list_installed_servers",
          {
            description:
              "List host MCP servers previously installed into the desktop app host registry.",
            outputSchema: listInstalledServersOutputSchema,
          },
          async () => {
            const servers = api.listInstalledHostMcpServers();
            return {
              content: [
                {
                  type: "text",
                  text:
                    servers.length > 0
                      ? `Installed host MCP servers: ${servers.map((entry) => entry.id).join(", ")}`
                      : "No host MCP servers are installed in the desktop app registry.",
                },
              ],
              structuredContent: {
                servers,
              },
            };
          },
        );

        server.registerTool(
          "install_stdio_server",
          {
            description:
              "Install or replace a stdio MCP server in the desktop app host registry so the guest can use it through acon-mcp.",
            inputSchema: installServerInputSchema,
            outputSchema: installServerOutputSchema,
          },
          async (input) => {
            const installed = api.installStdioHostMcpServer(input);
            return {
              content: [
                {
                  type: "text",
                  text: installed.replaced
                    ? `Updated host MCP server ${installed.id}.`
                    : `Installed host MCP server ${installed.id}.`,
                },
              ],
              structuredContent: installed,
            };
          },
        );

        server.registerTool(
          "uninstall_server",
          {
            description:
              "Remove a host MCP server that was previously installed into the desktop app host registry.",
            inputSchema: uninstallServerInputSchema,
            outputSchema: uninstallServerOutputSchema,
          },
          async ({ id }) => {
            if (id.trim() === HOST_MCP_MANAGER_ID) {
              throw new Error("The host MCP manager cannot uninstall itself.");
            }

            const removed = api.uninstallInstalledHostMcpServer(id);
            return {
              content: [
                {
                  type: "text",
                  text: removed
                    ? `Removed host MCP server ${id}.`
                    : `Host MCP server ${id} was not installed.`,
                },
              ],
              structuredContent: {
                id,
                removed,
              },
            };
          },
        );

        return server;
      },
    });
  },
};

export default extension;
