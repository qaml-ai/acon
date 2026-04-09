import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_FETCH_MAX_BODY_BYTES = 256 * 1024;

function normalizeOptionalString(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function requireBaseUrl() {
  const baseUrl = normalizeOptionalString(process.env.REST_API_BASE_URL);
  if (!baseUrl) {
    throw new Error("REST_API_BASE_URL must be set.");
  }
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("REST_API_BASE_URL must use http:// or https://.");
  }
  return url.toString();
}

function buildRequestUrl(baseUrl, path, query) {
  let url = baseUrl;
  const normalizedPath = normalizeOptionalString(path);
  if (normalizedPath) {
    if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(normalizedPath)) {
      throw new Error("REST API fetch path must be relative to the configured base URL.");
    }
    url = `${baseUrl.replace(/\/+$/, "")}/${normalizedPath.replace(/^\/+/, "")}`;
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

function buildAuthHeaders() {
  const authType = normalizeOptionalString(process.env.REST_API_AUTH_TYPE) ?? "none";
  if (authType === "none") {
    return {};
  }

  const secret = normalizeOptionalString(process.env.REST_API_AUTH_SECRET);
  if (!secret) {
    throw new Error("REST_API_AUTH_SECRET must be set when auth is enabled.");
  }

  if (authType === "bearer") {
    return {
      Authorization: `Bearer ${secret}`,
    };
  }

  if (authType === "header") {
    const headerName =
      normalizeOptionalString(process.env.REST_API_AUTH_HEADER_NAME) ?? "x-api-key";
    return {
      [headerName]: secret,
    };
  }

  throw new Error(`Unsupported REST_API_AUTH_TYPE: ${authType}`);
}

function normalizeResponseHeaders(headers) {
  const normalized = {};
  headers.forEach((value, key) => {
    normalized[key] = value;
  });
  return normalized;
}

function parseJsonBody(contentType, body) {
  if (!contentType?.toLowerCase().includes("application/json")) {
    return null;
  }

  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
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

async function main() {
  const baseUrl = requireBaseUrl();
  const server = new McpServer({
    name: "acon-rest-api",
    version: "0.1.0",
  });

  server.registerTool(
    "fetch",
    {
      description:
        "Fetch an HTTP endpoint relative to the configured REST_API_BASE_URL. Optional auth is injected from environment variables.",
      inputSchema: fetchInputSchema,
      outputSchema: fetchOutputSchema,
    },
    async (input) => {
      const requestUrl = buildRequestUrl(baseUrl, input.path, input.query);
      const method = input.method ?? (input.body || input.jsonBody !== undefined ? "POST" : "GET");
      const headers = {
        ...buildAuthHeaders(),
        ...(input.headers ?? {}),
      };

      let requestBody;
      if (input.jsonBody !== undefined) {
        headers["content-type"] = headers["content-type"] ?? "application/json";
        requestBody = JSON.stringify(input.jsonBody);
      } else if (input.body !== undefined) {
        requestBody = input.body;
      }

      const timeoutMs = input.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
      const maxBodyBytes = input.maxBodyBytes ?? DEFAULT_FETCH_MAX_BODY_BYTES;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(requestUrl, {
          method,
          headers,
          body: requestBody,
          signal: controller.signal,
        });
        const buffer = Buffer.from(await response.arrayBuffer());
        const truncated = buffer.byteLength > maxBodyBytes;
        const body = buffer.subarray(0, maxBodyBytes).toString("utf8");
        const contentType = response.headers.get("content-type");
        const structuredContent = {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          url: response.url,
          headers: normalizeResponseHeaders(response.headers),
          body,
          truncated,
          json: parseJsonBody(contentType, body),
        };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(structuredContent, null, 2),
            },
          ],
          structuredContent,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exit(1);
});
