import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const DEFAULT_NOTARY_PROFILE = "super-camel-notary";
const repoRoot = resolve(import.meta.dirname, "..", "..");
const outputRoot = resolve(repoRoot, "dist", "bundle");
const packageJsonPath = resolve(repoRoot, "package.json");
const defaultArch = "arm64";
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const appVersion =
  typeof packageJson.version === "string" && packageJson.version.trim().length > 0
    ? packageJson.version.trim()
    : "0.0.0";

function log(message) {
  process.stdout.write(`[build-release] ${message}\n`);
}

function parseArgs(argv) {
  const targets = [];
  let notarize = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--notarize") {
      notarize = true;
      continue;
    }

    if (argument === "--target") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--target requires a value");
      }
      targets.push(value);
      index += 1;
      continue;
    }

    if (argument.startsWith("--target=")) {
      targets.push(argument.slice("--target=".length));
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  if (targets.length === 0) {
    targets.push("dmg");
  }

  return {
    notarize,
    targets,
  };
}

function run(args, env) {
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `${process.execPath} ${args.join(" ")} exited with code ${result.status ?? "null"}`,
    );
  }
}

function main() {
  const { notarize, targets } = parseArgs(process.argv.slice(2));
  const requestedTargets = [...new Set(targets)];
  const shouldBuildDmg = requestedTargets.includes("dmg");
  const electronBuilderTargets = requestedTargets.filter((target) => target !== "dmg");
  if (shouldBuildDmg && !electronBuilderTargets.includes("dir")) {
    electronBuilderTargets.unshift("dir");
  }
  const env = {
    ...process.env,
  };

  if (notarize) {
    env.APPLE_NOTARIZE = "1";
    env.APPLE_KEYCHAIN_PROFILE ||= DEFAULT_NOTARY_PROFILE;
  }

  const buildArgs = ["desktop-container/scripts/build-bundle.mjs"];
  for (const target of electronBuilderTargets) {
    buildArgs.push("--target", target);
  }

  run(buildArgs, env);

  if (shouldBuildDmg) {
    const appName = findPackagedAppName();
    const appPath = join(outputRoot, `mac-${defaultArch}`, appName);
    const dmgPath = join(
      outputRoot,
      `${appName.replace(/\.app$/, "")}-${appVersion}-${defaultArch}.dmg`,
    );
    rmSync(`${dmgPath}.blockmap`, { force: true });

    if (!existsSync(appPath)) {
      throw new Error(`Packaged app was not found at ${appPath}`);
    }

    log(`creating DMG from ${appPath}`);
    run(
      [
        "desktop-container/scripts/create-dmg.mjs",
        "--app",
        appPath,
        "--output",
        dmgPath,
        "--volume-name",
        appName.replace(/\.app$/, ""),
      ],
      env,
    );
  }
}

function findPackagedAppName() {
  const appDir = join(outputRoot, `mac-${defaultArch}`);
  if (!existsSync(appDir)) {
    throw new Error(`Packaged app directory was not found at ${appDir}`);
  }

  const appName = readdirSync(appDir).find((entry) => entry.endsWith(".app"));
  if (!appName) {
    throw new Error(`No .app bundle was found in ${appDir}`);
  }
  return appName;
}

main();
