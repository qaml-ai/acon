import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  deletePersistedHostSecret,
  getPersistedHostSecret,
  setPersistedHostSecret,
} from "./host-secrets";

const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_FETCH_MAX_BODY_BYTES = 256 * 1024;
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;

export interface HttpWrapperAuthConfig {
  type: "none" | "bearer" | "header";
  secretRef: string | null;
  headerName: string | null;
}

export interface HttpWrapperServerParameters {
  baseUrl: string;
  dataDirectory: string;
  id: string;
  auth: HttpWrapperAuthConfig | null;
  name?: string | null;
  version?: string | null;
}

const fetchInputSchema = z.object({
  path: z.string().optional(),
  method: z.enum(HTTP_METHODS).optional(),
  query: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  jsonBody: z.unknown().optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
  maxBodyBytes: z.number().int().positive().max(2 * 1024 * 1024).optional(),
});

const fetchOutputSchema = z.object({
  ok: z.boolean(),
  status: z.number().int(),
  statusText: z.string(),
  url: z.string(),
  headers: z.record(z.string(), z.string()),
  body: z.string(),
  truncated: z.boolean(),
  json: z.unknown().nullable().optional(),
});

function normalizeOptionalString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function normalizeHeaderName(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalString(value);
  return normalized ?? null;
}

export function getPersistedHttpWrapperSecret(
  dataDirectory: string,
  secretRef: string,
): string | null {
  return getPersistedHostSecret(dataDirectory, secretRef);
}

export function setPersistedHttpWrapperSecret(
  dataDirectory: string,
  secretRef: string,
  value: string | null | undefined,
): void {
  const normalizedSecretRef = normalizeOptionalString(secretRef);
  if (!normalizedSecretRef) {
    throw new Error("HTTP wrapper secretRef must be a non-empty string.");
  }
  setPersistedHostSecret(dataDirectory, normalizedSecretRef, value);
}

export function deletePersistedHttpWrapperSecret(
  dataDirectory: string,
  secretRef: string,
): void {
  const normalizedSecretRef = normalizeOptionalString(secretRef);
  if (!normalizedSecretRef) {
    return;
  }
  deletePersistedHostSecret(dataDirectory, normalizedSecretRef);
}

function normalizeAuthConfig(auth: HttpWrapperAuthConfig | null | undefined): HttpWrapperAuthConfig {
  const type = auth?.type ?? "none";
  if (type === "none") {
    return {
      type: "none",
      secretRef: null,
      headerName: null,
    };
  }

  const secretRef = normalizeOptionalString(auth?.secretRef);
  if (!secretRef) {
    throw new Error(`HTTP wrapper auth type ${type} requires a secretRef.`);
  }

  if (type === "bearer") {
    return {
      type: "bearer",
      secretRef,
      headerName: "Authorization",
    };
  }

  const headerName = normalizeHeaderName(auth?.headerName);
  if (!headerName) {
    throw new Error("HTTP wrapper header auth requires a headerName.");
  }

  return {
    type: "header",
    secretRef,
    headerName,
  };
}

function buildRequestUrl(
  baseUrl: string,
  path: string | undefined,
  query: Record<string, string | number | boolean | null> | undefined,
): URL {
  const base = normalizeOptionalString(baseUrl);
  if (!base) {
    throw new Error("HTTP wrapper baseUrl must be a non-empty string.");
  }

  let url = base;
  const normalizedPath = normalizeOptionalString(path);
  if (normalizedPath) {
    if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(normalizedPath)) {
      throw new Error("HTTP wrapper fetch path must be relative to the configured baseUrl.");
    }
    url = `${base.replace(/\/+$/, "")}/${normalizedPath.replace(/^\/+/, "")}`;
  }

  const requestUrl = new URL(url);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === null) {
        continue;
      }
      requestUrl.searchParams.set(key, String(value));
    }
  }
  return requestUrl;
}

function buildAuthHeaders(
  auth: HttpWrapperAuthConfig | null,
  dataDirectory: string,
): Record<string, string> {
  const normalizedAuth = normalizeAuthConfig(auth);
  if (normalizedAuth.type === "none") {
    return {};
  }

  const secret = getPersistedHttpWrapperSecret(
    dataDirectory,
    normalizedAuth.secretRef ?? "",
  );
  if (!secret) {
    throw new Error(
      `HTTP wrapper auth secret ${normalizedAuth.secretRef ?? "<missing>"} was not found.`,
    );
  }

  if (normalizedAuth.type === "bearer") {
    return {
      Authorization: `Bearer ${secret}`,
    };
  }

  return {
    [normalizedAuth.headerName ?? "x-api-key"]: secret,
  };
}

function normalizeResponseHeaders(headers: Headers): Record<string, string> {
  const normalized: Record<string, string> = {};
  headers.forEach((value, key) => {
    normalized[key] = value;
  });
  return normalized;
}

function parseJsonBody(contentType: string | null, body: string): unknown | null {
  if (!contentType?.toLowerCase().includes("application/json")) {
    return null;
  }

  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

export function createHttpWrapperHostMcpServer(
  parameters: HttpWrapperServerParameters,
) {
  const server = new McpServer({
    name: parameters.name?.trim() || parameters.id,
    version: parameters.version?.trim() || "1.0.0",
  });

  server.registerTool(
    "fetch",
    {
      description:
        "Fetch an HTTP endpoint relative to the wrapper's configured baseUrl. Optional auth is injected from the host secret store.",
      inputSchema: fetchInputSchema,
      outputSchema: fetchOutputSchema,
    },
    async (input) => {
      const requestUrl = buildRequestUrl(
        parameters.baseUrl,
        input.path,
        input.query,
      );
      const method = input.method ?? "GET";
      const timeoutMs = input.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
      const maxBodyBytes = input.maxBodyBytes ?? DEFAULT_FETCH_MAX_BODY_BYTES;
      const headers = {
        ...(input.headers ?? {}),
        ...buildAuthHeaders(parameters.auth, parameters.dataDirectory),
      };

      let body: string | undefined;
      if (input.jsonBody !== undefined) {
        body = JSON.stringify(input.jsonBody);
        if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
          headers["content-type"] = "application/json";
        }
      } else if (typeof input.body === "string") {
        body = input.body;
      }

      const abortController = new AbortController();
      const timeoutHandle = setTimeout(() => {
        abortController.abort(
          new Error(`HTTP wrapper request timed out after ${timeoutMs}ms.`),
        );
      }, timeoutMs);

      try {
        const response = await fetch(requestUrl, {
          method,
          headers,
          body,
          signal: abortController.signal,
        });
        const responseBuffer = Buffer.from(await response.arrayBuffer());
        const truncated = responseBuffer.length > maxBodyBytes;
        const limitedBuffer = truncated
          ? responseBuffer.subarray(0, maxBodyBytes)
          : responseBuffer;
        const responseBody = limitedBuffer.toString("utf8");
        const structuredContent = {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          url: response.url,
          headers: normalizeResponseHeaders(response.headers),
          body: responseBody,
          truncated,
          json: parseJsonBody(response.headers.get("content-type"), responseBody),
        };

        return {
          content: [
            {
              type: "text",
              text: `${method} ${requestUrl.toString()} -> ${response.status} ${response.statusText}`,
            },
          ],
          structuredContent,
        };
      } finally {
        clearTimeout(timeoutHandle);
      }
    },
  );

  return server;
}
