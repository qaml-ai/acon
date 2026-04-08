import type { DesktopPreviewTarget } from "./protocol";

function getBasename(path: string): string {
  return path.split("/").filter(Boolean).pop() || path;
}

function normalizePathForId(path: string): string {
  return path.trim().replace(/\s+/g, " ");
}

export function getDesktopPreviewItemId(target: DesktopPreviewTarget): string {
  if (target.kind === "url") {
    return `url:${target.url.trim()}`;
  }

  return `file:${target.source}:${normalizePathForId(target.path)}`;
}

export function getDesktopPreviewItemTitle(target: DesktopPreviewTarget): string {
  if (target.kind === "url") {
    const explicitTitle = target.title?.trim();
    if (explicitTitle) {
      return explicitTitle;
    }

    try {
      const url = new URL(target.url);
      return url.hostname || target.url;
    } catch {
      return target.url;
    }
  }

  const explicitTitle = target.title?.trim() || target.filename?.trim();
  if (explicitTitle) {
    return explicitTitle;
  }

  return getBasename(target.path);
}

export function normalizeWorkspacePreviewPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return "";
  }

  const normalized = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  for (const prefix of ["/workspace", "/home/claude", "/root"]) {
    if (normalized === prefix) {
      return "/";
    }
    if (normalized.startsWith(`${prefix}/`)) {
      return normalized.slice(prefix.length) || "/";
    }
  }

  return normalized;
}

function encodeHex(text: string): string {
  return Array.from(text)
    .map((char) => char.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("");
}

function decodeHex(text: string): string | null {
  if (!text || text.length % 2 !== 0 || /[^0-9a-f]/i.test(text)) {
    return null;
  }

  let decoded = "";
  for (let index = 0; index < text.length; index += 2) {
    decoded += String.fromCharCode(Number.parseInt(text.slice(index, index + 2), 16));
  }
  return decoded;
}

export function encodeDesktopPreviewProxyHost(
  threadId: string,
  itemId: string,
): string {
  return `item-${encodeHex(`${threadId}\n${itemId}`)}`;
}

export function decodeDesktopPreviewProxyHost(
  host: string,
): { threadId: string; itemId: string } | null {
  if (!host.startsWith("item-")) {
    return null;
  }

  const decoded = decodeHex(host.slice("item-".length));
  if (!decoded) {
    return null;
  }

  const separatorIndex = decoded.indexOf("\n");
  if (separatorIndex === -1) {
    return null;
  }

  const threadId = decoded.slice(0, separatorIndex).trim();
  const itemId = decoded.slice(separatorIndex + 1).trim();
  if (!threadId || !itemId) {
    return null;
  }

  return {
    threadId,
    itemId,
  };
}

export function isGuestLocalPreviewUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(
      parsed.hostname,
    );
  } catch {
    return false;
  }
}
