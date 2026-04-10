import type { DesktopPreviewTarget } from "./protocol";

const TRANSFER_PREVIEW_PREFIXES = [
  {
    prefix: "/mnt/user-uploads/",
    source: "upload" as const,
  },
  {
    prefix: "/mnt/user-outputs/",
    source: "output" as const,
  },
];

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

export function normalizeTransferredPreviewPath(path: string): {
  source: "upload" | "output";
  path: string;
} | null {
  const trimmed = path.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  for (const candidate of TRANSFER_PREVIEW_PREFIXES) {
    if (!normalized.startsWith(candidate.prefix)) {
      continue;
    }
    const relativePath = normalized.slice(candidate.prefix.length).replace(/^\/+/, "");
    if (!relativePath) {
      return null;
    }
    return {
      source: candidate.source,
      path: relativePath,
    };
  }

  return null;
}
