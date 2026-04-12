#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const builtinName = process.argv[2]?.trim();

if (!builtinName) {
  process.stderr.write("Usage: acon-mcp-builtin <builtin-name>\n");
  process.exit(1);
}

const builtinEntrypoints = {
  "rest-api": resolve(import.meta.dirname, "..", "mcp-servers", "rest-api.mjs"),
};

const entrypoint = builtinEntrypoints[builtinName];
if (!entrypoint) {
  process.stderr.write(`Unknown builtin MCP server: ${builtinName}\n`);
  process.exit(1);
}

await import(pathToFileURL(entrypoint).href);
