import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearCustomOpenAiCompatibleProviderConfig,
  getCustomOpenAiCompatibleProcessEnv,
  readCustomOpenAiCompatibleProviderConfig,
  saveCustomOpenAiCompatibleProviderConfig,
} from "../desktop-container/backend/custom-openai-compatible-provider";
import {
  getOpenCodeAuthState,
  getPiAuthState,
} from "../desktop-container/backend/acp-provider-shared";

const originalEnv = {
  DESKTOP_DATA_DIR: process.env.DESKTOP_DATA_DIR,
  DESKTOP_RUNTIME_DIR: process.env.DESKTOP_RUNTIME_DIR,
  ACON_SECRET_STORE_BACKEND: process.env.ACON_SECRET_STORE_BACKEND,
};

const tempDirectories: string[] = [];

function createTempPaths() {
  const root = mkdtempSync(resolve(tmpdir(), "acon-custom-provider-"));
  tempDirectories.push(root);
  return {
    dataDirectory: resolve(root, "data"),
    runtimeDirectory: resolve(root, "runtime"),
  };
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

afterEach(() => {
  process.env.DESKTOP_DATA_DIR = originalEnv.DESKTOP_DATA_DIR;
  process.env.DESKTOP_RUNTIME_DIR = originalEnv.DESKTOP_RUNTIME_DIR;
  process.env.ACON_SECRET_STORE_BACKEND = originalEnv.ACON_SECRET_STORE_BACKEND;

  while (tempDirectories.length > 0) {
    rmSync(tempDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("custom OpenAI-compatible provider config", () => {
  it("writes PI and OpenCode config from one saved provider record", () => {
    const { dataDirectory, runtimeDirectory } = createTempPaths();
    process.env.DESKTOP_DATA_DIR = dataDirectory;
    process.env.DESKTOP_RUNTIME_DIR = runtimeDirectory;
    process.env.ACON_SECRET_STORE_BACKEND = "file";

    const saved = saveCustomOpenAiCompatibleProviderConfig({
      label: "Private Cluster",
      baseUrl: "https://inference.example.com/v1",
      modelId: "gpt-4.1",
      modelName: "Private GPT-4.1",
      apiKey: "secret-key",
      headers: {
        "api-version": "2025-01-01",
      },
      reasoning: true,
      imageInput: true,
      contextWindow: 262144,
      maxTokens: 32768,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
    });

    expect(saved.hasApiKey).toBe(true);
    expect(readCustomOpenAiCompatibleProviderConfig()?.label).toBe("Private Cluster");

    const piModels = readJson(
      resolve(
        runtimeDirectory,
        "providers",
        "pi",
        "home",
        ".pi",
        "agent",
        "models.json",
      ),
    );
    expect(piModels.providers).toMatchObject({
      "openai-compatible": {
        baseUrl: "https://inference.example.com/v1",
        api: "openai-completions",
        apiKey: "ACON_OPENAI_COMPATIBLE_API_KEY",
        headers: {
          "api-version": "2025-01-01",
        },
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          maxTokensField: "max_tokens",
        },
      },
    });

    const openCodeConfig = readJson(
      resolve(
        runtimeDirectory,
        "providers",
        "opencode",
        "home",
        ".config",
        "opencode",
        "opencode.json",
      ),
    );
    expect(openCodeConfig.provider).toMatchObject({
      "openai-compatible": {
        npm: "@ai-sdk/openai-compatible",
        name: "Private Cluster",
        options: {
          baseURL: "https://inference.example.com/v1",
          apiKey: "{env:ACON_OPENAI_COMPATIBLE_API_KEY}",
          headers: {
            "api-version": "2025-01-01",
          },
        },
        models: {
          "gpt-4.1": {
            name: "Private GPT-4.1",
            limit: {
              context: 262144,
              output: 32768,
            },
          },
        },
      },
    });

    expect(getPiAuthState("openai-compatible/default")).toMatchObject({
      available: true,
      label: "Private Cluster",
    });
    expect(getOpenCodeAuthState("openai-compatible/default")).toMatchObject({
      available: true,
      label: "Private Cluster",
    });

    expect(getCustomOpenAiCompatibleProcessEnv("pi")).toMatchObject({
      ACON_OPENAI_COMPATIBLE_API_KEY: {
        kind: "literal",
        value: "secret-key",
      },
    });
    expect(
      getCustomOpenAiCompatibleProcessEnv("opencode").ACON_OPENAI_COMPATIBLE_CONFIG_VERSION,
    ).toBeDefined();
  });

  it("removes only the custom provider entry and preserves other config", () => {
    const { dataDirectory, runtimeDirectory } = createTempPaths();
    process.env.DESKTOP_DATA_DIR = dataDirectory;
    process.env.DESKTOP_RUNTIME_DIR = runtimeDirectory;
    process.env.ACON_SECRET_STORE_BACKEND = "file";

    const piModelsPath = resolve(
      runtimeDirectory,
      "providers",
      "pi",
      "home",
      ".pi",
      "agent",
      "models.json",
    );
    const openCodeConfigPath = resolve(
      runtimeDirectory,
      "providers",
      "opencode",
      "home",
      ".config",
      "opencode",
      "opencode.json",
    );

    mkdirSync(resolve(piModelsPath, ".."), { recursive: true });
    mkdirSync(resolve(openCodeConfigPath, ".."), { recursive: true });

    writeFileSync(
      piModelsPath,
      JSON.stringify({
        providers: {
          openrouter: {
            apiKey: "OPENROUTER_API_KEY",
          },
        },
      }),
      "utf8",
    );
    writeFileSync(
      openCodeConfigPath,
      JSON.stringify({
        provider: {
          anthropic: {
            options: {
              apiKey: "{env:ANTHROPIC_API_KEY}",
            },
          },
        },
      }),
      "utf8",
    );

    saveCustomOpenAiCompatibleProviderConfig({
      baseUrl: "https://example.com/v1",
      modelId: "custom-model",
      apiKey: "replace-me",
    });

    clearCustomOpenAiCompatibleProviderConfig();

    expect(readCustomOpenAiCompatibleProviderConfig()).toBeNull();
    expect(getCustomOpenAiCompatibleProcessEnv("pi")).toEqual({});
    expect(getPiAuthState("openai-compatible/default")).toMatchObject({
      available: false,
    });

    expect(readJson(piModelsPath)).toEqual({
      providers: {
        openrouter: {
          apiKey: "OPENROUTER_API_KEY",
        },
      },
    });
    expect(readJson(openCodeConfigPath)).toEqual({
      provider: {
        anthropic: {
          options: {
            apiKey: "{env:ANTHROPIC_API_KEY}",
          },
        },
      },
    });
  });

  it("keeps the stored API key when the field is left blank on update", () => {
    const { dataDirectory, runtimeDirectory } = createTempPaths();
    process.env.DESKTOP_DATA_DIR = dataDirectory;
    process.env.DESKTOP_RUNTIME_DIR = runtimeDirectory;
    process.env.ACON_SECRET_STORE_BACKEND = "file";

    saveCustomOpenAiCompatibleProviderConfig({
      baseUrl: "https://example.com/v1",
      modelId: "custom-model",
      apiKey: "first-secret",
    });

    const updated = saveCustomOpenAiCompatibleProviderConfig({
      baseUrl: "https://example.com/v2",
      modelId: "custom-model-2",
      apiKey: "",
    });

    expect(updated.hasApiKey).toBe(true);
    expect(getCustomOpenAiCompatibleProcessEnv("pi")).toMatchObject({
      ACON_OPENAI_COMPATIBLE_API_KEY: {
        kind: "literal",
        value: "first-secret",
      },
    });
  });
});
