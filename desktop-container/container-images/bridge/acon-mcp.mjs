#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const require = createRequire(import.meta.url);
const bundledNodeModulesRoot =
  process.env.ACON_BUNDLED_NODE_MODULES_ROOT?.trim() ||
  "/opt/acon/npm-global/node_modules";

async function loadHostRpcModule() {
  const bundledEntryPath = resolve(
    bundledNodeModulesRoot,
    "@acon/host-rpc/index.js",
  );

  try {
    return await import(pathToFileURL(bundledEntryPath).href);
  } catch (bundledError) {
    try {
      const resolvedPackageEntry = require.resolve("@acon/host-rpc");
      return await import(pathToFileURL(resolvedPackageEntry).href);
    } catch {
      const detail =
        bundledError instanceof Error ? bundledError.message : String(bundledError);
      throw new Error(
        `Unable to load @acon/host-rpc from ${bundledEntryPath} or the default module resolution path. ${detail}`,
      );
    }
  }
}

const parsedArgs = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    help: {
      short: "h",
      type: "boolean",
    },
    arg: {
      type: "string",
      multiple: true,
    },
    input: {
      type: "string",
    },
    "input-file": {
      type: "string",
    },
  },
});
const positionalArgs = parsedArgs.positionals;
const {
  createHostRpcClient,
} = await loadHostRpcModule();
const client = createHostRpcClient();

function printHelp(mode = "root", exitCode = 0) {
  const outputByMode = {
    root: [
      "Browse and invoke host MCP integrations from inside the container.",
      "",
      "Usage:",
      "  acon-mcp servers",
      "  acon-mcp tools <server-id>",
      "  acon-mcp prompts <server-id>",
      "  acon-mcp prompt <server-id> <prompt-name> [--arg name=value]",
      "  acon-mcp resources <server-id>",
      "  acon-mcp resource-templates <server-id>",
      "  acon-mcp read-resource <server-id> <uri>",
      "  acon-mcp call <server-id> <tool-name> [--input <json> | --input-file <path>]",
      "  acon-mcp --help",
      "",
      "Modes:",
      "  servers                      List host MCP servers registered in the host app.",
      "  tools <server-id>            List tools exposed by that server.",
      "  prompts <server-id>          List prompts exposed by that server.",
      "  prompt <server-id> <name>    Resolve one prompt with string arguments.",
      "  resources <server-id>        List resources exposed by that server.",
      "  resource-templates <server-id> List resource templates exposed by that server.",
      "  read-resource <server-id> <uri> Read one resource URI.",
      "  call <server-id> <tool-name> Invoke one tool with JSON arguments.",
      "",
      "Discovery:",
      "  1. Run `acon-mcp servers` to discover available host MCP servers.",
      "  2. Run `acon-mcp tools <server-id>`, `prompts <server-id>`, or `resources <server-id>` to inspect a server.",
      "  3. Run `acon-mcp call ...`, `prompt ...`, or `read-resource ...` for one-shot usage.",
      "",
      "Examples:",
      "  acon-mcp servers",
      "  acon-mcp tools integration-host-tools",
      "  acon-mcp prompts integration-host-tools",
      "  acon-mcp prompt integration-host-tools summarize --arg topic=release",
      "  acon-mcp resources integration-host-tools",
      "  acon-mcp read-resource integration-host-tools file:///workspace/README.md",
      "  acon-mcp call integration-host-tools host_echo --input '{\"provider\":\"codex\",\"text\":\"hello\"}'",
      "",
      "Environment:",
      "  ACON_HOST_RPC_SOCKET      Override the guest bridge socket path.",
      "  ACON_HOST_RPC_TIMEOUT_MS  Override the bridge request timeout.",
      "",
    ],
    servers: [
      "List host MCP servers registered in the host app.",
      "",
      "Usage:",
      "  acon-mcp servers",
      "",
    ],
    tools: [
      "List tools exposed by one host MCP server.",
      "",
      "Usage:",
      "  acon-mcp tools <server-id>",
      "",
      "Arguments:",
      "  <server-id>  The registered host MCP server id.",
      "",
    ],
    prompts: [
      "List prompts exposed by one host MCP server.",
      "",
      "Usage:",
      "  acon-mcp prompts <server-id>",
      "",
      "Arguments:",
      "  <server-id>  The registered host MCP server id.",
      "",
    ],
    prompt: [
      "Resolve one prompt exposed by a host MCP server.",
      "",
      "Usage:",
      "  acon-mcp prompt <server-id> <prompt-name> [--arg name=value]",
      "",
      "Arguments:",
      "  <server-id>    The registered host MCP server id.",
      "  <prompt-name>  The prompt name to resolve.",
      "",
      "Options:",
      "  --arg name=value  String argument passed to the prompt. Repeat as needed.",
      "",
    ],
    resources: [
      "List resources exposed by one host MCP server.",
      "",
      "Usage:",
      "  acon-mcp resources <server-id>",
      "",
      "Arguments:",
      "  <server-id>  The registered host MCP server id.",
      "",
    ],
    "resource-templates": [
      "List resource templates exposed by one host MCP server.",
      "",
      "Usage:",
      "  acon-mcp resource-templates <server-id>",
      "",
      "Arguments:",
      "  <server-id>  The registered host MCP server id.",
      "",
    ],
    "read-resource": [
      "Read one resource URI from a host MCP server.",
      "",
      "Usage:",
      "  acon-mcp read-resource <server-id> <uri>",
      "",
      "Arguments:",
      "  <server-id>  The registered host MCP server id.",
      "  <uri>        The resource URI to read.",
      "",
    ],
    call: [
      "Invoke one tool exposed by a host MCP server.",
      "",
      "Usage:",
      "  acon-mcp call <server-id> <tool-name> [--input <json> | --input-file <path>]",
      "",
      "Arguments:",
      "  <server-id>  The registered host MCP server id.",
      "  <tool-name>  The tool name to invoke.",
      "",
      "Options:",
      "  --input <json>       Inline JSON object to pass as the tool arguments.",
      "  --input-file <path>  Read the tool arguments JSON object from a file.",
      "",
    ],
  };
  const output = (outputByMode[mode] || outputByMode.root).join("\n");
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(output);
  process.exit(exitCode);
}

const firstArg = positionalArgs[0];
const secondArg = positionalArgs[1];
const helpRequested = firstArg === "help" || parsedArgs.values.help === true;
const helpMode =
  firstArg === "help"
    ? secondArg || "root"
    : firstArg === "servers" ||
        firstArg === "tools" ||
        firstArg === "prompts" ||
        firstArg === "prompt" ||
        firstArg === "resources" ||
        firstArg === "resource-templates" ||
        firstArg === "read-resource" ||
        firstArg === "call"
      ? firstArg
      : "root";

if (helpRequested || !firstArg) {
  printHelp(helpMode, helpRequested ? 0 : 1);
}

async function listServers() {
  const records = await client.listMcpServers();
  if (records.length === 0) {
    process.stdout.write("No host MCP servers are registered.\n");
    return;
  }

  for (const record of records) {
    if (record && typeof record.id === "string") {
      process.stdout.write(`${record.id}\n`);
    }
  }
}

async function listTools(serverId) {
  const tools = await client.listMcpTools(serverId);

  if (tools.length === 0) {
    process.stdout.write(`No tools are registered for ${serverId}.\n`);
    return;
  }

  for (const tool of tools) {
    if (!tool || typeof tool.name !== "string") {
      continue;
    }
    const description =
      typeof tool.description === "string" && tool.description.trim()
        ? ` - ${tool.description.trim()}`
        : "";
    process.stdout.write(`${tool.name}${description}\n`);
  }
}

async function listPrompts(serverId) {
  const prompts = await client.listMcpPrompts(serverId);

  if (prompts.length === 0) {
    process.stdout.write(`No prompts are registered for ${serverId}.\n`);
    return;
  }

  for (const prompt of prompts) {
    if (!prompt || typeof prompt.name !== "string") {
      continue;
    }
    const description =
      typeof prompt.description === "string" && prompt.description.trim()
        ? ` - ${prompt.description.trim()}`
        : "";
    process.stdout.write(`${prompt.name}${description}\n`);
  }
}

async function listResources(serverId) {
  const resources = await client.listMcpResources(serverId);

  if (resources.length === 0) {
    process.stdout.write(`No resources are registered for ${serverId}.\n`);
    return;
  }

  for (const resource of resources) {
    if (!resource || typeof resource.uri !== "string") {
      continue;
    }
    const label =
      typeof resource.name === "string" && resource.name.trim()
        ? resource.name.trim()
        : resource.uri;
    const description =
      typeof resource.description === "string" && resource.description.trim()
        ? ` - ${resource.description.trim()}`
        : label === resource.uri
          ? ""
          : ` - ${resource.uri}`;
    process.stdout.write(`${label}${description}\n`);
  }
}

async function listResourceTemplates(serverId) {
  const templates = await client.listMcpResourceTemplates(serverId);

  if (templates.length === 0) {
    process.stdout.write(`No resource templates are registered for ${serverId}.\n`);
    return;
  }

  for (const template of templates) {
    if (!template || typeof template.uriTemplate !== "string") {
      continue;
    }
    const label =
      typeof template.name === "string" && template.name.trim()
        ? template.name.trim()
        : template.uriTemplate;
    const description =
      typeof template.description === "string" && template.description.trim()
        ? ` - ${template.description.trim()}`
        : label === template.uriTemplate
          ? ""
          : ` - ${template.uriTemplate}`;
    process.stdout.write(`${label}${description}\n`);
  }
}

function parseToolArguments() {
  const inlineInput = parsedArgs.values.input;
  const inputFile = parsedArgs.values["input-file"];

  if (inlineInput && inputFile) {
    throw new Error("acon-mcp call accepts either --input or --input-file, not both.");
  }

  if (!inlineInput && !inputFile) {
    return {};
  }

  const rawInput = inputFile
    ? readFileSync(inputFile, "utf8")
    : inlineInput;

  let parsed;
  try {
    parsed = JSON.parse(rawInput);
  } catch {
    throw new Error(
      "acon-mcp call expected --input/--input-file to contain valid JSON.",
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("acon-mcp call expected tool arguments to be a JSON object.");
  }

  return parsed;
}

function parsePromptArguments() {
  const argValues = parsedArgs.values.arg || [];
  const promptArguments = {};

  for (const entry of argValues) {
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex <= 0) {
      throw new Error(`Invalid --arg value: ${entry}. Expected name=value.`);
    }
    const key = entry.slice(0, separatorIndex).trim();
    const value = entry.slice(separatorIndex + 1);
    if (!key) {
      throw new Error(`Invalid --arg value: ${entry}. Expected name=value.`);
    }
    promptArguments[key] = value;
  }

  return promptArguments;
}

function printToolResult(result) {
  if (typeof result === "string") {
    process.stdout.write(`${result}\n`);
    return;
  }

  if (
    result &&
    typeof result === "object" &&
    Array.isArray(result.content) &&
    !("structuredContent" in result) &&
    result.content.every(
      (item) =>
        item &&
        typeof item === "object" &&
        item.type === "text" &&
        typeof item.text === "string",
    )
  ) {
    process.stdout.write(
      `${result.content.map((item) => item.text).join("\n")}\n`,
    );
    return;
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function renderPromptContent(content) {
  if (!content || typeof content !== "object") {
    return JSON.stringify(content, null, 2);
  }

  if (content.type === "text" && typeof content.text === "string") {
    return content.text;
  }

  if (
    content.type === "resource" &&
    content.resource &&
    typeof content.resource === "object"
  ) {
    if (typeof content.resource.text === "string") {
      return content.resource.text;
    }
    if (typeof content.resource.blob === "string") {
      return `[binary resource ${content.resource.uri ?? "unknown"}]`;
    }
  }

  return JSON.stringify(content, null, 2);
}

function printPromptResult(result) {
  if (!result || typeof result !== "object") {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const sections = [];
  if (typeof result.description === "string" && result.description.trim()) {
    sections.push(result.description.trim());
  }

  if (Array.isArray(result.messages) && result.messages.length > 0) {
    sections.push(
      result.messages
        .map((message) => {
          if (!message || typeof message !== "object") {
            return JSON.stringify(message, null, 2);
          }
          const role = typeof message.role === "string" ? message.role : "message";
          return `[${role}]\n${renderPromptContent(message.content)}`;
        })
        .join("\n\n"),
    );
  }

  process.stdout.write(
    `${sections.length > 0 ? sections.join("\n\n") : JSON.stringify(result, null, 2)}\n`,
  );
}

function printResourceResult(result) {
  if (
    result &&
    typeof result === "object" &&
    Array.isArray(result.contents) &&
    result.contents.length > 0
  ) {
    const rendered = result.contents.map((content) => {
      if (!content || typeof content !== "object") {
        return JSON.stringify(content, null, 2);
      }
      if (typeof content.text === "string") {
        return content.text;
      }
      if (typeof content.blob === "string") {
        return `[binary resource ${content.uri ?? "unknown"}]`;
      }
      return JSON.stringify(content, null, 2);
    });
    process.stdout.write(`${rendered.join("\n\n")}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function callTool(serverId, toolName) {
  const toolArguments = parseToolArguments();
  const result = await client.callMcpTool(serverId, toolName, toolArguments);
  printToolResult(result);
}

async function getPrompt(serverId, promptName) {
  const promptArguments = parsePromptArguments();
  const result = await client.getMcpPrompt(
    serverId,
    promptName,
    Object.keys(promptArguments).length > 0 ? promptArguments : undefined,
  );
  printPromptResult(result);
}

async function readResource(serverId, uri) {
  const result = await client.readMcpResource(serverId, uri);
  printResourceResult(result);
}

async function run() {
  if (firstArg === "servers") {
    await listServers();
    return;
  }

  if (firstArg === "tools") {
    const serverId = positionalArgs[1];
    if (!serverId) {
      throw new Error("acon-mcp tools requires a server id.");
    }
    await listTools(serverId);
    return;
  }

  if (firstArg === "prompts") {
    const serverId = positionalArgs[1];
    if (!serverId) {
      throw new Error("acon-mcp prompts requires a server id.");
    }
    await listPrompts(serverId);
    return;
  }

  if (firstArg === "prompt") {
    const serverId = positionalArgs[1];
    const promptName = positionalArgs[2];
    if (!serverId || !promptName) {
      throw new Error("acon-mcp prompt requires a server id and prompt name.");
    }
    await getPrompt(serverId, promptName);
    return;
  }

  if (firstArg === "resources") {
    const serverId = positionalArgs[1];
    if (!serverId) {
      throw new Error("acon-mcp resources requires a server id.");
    }
    await listResources(serverId);
    return;
  }

  if (firstArg === "resource-templates") {
    const serverId = positionalArgs[1];
    if (!serverId) {
      throw new Error("acon-mcp resource-templates requires a server id.");
    }
    await listResourceTemplates(serverId);
    return;
  }

  if (firstArg === "read-resource") {
    const serverId = positionalArgs[1];
    const uri = positionalArgs[2];
    if (!serverId || !uri) {
      throw new Error("acon-mcp read-resource requires a server id and URI.");
    }
    await readResource(serverId, uri);
    return;
  }

  if (firstArg === "call") {
    const serverId = positionalArgs[1];
    const toolName = positionalArgs[2];
    if (!serverId || !toolName) {
      throw new Error("acon-mcp call requires a server id and tool name.");
    }
    await callTool(serverId, toolName);
    return;
  }

  throw new Error(`Unknown acon-mcp command: ${firstArg}`);
}

run().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
