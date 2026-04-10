export const DESKTOP_WORKSPACE_ID = 'desktop';

const TEMP_FILE_PREFIXES = [
  {
    prefix: '/mnt/user-uploads/',
    type: 'upload' as const,
    urlSegment: 'uploads' as const,
  },
  {
    prefix: '/mnt/user-outputs/',
    type: 'output' as const,
    urlSegment: 'outputs' as const,
  },
];

const WORKSPACE_TEMP_URL_REGEX = /^\/api\/workspaces\/[^/]+\/(uploads|outputs)\/(.+)$/;
const TEMP_FILE_HREF_REGEX = /^\/mnt\/user-(uploads|outputs)\/(.+)$/;

export function encodePathSegments(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function decodePathSegments(path: string): string {
  return path
    .split('/')
    .map((segment) => decodeURIComponent(segment))
    .join('/');
}

export function getTempFileInfo(input: string) {
  const trimmed = input?.trim?.() ?? '';
  if (!trimmed) return null;
  const normalized = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;

  for (const { prefix, type, urlSegment } of TEMP_FILE_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      const relativePath = normalized.slice(prefix.length);
      if (!relativePath) return null;
      return { type, relativePath, urlSegment };
    }
  }

  return null;
}

function getPathnameFromHref(href: string): string {
  if (href.startsWith('/')) {
    return href;
  }

  try {
    const parsed = new URL(href);
    return parsed.pathname;
  } catch {
    return href;
  }
}

export function resolvePreviewableTempFilePathFromHref(href: string): string | null {
  const pathname = getPathnameFromHref(href.trim());

  const tempFileMatch = TEMP_FILE_HREF_REGEX.exec(pathname);
  if (tempFileMatch) {
    const [, bucket, encodedPath] = tempFileMatch;
    const root =
      bucket === 'uploads' ? '/mnt/user-uploads/' : '/mnt/user-outputs/';
    return `${root}${decodePathSegments(encodedPath)}`;
  }

  const workspaceMatch = WORKSPACE_TEMP_URL_REGEX.exec(pathname);
  if (!workspaceMatch) {
    return null;
  }

  const [, bucket, encodedPath] = workspaceMatch;
  const root =
    bucket === 'uploads' ? '/mnt/user-uploads/' : '/mnt/user-outputs/';
  return `${root}${decodePathSegments(encodedPath)}`;
}
