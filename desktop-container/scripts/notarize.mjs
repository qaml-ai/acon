import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { notarize } from "@electron/notarize";

function log(message) {
  process.stdout.write(`[notarize] ${message}\n`);
}

function resolveKeychainProfileAuth() {
  const keychainProfile = process.env.APPLE_KEYCHAIN_PROFILE?.trim();
  if (!keychainProfile) {
    return null;
  }

  return {
    keychainProfile,
  };
}

function resolveApiKeyAuth() {
  const appleApiKeyPath = process.env.APPLE_API_KEY_PATH?.trim();
  const appleApiKeyInline = process.env.APPLE_API_KEY?.trim();
  const appleApiIssuer = process.env.APPLE_API_ISSUER?.trim();
  const appleApiKeyId = process.env.APPLE_API_KEY_ID?.trim();

  if (!appleApiKeyPath && !appleApiKeyInline) {
    return null;
  }

  let tempDir = null;
  let appleApiKey = appleApiKeyPath;

  if (!appleApiKey && appleApiKeyInline) {
    if (!appleApiKeyId) {
      throw new Error(
        "APPLE_API_KEY_ID is required when APPLE_API_KEY contains inline key contents.",
      );
    }

    tempDir = mkdtempSync(join(tmpdir(), "acon-notary-"));
    appleApiKey = join(tempDir, `AuthKey_${appleApiKeyId}.p8`);
    writeFileSync(appleApiKey, `${appleApiKeyInline.trim()}\n`, {
      mode: 0o600,
    });
  }

  return {
    cleanup() {
      if (tempDir) {
        rmSync(tempDir, { force: true, recursive: true });
      }
    },
    options: {
      appleApiKey,
      ...(appleApiIssuer ? { appleApiIssuer } : {}),
    },
  };
}

function resolveAppleIdAuth() {
  const appleId = process.env.APPLE_ID?.trim();
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD?.trim();
  const teamId = process.env.APPLE_TEAM_ID?.trim();

  if (!appleId && !appleIdPassword && !teamId) {
    return null;
  }

  if (!appleId || !appleIdPassword || !teamId) {
    throw new Error(
      "APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID must all be set together.",
    );
  }

  return {
    appleId,
    appleIdPassword,
    teamId,
  };
}

function resolveNotarizeAuth() {
  const keychainProfileAuth = resolveKeychainProfileAuth();
  if (keychainProfileAuth) {
    return {
      cleanup() {},
      options: keychainProfileAuth,
    };
  }

  const apiKeyAuth = resolveApiKeyAuth();
  if (apiKeyAuth) {
    return apiKeyAuth;
  }

  const appleIdAuth = resolveAppleIdAuth();
  if (appleIdAuth) {
    return {
      cleanup() {},
      options: appleIdAuth,
    };
  }

  return null;
}

export default async function notarizeApp(context) {
  if (process.platform !== "darwin" || context.electronPlatformName !== "darwin") {
    return;
  }

  const auth = resolveNotarizeAuth();
  if (!auth) {
    if (process.env.APPLE_NOTARIZE === "1") {
      throw new Error(
        "APPLE_NOTARIZE=1 was set, but no notarization credentials were found. Set APPLE_KEYCHAIN_PROFILE, APPLE_API_KEY_PATH (+ APPLE_API_ISSUER when using a team key), or APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID.",
      );
    }

    log("skipping notarization because no Apple notarization credentials were found");
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = join(context.appOutDir, `${appName}.app`);

  log(`submitting ${appPath} for notarization`);
  try {
    await notarize({
      appPath,
      ...auth.options,
    });
    log(`notarization finished for ${appName}.app`);
  } finally {
    auth.cleanup();
  }
}
