import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type AgentExtensionThreadStateValue =
  | null
  | boolean
  | number
  | string
  | AgentExtensionThreadStateValue[]
  | { [key: string]: AgentExtensionThreadStateValue };

export interface AgentExtensionThreadStateStore {
  readonly pluginId: string;
  readonly threadId: string | null;
  get<T extends AgentExtensionThreadStateValue = AgentExtensionThreadStateValue>(
    key: string,
  ): T | undefined;
  set(key: string, value: AgentExtensionThreadStateValue): void;
  delete(key: string): void;
  clear(): void;
  snapshot(): Record<string, AgentExtensionThreadStateValue>;
}

interface CreateAgentExtensionThreadStateStoreOptions {
  pluginId: string;
  threadId: string | null;
  threadStateDirectory: string | null;
}

function readStateFile(
  path: string | null,
): Record<string, AgentExtensionThreadStateValue> {
  if (!path) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, AgentExtensionThreadStateValue>;
  } catch {
    return {};
  }
}

function writeStateFile(
  path: string | null,
  value: Record<string, AgentExtensionThreadStateValue>,
): void {
  if (!path) {
    return;
  }

  if (Object.keys(value).length === 0) {
    rmSync(path, { force: true });
    return;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function createAgentExtensionThreadStateStore({
  pluginId,
  threadId,
  threadStateDirectory,
}: CreateAgentExtensionThreadStateStoreOptions): AgentExtensionThreadStateStore {
  const statePath =
    threadId && threadStateDirectory
      ? resolve(threadStateDirectory, `${pluginId}.json`)
      : null;

  return {
    pluginId,
    threadId,
    get<T extends AgentExtensionThreadStateValue = AgentExtensionThreadStateValue>(
      key: string,
    ): T | undefined {
      return readStateFile(statePath)[key] as T | undefined;
    },
    set(key, value) {
      const nextState = readStateFile(statePath);
      nextState[key] = value;
      writeStateFile(statePath, nextState);
    },
    delete(key) {
      const nextState = readStateFile(statePath);
      delete nextState[key];
      writeStateFile(statePath, nextState);
    },
    clear() {
      writeStateFile(statePath, {});
    },
    snapshot() {
      return readStateFile(statePath);
    },
  };
}
