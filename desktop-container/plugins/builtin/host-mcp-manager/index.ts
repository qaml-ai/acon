import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CamelAIExtensionModule } from "../../../sdk";

const HOST_MCP_MANAGER_ID = "host-mcp-manager";
const HOST_MCP_MANAGER_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const BUILTIN_MCP_LAUNCHER_PATH = resolve(
  HOST_MCP_MANAGER_DIRECTORY,
  "..",
  "..",
  "..",
  "bin",
  "acon-mcp-builtin.mjs",
);

const oauthConfigSchema = z.object({
  clientId: z.string().nullable().optional(),
  clientSecretRef: z.string().nullable().optional(),
  clientSecret: z.string().nullable().optional(),
  clientName: z.string().nullable().optional(),
  clientUri: z.string().nullable().optional(),
  clientMetadataUrl: z.string().nullable().optional(),
  scope: z.string().nullable().optional(),
  tokenEndpointAuthMethod: z.string().nullable().optional(),
});

const installedStdioServerSchema = z.object({
  id: z.string(),
  transport: z.literal("stdio"),
  command: z.string(),
  args: z.array(z.string()),
  cwd: z.string().nullable(),
  env: z.record(z.string(), z.string()),
  envSecretRefs: z.record(z.string(), z.string()),
  name: z.string().nullable(),
  version: z.string().nullable(),
});

const installedHttpServerSchema = z.object({
  id: z.string(),
  transport: z.enum(["streamable-http", "sse"]),
  url: z.string(),
  headers: z.record(z.string(), z.string()),
  headerSecretRefs: z.record(z.string(), z.string()),
  oauth: oauthConfigSchema.nullable(),
  name: z.string().nullable(),
  version: z.string().nullable(),
});

const installedHttpWrapperAuthSchema = z.object({
  type: z.enum(["none", "bearer", "header"]),
  secretRef: z.string().nullable(),
  headerName: z.string().nullable(),
});

const installedHttpWrapperServerSchema = z.object({
  id: z.string(),
  transport: z.literal("http-wrapper"),
  baseUrl: z.string(),
  auth: installedHttpWrapperAuthSchema,
  name: z.string().nullable(),
  version: z.string().nullable(),
});

const installedServerSchema = z.object({
  id: z.string(),
  transport: z.enum(["stdio", "streamable-http", "sse", "http-wrapper"]),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().nullable().optional(),
  env: z.record(z.string(), z.string()).optional(),
  envSecretRefs: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  baseUrl: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  headerSecretRefs: z.record(z.string(), z.string()).optional(),
  oauth: oauthConfigSchema.nullable().optional(),
  auth: installedHttpWrapperAuthSchema.optional(),
  name: z.string().nullable(),
  version: z.string().nullable(),
});

const listInstalledServersOutputSchema = z.object({
  servers: z.array(installedServerSchema),
});

const installStdioServerInputSchema = z.object({
  id: z.string(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  cwd: z.string().nullable().optional(),
  env: z.record(z.string(), z.string()).optional(),
  envSecretRefs: z.record(z.string(), z.string()).optional(),
  name: z.string().nullable().optional(),
  version: z.string().nullable().optional(),
});

const installHttpServerInputSchema = z.object({
  id: z.string(),
  transport: z.enum(["streamable-http", "sse"]).optional(),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  headerSecretRefs: z.record(z.string(), z.string()).optional(),
  oauth: oauthConfigSchema.nullable().optional(),
  name: z.string().nullable().optional(),
  version: z.string().nullable().optional(),
});

const installHttpWrapperServerInputSchema = z.object({
  id: z.string(),
  baseUrl: z.string(),
  auth: installedHttpWrapperAuthSchema.nullable().optional(),
  name: z.string().nullable().optional(),
  version: z.string().nullable().optional(),
});

const promptToStoreSecretInputSchema = z.object({
  secretRef: z.string().nullable().optional(),
  title: z.string(),
  message: z.string().nullable().optional(),
  fieldLabel: z.string().nullable().optional(),
});

const promptToStoreSecretOutputSchema = z.object({
  secretRef: z.string(),
});

const installRestApiServerInputSchema = z.object({
  id: z.string(),
  baseUrl: z.string(),
  auth: installedHttpWrapperAuthSchema.nullable().optional(),
  name: z.string().nullable().optional(),
  version: z.string().nullable().optional(),
});

const installServerOutputSchema = installedServerSchema.extend({
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
    api.registerMcpServer(HOST_MCP_MANAGER_ID, {
      name: "Host MCP Manager",
      version: "0.1.0",
      description: "Manage persisted host MCP server registrations from inside the guest.",
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
          "prompt_to_store_secret",
          {
            description:
              "Prompt the desktop user to enter a secret into the host vault. The agent only receives the resulting secretRef, never the secret value.",
            inputSchema: promptToStoreSecretInputSchema,
            outputSchema: promptToStoreSecretOutputSchema,
          },
          async (input) => {
            const stored = await api.promptToStoreSecret(input);
            return {
              content: [
                {
                  type: "text",
                  text: `Stored secret reference ${stored.secretRef}.`,
                },
              ],
              structuredContent: stored,
            };
          },
        );

        server.registerTool(
          "install_stdio_server",
          {
            description:
              "Install or replace a stdio MCP server in the desktop app host registry so the guest can use it through acon-mcp.",
            inputSchema: installStdioServerInputSchema,
            outputSchema: installServerOutputSchema,
          },
          async (input) => {
            const installed = await api.installStdioHostMcpServer(input);
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
          "install_rest_api_server",
          {
            description:
              "Install or replace the repo-local REST API MCP server as a stdio host MCP server. Supports baseUrl-scoped fetch with bearer or custom header auth injected from secret refs.",
            inputSchema: installRestApiServerInputSchema,
            outputSchema: installServerOutputSchema,
          },
          async (input) => {
            const auth = input.auth ?? {
              type: "none" as const,
              secretRef: null,
              headerName: null,
            };
            const installed = await api.installStdioHostMcpServer({
              id: input.id,
              command: BUILTIN_MCP_LAUNCHER_PATH,
              args: ["rest-api"],
              env: {
                REST_API_BASE_URL: input.baseUrl,
                REST_API_AUTH_TYPE: auth.type,
                ...(auth.type === "header" && auth.headerName
                  ? { REST_API_AUTH_HEADER_NAME: auth.headerName }
                  : {}),
              },
              envSecretRefs:
                auth.type === "none" || !auth.secretRef
                  ? {}
                  : {
                      REST_API_AUTH_SECRET: auth.secretRef,
                    },
              name: input.name ?? "REST API MCP",
              version: input.version ?? "0.1.0",
            });
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
          "install_http_server",
          {
            description:
              "Install or replace a remote HTTP MCP server in the desktop app host registry. Supports Streamable HTTP and legacy SSE, with host-managed OAuth handled automatically.",
            inputSchema: installHttpServerInputSchema,
            outputSchema: installServerOutputSchema,
          },
          async (input) => {
            const installed = await api.installHttpHostMcpServer(input);
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
          "install_http_wrapper_server",
          {
            description:
              "Install or replace a generic HTTP wrapper host MCP server. The wrapper exposes one fetch tool scoped to a configured baseUrl and can inject auth from a host secret reference.",
            inputSchema: installHttpWrapperServerInputSchema,
            outputSchema: installServerOutputSchema,
          },
          async (input) => {
            const installed = await api.installHttpWrapperHostMcpServer(input);
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

            const removed = await api.uninstallInstalledHostMcpServer(id);
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
