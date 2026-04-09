import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

export type HostSecretStoreBackend = "file" | "keychain";

const HOST_SECRET_DIRECTORY_NAME = "host-secrets";
const HOST_SECRET_SERVICE_PREFIX = "acon";

function normalizeSecretKeyComponent(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return normalized;
}

function getSecretDirectory(dataDirectory: string, namespace: string): string {
  return resolve(
    dataDirectory,
    HOST_SECRET_DIRECTORY_NAME,
    encodeURIComponent(namespace),
  );
}

function getSecretFilePath(
  dataDirectory: string,
  namespace: string,
  key: string,
): string {
  return resolve(
    getSecretDirectory(dataDirectory, namespace),
    `${encodeURIComponent(key)}.secret`,
  );
}

function getSecurityCommandError(result: ReturnType<typeof spawnSync>): string {
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  return stderr || stdout || `security exited with status ${result.status ?? "unknown"}.`;
}

function isSecurityItemMissing(result: ReturnType<typeof spawnSync>): boolean {
  return [result.stdout, result.stderr]
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .some((entry) => entry.toLowerCase().includes("could not be found"));
}

export function resolveHostSecretStoreBackend(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): HostSecretStoreBackend {
  const configured = env.ACON_SECRET_STORE_BACKEND?.trim();
  if (configured === "file" || configured === "keychain") {
    return configured;
  }
  return platform === "darwin" ? "keychain" : "file";
}

export class HostSecretStore {
  private readonly backend: HostSecretStoreBackend;
  private readonly namespace: string;

  constructor(
    private readonly options: {
      dataDirectory: string;
      namespace: string;
    },
  ) {
    this.namespace = normalizeSecretKeyComponent(options.namespace, "Secret namespace");
    this.backend = resolveHostSecretStoreBackend();
  }

  load(key: string): string | null {
    const normalizedKey = normalizeSecretKeyComponent(key, "Secret key");
    return this.backend === "keychain"
      ? this.loadFromKeychain(normalizedKey)
      : this.loadFromFile(normalizedKey);
  }

  save(key: string, value: string): void {
    const normalizedKey = normalizeSecretKeyComponent(key, "Secret key");
    if (!value.trim()) {
      throw new Error("Secret value must be a non-empty string.");
    }
    if (this.backend === "keychain") {
      this.saveToKeychain(normalizedKey, value);
      return;
    }
    this.saveToFile(normalizedKey, value);
  }

  delete(key: string): void {
    const normalizedKey = normalizeSecretKeyComponent(key, "Secret key");
    if (this.backend === "keychain") {
      this.deleteFromKeychain(normalizedKey);
      return;
    }
    this.deleteFromFile(normalizedKey);
  }

  private get keychainServiceName(): string {
    return `${HOST_SECRET_SERVICE_PREFIX}:${this.namespace}`;
  }

  private loadFromKeychain(key: string): string | null {
    const result = spawnSync(
      "security",
      [
        "find-generic-password",
        "-a",
        key,
        "-w",
        "-s",
        this.keychainServiceName,
      ],
      {
        encoding: "utf8",
        env: process.env,
        maxBuffer: 1024 * 1024,
      },
    );

    if (result.status !== 0) {
      if (isSecurityItemMissing(result)) {
        return null;
      }
      throw new Error(
        `Failed to read secret ${key} from macOS Keychain: ${getSecurityCommandError(result)}`,
      );
    }

    return typeof result.stdout === "string"
      ? result.stdout.replace(/\r?\n$/, "")
      : null;
  }

  private saveToKeychain(key: string, value: string): void {
    const result = spawnSync(
      "security",
      [
        "add-generic-password",
        "-U",
        "-a",
        key,
        "-s",
        this.keychainServiceName,
        "-w",
        value,
      ],
      {
        encoding: "utf8",
        env: process.env,
        maxBuffer: 1024 * 1024,
      },
    );

    if (result.status !== 0) {
      throw new Error(
        `Failed to save secret ${key} to macOS Keychain: ${getSecurityCommandError(result)}`,
      );
    }
  }

  private deleteFromKeychain(key: string): void {
    const result = spawnSync(
      "security",
      [
        "delete-generic-password",
        "-a",
        key,
        "-s",
        this.keychainServiceName,
      ],
      {
        encoding: "utf8",
        env: process.env,
        maxBuffer: 1024 * 1024,
      },
    );

    if (result.status !== 0 && !isSecurityItemMissing(result)) {
      throw new Error(
        `Failed to delete secret ${key} from macOS Keychain: ${getSecurityCommandError(result)}`,
      );
    }
  }

  private loadFromFile(key: string): string | null {
    const secretPath = getSecretFilePath(
      this.options.dataDirectory,
      this.namespace,
      key,
    );
    if (!existsSync(secretPath)) {
      return null;
    }

    return readFileSync(secretPath, "utf8");
  }

  private saveToFile(key: string, value: string): void {
    const directory = getSecretDirectory(
      this.options.dataDirectory,
      this.namespace,
    );
    const secretPath = getSecretFilePath(
      this.options.dataDirectory,
      this.namespace,
      key,
    );
    mkdirSync(directory, {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(secretPath, value, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(secretPath, 0o600);
  }

  private deleteFromFile(key: string): void {
    const secretPath = getSecretFilePath(
      this.options.dataDirectory,
      this.namespace,
      key,
    );
    rmSync(secretPath, { force: true });
  }
}
