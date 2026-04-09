import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const stageRoot = resolve(repoRoot, "desktop-container/.local/bundle");
const stageDesktopRoot = resolve(stageRoot, "resources/desktop");
const stageBackendRoot = resolve(stageDesktopRoot, "backend");
const stageRendererRoot = resolve(stageDesktopRoot, "renderer");
const stagePluginsRoot = resolve(stageDesktopRoot, "plugins");
const stageBinRoot = resolve(stageDesktopRoot, "bin");
const stageLibexecRoot = resolve(stageDesktopRoot, "libexec");
const stageMcpServersRoot = resolve(stageDesktopRoot, "mcp-servers");
const stageImagesRoot = resolve(stageDesktopRoot, "container-images");
const vendorAppleContainerRoot = resolve(
  repoRoot,
  "desktop-container/vendor/apple-container",
);
const builtinPluginsRoot = resolve(
  repoRoot,
  "desktop-container/plugins/builtin",
);
const builtinMcpBinRoot = resolve(repoRoot, "desktop-container/bin");
const builtinMcpServersRoot = resolve(repoRoot, "desktop-container/mcp-servers");
const rendererDistRoot = resolve(repoRoot, "desktop/renderer-dist");
const backendBundleEntry = resolve(stageBackendRoot, "index.mjs");
const bundleManifestPath = resolve(stageRoot, "bundle-manifest.json");
const electronBuilderConfigPath = resolve(
  repoRoot,
  "desktop-container/electron-builder.json",
);

function log(message) {
  process.stdout.write(`[build-bundle] ${message}\n`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: {
      ...process.env,
      ...options.env,
    },
    encoding: "utf8",
    stdio: options.stdio ?? "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with code ${result.status ?? "null"}`,
    );
  }

  return result;
}

function ensureExists(path, description) {
  if (!existsSync(path)) {
    throw new Error(`${description} was not found at ${path}`);
  }
}

function cleanStageRoot() {
  rmSync(stageRoot, { force: true, recursive: true });
  mkdirSync(stageBackendRoot, { recursive: true });
  mkdirSync(stageRendererRoot, { recursive: true });
  mkdirSync(stagePluginsRoot, { recursive: true });
  mkdirSync(stageBinRoot, { recursive: true });
  mkdirSync(stageLibexecRoot, { recursive: true });
  mkdirSync(stageMcpServersRoot, { recursive: true });
  mkdirSync(stageImagesRoot, { recursive: true });
}

function stageRenderer() {
  log("building renderer");
  run("bun", ["run", "build:renderer"]);
  ensureExists(rendererDistRoot, "renderer build output");
  cpSync(rendererDistRoot, stageRendererRoot, {
    force: true,
    recursive: true,
  });
}

function stageBackend() {
  log("bundling backend module");
  run("bun", [
    "build",
    "desktop-container/backend/electron-service.ts",
    "--outfile",
    backendBundleEntry,
    "--target",
    "node",
    "--format",
    "esm",
  ]);
  ensureExists(backendBundleEntry, "backend bundle");
}

function stageAppleContainerRuntime() {
  const vendorContainerBin = resolve(vendorAppleContainerRoot, "bin/container");
  const vendorContainerLibexec = resolve(vendorAppleContainerRoot, "libexec/container");
  const imageContexts = resolve(repoRoot, "desktop-container/container-images");

  ensureExists(vendorContainerBin, "bundled Apple container binary");
  ensureExists(vendorContainerLibexec, "bundled Apple container helper tree");
  ensureExists(imageContexts, "Apple container image contexts");

  log("staging Apple container runtime");
  cpSync(vendorContainerBin, resolve(stageBinRoot, "container"), {
    force: true,
  });
  cpSync(vendorContainerLibexec, resolve(stageLibexecRoot, "container"), {
    force: true,
    recursive: true,
  });
  cpSync(imageContexts, stageImagesRoot, {
    force: true,
    recursive: true,
  });
}

function stageBuiltinPlugins() {
  ensureExists(builtinPluginsRoot, "builtin plugins");
  log("staging builtin plugins");
  cpSync(builtinPluginsRoot, resolve(stagePluginsRoot, "builtin"), {
    force: true,
    recursive: true,
  });
}

function stageBuiltinMcpLaunchers() {
  ensureExists(builtinMcpBinRoot, "builtin MCP launcher scripts");
  ensureExists(builtinMcpServersRoot, "builtin MCP server scripts");
  log("staging builtin MCP launchers");
  cpSync(builtinMcpBinRoot, stageBinRoot, {
    force: true,
    recursive: true,
  });
  cpSync(builtinMcpServersRoot, stageMcpServersRoot, {
    force: true,
    recursive: true,
  });
  chmodSync(resolve(stageBinRoot, "acon-mcp-builtin.mjs"), 0o755);
}

function writeManifest() {
  const manifest = {
    builtAt: new Date().toISOString(),
    stageDesktopRoot,
    backendBundleEntry,
    rendererDistRoot,
  };
  writeFileSync(bundleManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function packageAppBundle() {
  log("packaging macOS app bundle");
  run("bun", [
    "x",
    "electron-builder",
    "--config",
    electronBuilderConfigPath,
    "--mac",
    "dir",
  ]);
}

function main() {
  log("preparing bundled container assets");
  run(process.execPath, ["desktop-container/scripts/prepare-container-assets.mjs", "--mode", "bundle"], {
    env: {
      DESKTOP_PREPARE_CONTAINER_ASSETS_STRICT: "1",
    },
  });

  cleanStageRoot();
  stageRenderer();
  stageBackend();
  stageAppleContainerRuntime();
  stageBuiltinPlugins();
  stageBuiltinMcpLaunchers();
  writeManifest();
  packageAppBundle();

  log("bundle build complete");
}

main();
