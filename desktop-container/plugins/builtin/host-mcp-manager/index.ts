import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type {
  CamelAIExtensionModule,
  CamelAIInstallHttpHostMcpServerOptions,
  CamelAIInstallWorkspacePluginOptions,
  CamelAIInstallStdioHostMcpServerOptions,
  CamelAIPromptToStoreSecretOptions,
} from "../../../sdk";

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

const restApiAuthSchema = z.object({
  type: z.enum(["none", "bearer", "header"]),
  secretRef: z.string().nullable(),
  headerName: z.string().nullable(),
});

const installedServerSchema = z.object({
  id: z.string(),
  transport: z.enum(["stdio", "streamable-http", "sse"]),
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
  auth: restApiAuthSchema.nullable().optional(),
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

type ToolResult = {
  content?: Array<{
    type: "text";
    text: string;
  }>;
  structuredContent?: unknown;
};

type UntypedMcpServer = {
  registerTool(
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: unknown;
      outputSchema?: unknown;
    },
    cb: (input: any) => ToolResult | Promise<ToolResult>,
  ): unknown;
};

type RestApiAuthInput = {
  type: "none" | "bearer" | "header";
  secretRef?: string | null;
  headerName?: string | null;
};

type InstallRestApiServerInput = {
  id: string;
  baseUrl: string;
  auth?: RestApiAuthInput | null;
  name?: string | null;
  version?: string | null;
};
const installedPluginSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  source: z.enum(["builtin", "user"]),
  enabled: z.boolean(),
  disableable: z.boolean(),
  path: z.string(),
});

const listInstalledPluginsOutputSchema = z.object({
  plugins: z.array(installedPluginSchema),
});

const installWorkspacePluginInputSchema = z.object({
  path: z.string(),
});

const installWorkspacePluginOutputSchema = z.object({
  pluginId: z.string(),
  pluginName: z.string(),
  version: z.string(),
  installPath: z.string(),
  replaced: z.boolean(),
});

const pluginAgentAssetProviderSchema = z.enum(["codex", "claude"]);

const installedPluginAgentAssetsStatusSchema = z.object({
  provider: pluginAgentAssetProviderSchema,
  installedSkillIds: z.array(z.string()),
  installedMcpServerIds: z.array(z.string()),
});

const pluginAgentAssetsBundleSchema = z.object({
  pluginId: z.string(),
  pluginName: z.string(),
  pluginVersion: z.string(),
  source: z.enum(["builtin", "user"]),
  path: z.string(),
  skills: z.array(
    z.object({
      id: z.string(),
    }),
  ),
  mcpServers: z.array(
    z.object({
      id: z.string(),
      transport: z.enum(["stdio", "streamable-http", "sse"]),
      name: z.string().nullable(),
      version: z.string().nullable(),
    }),
  ),
  installedByProvider: z.array(installedPluginAgentAssetsStatusSchema),
});

const listPluginAgentAssetsInputSchema = z.object({
  pluginId: z.string().nullable().optional(),
});

const listPluginAgentAssetsOutputSchema = z.object({
  plugins: z.array(pluginAgentAssetsBundleSchema),
});
const extension: CamelAIExtensionModule = {
  activate(api) {
    api.registerMcpServer(HOST_MCP_MANAGER_ID, {
      name: "Host MCP Manager",
      version: "0.1.0",
      description: "Manage persisted host MCP server registrations from inside the guest.",
      createServer: () => {
        const typedServer = new McpServer({
          name: HOST_MCP_MANAGER_ID,
          version: "1.0.0",
        });
        const server = typedServer as unknown as UntypedMcpServer;

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
          async (input: CamelAIPromptToStoreSecretOptions) => {
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
          async (input: CamelAIInstallStdioHostMcpServerOptions) => {
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
          async (input: InstallRestApiServerInput) => {
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
          async (input: CamelAIInstallHttpHostMcpServerOptions) => {
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
          "uninstall_server",
          {
            description:
              "Remove a host MCP server that was previously installed into the desktop app host registry.",
            inputSchema: uninstallServerInputSchema,
            outputSchema: uninstallServerOutputSchema,
          },
          async ({ id }: { id: string }) => {
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

        server.registerTool(
          "list_installed_plugins",
          {
            description:
              "List plugins currently discovered by the desktop app, including builtin and user-installed plugins.",
            outputSchema: listInstalledPluginsOutputSchema,
          },
          async () => {
            const plugins = api.listInstalledPlugins();
            return {
              content: [
                {
                  type: "text",
                  text:
                    plugins.length > 0
                      ? `Installed plugins: ${plugins.map((entry) => entry.id).join(", ")}`
                      : "No plugins are currently installed.",
                },
              ],
              structuredContent: {
                plugins,
              },
            };
          },
        );

        server.registerTool(
          "install_workspace_plugin",
          {
            description:
              "Install or update a plugin bundle from a folder inside the managed guest workspace. Declared camelai.agentAssets are reconciled automatically on plugin refresh.",
            inputSchema: installWorkspacePluginInputSchema,
            outputSchema: installWorkspacePluginOutputSchema,
          },
          async (input: CamelAIInstallWorkspacePluginOptions) => {
            const installed = await api.installPluginFromWorkspace(input);
            return {
              content: [
                {
                  type: "text",
                  text: installed.replaced
                    ? `Updated plugin ${installed.pluginId}.`
                    : `Installed plugin ${installed.pluginId}.`,
                },
              ],
              structuredContent: installed,
            };
          },
        );

        server.registerTool(
          "list_plugin_agent_assets",
          {
            description:
              "List installed plugins that declare bundled camelai.agentAssets skills or MCP servers, plus provider install status.",
            inputSchema: listPluginAgentAssetsInputSchema,
            outputSchema: listPluginAgentAssetsOutputSchema,
          },
          async (input: { pluginId?: string | null }) => {
            const plugins = api.listPluginAgentAssets(input.pluginId ?? null);
            return {
              content: [
                {
                  type: "text",
                  text:
                    plugins.length > 0
                      ? `Plugins with bundled agent assets: ${plugins.map((entry) => entry.pluginId).join(", ")}`
                      : "No installed plugins currently declare bundled agent assets.",
                },
              ],
              structuredContent: {
                plugins,
              },
            };
          },
        );

        return typedServer;
      },
    });
  },
};

export default extension;
