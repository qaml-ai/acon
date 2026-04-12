import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const DEFAULT_NOTARY_PROFILE = "super-camel-notary";

function resolveKeyPath() {
  const explicitPath = process.env.APPLE_API_KEY_PATH?.trim();
  if (explicitPath) {
    return explicitPath;
  }

  const keyId = process.env.APPLE_API_KEY_ID?.trim();
  if (!keyId) {
    throw new Error(
      "Set APPLE_API_KEY_PATH or APPLE_API_KEY_ID before running this script.",
    );
  }

  const downloadsPath = join(homedir(), "Downloads", `AuthKey_${keyId}.p8`);
  if (!existsSync(downloadsPath)) {
    throw new Error(`Expected API key at ${downloadsPath}, but it was not found.`);
  }

  return downloadsPath;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with code ${result.status ?? "null"}`,
    );
  }
}

function main() {
  const issuer = process.env.APPLE_API_ISSUER?.trim();
  const keyId = process.env.APPLE_API_KEY_ID?.trim();
  const keyPath = resolveKeyPath();
  const profile = process.env.APPLE_KEYCHAIN_PROFILE?.trim() || DEFAULT_NOTARY_PROFILE;

  if (!keyId) {
    throw new Error("Set APPLE_API_KEY_ID before running this script.");
  }

  if (!issuer) {
    throw new Error("Set APPLE_API_ISSUER before running this script.");
  }

  run("xcrun", [
    "notarytool",
    "store-credentials",
    profile,
    "--key",
    keyPath,
    "--key-id",
    keyId,
    "--issuer",
    issuer,
  ]);
}

main();
