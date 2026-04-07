import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const scriptMode = getFlagValue("--mode") || "manual";
const strictMode = process.env.DESKTOP_PREPARE_CONTAINER_ASSETS_STRICT === "1";
const prepareImages = process.env.DESKTOP_PREBUILD_CONTAINER_IMAGES !== "0";
const buildAppleContainer = process.env.DESKTOP_BUILD_APPLE_CONTAINER !== "0";
const appleContainerRepoDir = process.env.DESKTOP_APPLE_CONTAINER_REPO_DIR?.trim()
  ? resolve(process.env.DESKTOP_APPLE_CONTAINER_REPO_DIR.trim())
  : null;
const vendorContainerBinPath = resolve(
  repoRoot,
  "desktop-container/vendor/apple-container/bin/container",
);
const vendorContainerLibexecPath = resolve(
  repoRoot,
  "desktop-container/vendor/apple-container/libexec/container",
);
const stateFilePath = resolve(
  repoRoot,
  "desktop-container/.local/container-assets-state.json",
);
const sharedBuildArgs = [];

if (process.env.DESKTOP_ACPX_IMAGE_VERSION?.trim()) {
  sharedBuildArgs.push(
    "--build-arg",
    `ACPX_VERSION=${process.env.DESKTOP_ACPX_IMAGE_VERSION.trim()}`,
  );
}

const imageBuilds = [
  {
    id: "claude",
    label: "Claude",
    imageName:
      process.env.DESKTOP_CONTAINER_CLAUDE_IMAGE?.trim() || "acon-desktop-claude:0.1",
    buildContext: resolve(repoRoot, "desktop-container/container-images/acpx-claude"),
    versionBuildArgs: process.env.DESKTOP_CLAUDE_IMAGE_VERSION?.trim()
      ? ["--build-arg", `CLAUDE_VERSION=${process.env.DESKTOP_CLAUDE_IMAGE_VERSION.trim()}`]
      : [],
  },
  {
    id: "codex",
    label: "Codex",
    imageName:
      process.env.DESKTOP_CONTAINER_CODEX_IMAGE?.trim() || "acon-desktop-codex:0.1",
    buildContext: resolve(repoRoot, "desktop-container/container-images/acpx-codex"),
    versionBuildArgs: process.env.DESKTOP_CODEX_IMAGE_VERSION?.trim()
      ? ["--build-arg", `CODEX_VERSION=${process.env.DESKTOP_CODEX_IMAGE_VERSION.trim()}`]
      : [],
  },
];

function log(message) {
  process.stdout.write(`[container-assets] ${message}\n`);
}

function warn(message) {
  process.stderr.write(`[container-assets] ${message}\n`);
}

function getFlagValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] ?? null;
}

function fail(message) {
  if (strictMode) {
    throw new Error(message);
  }
  warn(`${message} Skipping asset preparation.`);
  process.exit(0);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
    },
    encoding: "utf8",
    stdio: options.stdio || "pipe",
  });

  if (result.error) {
    throw result.error;
  }

  return result;
}

function ensureHostSupportsContainerPreparation() {
  if (process.platform !== "darwin") {
    log(`skipping on ${process.platform}; Apple container assets only build on macOS`);
    process.exit(0);
  }

  if (process.arch !== "arm64") {
    fail(
      `Apple container assets require Apple silicon, but this machine reports ${process.arch}`,
    );
  }
}

function sha1File(filePath) {
  return createHash("sha1").update(readFileSync(filePath)).digest("hex");
}

function sha1Directory(rootPath) {
  const hash = createHash("sha1");
  const stack = [rootPath];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = readdirSync(current, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const entryPath = resolve(current, entry.name);
      hash.update(entryPath.slice(rootPath.length));
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      hash.update(readFileSync(entryPath));
    }
  }

  return hash.digest("hex");
}

function readStateFile() {
  if (!existsSync(stateFilePath)) {
    return { images: {} };
  }

  try {
    return JSON.parse(readFileSync(stateFilePath, "utf8"));
  } catch {
    return { images: {} };
  }
}

function writeStateFile(state) {
  mkdirSync(resolve(stateFilePath, ".."), { recursive: true });
  writeFileSync(stateFilePath, `${JSON.stringify(state, null, 2)}\n`);
}

function resolveBinaryFromAppleContainerRepo() {
  if (!appleContainerRepoDir) {
    return null;
  }

  if (!existsSync(appleContainerRepoDir)) {
    fail(
      `DESKTOP_APPLE_CONTAINER_REPO_DIR points to a missing path: ${appleContainerRepoDir}`,
    );
  }

  const buildConfiguration =
    process.env.DESKTOP_APPLE_CONTAINER_BUILD_CONFIGURATION?.trim() || "release";
  const binaryPath = resolve(appleContainerRepoDir, "bin/container");
  const needsBuild =
    buildAppleContainer &&
    (!existsSync(binaryPath) || process.env.DESKTOP_REBUILD_APPLE_CONTAINER === "1");

  if (needsBuild) {
    log(
      `building Apple container from ${appleContainerRepoDir} (BUILD_CONFIGURATION=${buildConfiguration})`,
    );
    const result = run(
      "make",
      ["all"],
      {
        cwd: appleContainerRepoDir,
        env: {
          BUILD_CONFIGURATION: buildConfiguration,
        },
        stdio: "inherit",
      },
    );
    if (result.status !== 0) {
      throw new Error(
        `failed to build Apple container from ${appleContainerRepoDir} (exit ${result.status ?? "null"})`,
      );
    }
  }

  return existsSync(binaryPath) ? binaryPath : null;
}

function resolveBinaryFromEnvironmentOrPath() {
  const configuredPath = process.env.DESKTOP_CONTAINER_SOURCE_BIN_PATH?.trim()
    ? resolve(process.env.DESKTOP_CONTAINER_SOURCE_BIN_PATH.trim())
    : null;
  if (configuredPath) {
    return existsSync(configuredPath) ? configuredPath : null;
  }

  const whichResult = run("which", ["container"]);
  if (whichResult.status !== 0) {
    return null;
  }

  const resolvedPath = whichResult.stdout.trim();
  return resolvedPath ? resolvedPath : null;
}

function resolveSourceLibexecPath(sourceBinaryPath) {
  const configuredPath = process.env.DESKTOP_CONTAINER_SOURCE_LIBEXEC_PATH?.trim()
    ? resolve(process.env.DESKTOP_CONTAINER_SOURCE_LIBEXEC_PATH.trim())
    : null;
  if (configuredPath) {
    return existsSync(configuredPath) ? configuredPath : null;
  }

  if (appleContainerRepoDir) {
    const repoLibexecPath = resolve(appleContainerRepoDir, "libexec/container");
    if (existsSync(repoLibexecPath)) {
      return repoLibexecPath;
    }
  }

  const installRoot = resolve(dirname(sourceBinaryPath), "..");
  const inferredLibexecPath = resolve(installRoot, "libexec/container");
  return existsSync(inferredLibexecPath) ? inferredLibexecPath : null;
}

function ensureBundledContainerInstall() {
  const sourceBinaryPath =
    resolveBinaryFromAppleContainerRepo() || resolveBinaryFromEnvironmentOrPath();
  if (!sourceBinaryPath) {
    fail(
      "unable to find an Apple `container` binary; set DESKTOP_APPLE_CONTAINER_REPO_DIR or install `container` first",
    );
  }
  const sourceLibexecPath = resolveSourceLibexecPath(sourceBinaryPath);

  mkdirSync(resolve(vendorContainerBinPath, ".."), { recursive: true });
  mkdirSync(resolve(vendorContainerLibexecPath, ".."), { recursive: true });

  const shouldCopy =
    resolve(sourceBinaryPath) !== vendorContainerBinPath &&
    (!existsSync(vendorContainerBinPath) ||
      process.env.DESKTOP_REFRESH_CONTAINER_BIN === "1" ||
      sha1File(sourceBinaryPath) !== sha1File(vendorContainerBinPath));

  if (shouldCopy) {
    copyFileSync(sourceBinaryPath, vendorContainerBinPath);
    chmodSync(vendorContainerBinPath, 0o755);
    log(`copied ${basename(sourceBinaryPath)} into ${vendorContainerBinPath}`);
  } else if (!existsSync(vendorContainerBinPath) && resolve(sourceBinaryPath) === vendorContainerBinPath) {
    chmodSync(vendorContainerBinPath, 0o755);
  }

  if (!sourceLibexecPath) {
    warn(
      "could not find the Apple `container` helper tree under libexec/container; packaged runtime staging is still incomplete",
    );
  } else {
    const shouldCopyLibexec =
      resolve(sourceLibexecPath) !== vendorContainerLibexecPath &&
      (!existsSync(vendorContainerLibexecPath) ||
        process.env.DESKTOP_REFRESH_CONTAINER_BIN === "1" ||
        sha1Directory(sourceLibexecPath) !== sha1Directory(vendorContainerLibexecPath));

    if (shouldCopyLibexec) {
      rmSync(vendorContainerLibexecPath, {
        force: true,
        recursive: true,
      });
      cpSync(sourceLibexecPath, vendorContainerLibexecPath, {
        force: true,
        recursive: true,
      });
      log(`copied helper tree into ${vendorContainerLibexecPath}`);
    }
  }

  return resolve(sourceBinaryPath) === vendorContainerBinPath
    ? sourceBinaryPath
    : vendorContainerBinPath;
}

function getContainerVersion(containerCommand) {
  const result = run(containerCommand, ["--version"]);
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || "failed to read Apple container version",
    );
  }
  return result.stdout.trim();
}

function imageExists(containerCommand, imageName) {
  const result = run(containerCommand, ["image", "inspect", imageName]);
  return result.status === 0;
}

function ensureImage(containerCommand, containerVersion, state, imageBuild) {
  const contextHash = sha1Directory(imageBuild.buildContext);
  const desiredHash = createHash("sha1")
    .update(
      JSON.stringify({
        containerVersion,
        contextHash,
        imageName: imageBuild.imageName,
        sharedBuildArgs,
        versionBuildArgs: imageBuild.versionBuildArgs,
      }),
    )
    .digest("hex");
  const currentHash = state.images?.[imageBuild.id]?.hash || null;
  const shouldBuild =
    process.env.DESKTOP_REBUILD_CONTAINER_IMAGES === "1" ||
    !imageExists(containerCommand, imageBuild.imageName) ||
    currentHash !== desiredHash;

  if (!shouldBuild) {
    log(`${imageBuild.label} image is up to date (${imageBuild.imageName})`);
    return;
  }

  log(`building ${imageBuild.label} image (${imageBuild.imageName})`);
  const args = [
    "build",
    "--progress",
    "plain",
    ...sharedBuildArgs,
    ...imageBuild.versionBuildArgs,
    "--file",
    resolve(imageBuild.buildContext, "Containerfile"),
    "--tag",
    imageBuild.imageName,
    imageBuild.buildContext,
  ];
  const result = run(containerCommand, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(
      `failed to build ${imageBuild.imageName} (exit ${result.status ?? "null"})`,
    );
  }

  state.images[imageBuild.id] = {
    builtAt: new Date().toISOString(),
    containerVersion,
    hash: desiredHash,
    imageName: imageBuild.imageName,
  };
}

function main() {
  ensureHostSupportsContainerPreparation();

  log(`mode=${scriptMode}`);
  const containerCommand = ensureBundledContainerInstall();
  const containerVersion = getContainerVersion(containerCommand);
  log(`using ${containerVersion}`);

  if (!prepareImages) {
    log("skipping image builds because DESKTOP_PREBUILD_CONTAINER_IMAGES=0");
    return;
  }

  const state = readStateFile();
  state.images ||= {};

  for (const imageBuild of imageBuilds) {
    ensureImage(containerCommand, containerVersion, state, imageBuild);
  }

  writeStateFile(state);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (strictMode) {
    throw error;
  }
  warn(message);
  process.exit(0);
}
