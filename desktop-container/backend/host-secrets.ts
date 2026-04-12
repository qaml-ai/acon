import { HostSecretStore } from "./secret-store";

const HOST_SECRET_REF_NAMESPACE = "host-secret-refs";

function normalizeSecretRef(secretRef: string | null | undefined): string | null {
  if (typeof secretRef !== "string") {
    return null;
  }
  const normalized = secretRef.trim();
  return normalized ? normalized : null;
}

function getHostSecretStore(dataDirectory: string): HostSecretStore {
  return new HostSecretStore({
    dataDirectory,
    namespace: HOST_SECRET_REF_NAMESPACE,
  });
}

export function getPersistedHostSecret(
  dataDirectory: string,
  secretRef: string,
): string | null {
  const normalizedSecretRef = normalizeSecretRef(secretRef);
  if (!normalizedSecretRef) {
    throw new Error("Secret ref must be a non-empty string.");
  }
  return getHostSecretStore(dataDirectory).load(normalizedSecretRef);
}

export function setPersistedHostSecret(
  dataDirectory: string,
  secretRef: string,
  value: string | null | undefined,
): void {
  const normalizedSecretRef = normalizeSecretRef(secretRef);
  if (!normalizedSecretRef) {
    throw new Error("Secret ref must be a non-empty string.");
  }

  const normalizedValue =
    typeof value === "string" && value.trim() ? value.trim() : null;
  const store = getHostSecretStore(dataDirectory);
  if (!normalizedValue) {
    store.delete(normalizedSecretRef);
    return;
  }
  store.save(normalizedSecretRef, normalizedValue);
}

export function deletePersistedHostSecret(
  dataDirectory: string,
  secretRef: string,
): void {
  const normalizedSecretRef = normalizeSecretRef(secretRef);
  if (!normalizedSecretRef) {
    return;
  }
  getHostSecretStore(dataDirectory).delete(normalizedSecretRef);
}

export function resolvePersistedSecretRefs(
  dataDirectory: string,
  secretRefs: Record<string, string>,
  label: string,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, secretRef] of Object.entries(secretRefs)) {
    const normalizedSecretRef = normalizeSecretRef(secretRef);
    if (!normalizedSecretRef) {
      throw new Error(`${label} secret ref for ${key} must be a non-empty string.`);
    }
    const value = getPersistedHostSecret(dataDirectory, normalizedSecretRef);
    if (!value) {
      throw new Error(
        `${label} secret ref ${normalizedSecretRef} for ${key} was not found.`,
      );
    }
    resolved[key] = value;
  }
  return resolved;
}
