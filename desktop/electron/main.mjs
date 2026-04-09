import { app, BrowserWindow, dialog, ipcMain, nativeTheme, protocol, shell, net } from 'electron';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'desktop-plugin',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

const __dirname = dirname(fileURLToPath(import.meta.url));
const devRendererUrl = process.env.DESKTOP_RENDERER_URL;
const repoRoot = resolve(__dirname, '../..');
let backendProcess = null;
let directDesktopService = null;
let unsubscribeDesktopService = null;
let isQuitting = false;
let backendStdoutBuffer = '';
let latestSnapshot = null;
let backendReadyPromise = null;
const startupProbeEnabled = process.env.DESKTOP_STARTUP_PROBE === '1';
const startupProbeTimeoutMs = Number(
  process.env.DESKTOP_STARTUP_PROBE_TIMEOUT_MS || '90000',
);
const startupEvents = [];
let startupProbeResolved = false;
let startupProbeTimeout = null;
let startupProbeRendererReady = null;
let pendingPluginRefresh = null;
let backendCleanupDone = false;

async function showHostMcpPermissionDialog(request) {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? undefined;
  const actionLabel =
    request.action === 'create'
      ? 'Create host MCP server'
      : request.action === 'update'
        ? 'Update host MCP server'
        : 'Delete host MCP server';
  const detailLines = [
    `Server ID: ${request.serverId}`,
    `Transport: ${request.transport}`,
    request.name ? `Name: ${request.name}` : null,
    request.command ? `Command: ${request.command}` : null,
    request.args.length > 0 ? `Args: ${request.args.join(' ')}` : null,
    request.cwd ? `Working directory: ${request.cwd}` : null,
    request.url ? `URL: ${request.url}` : null,
    request.version ? `Version: ${request.version}` : null,
    `Requested by plugin: ${request.pluginId}`,
    `Harness: ${request.harness}`,
  ].filter(Boolean);
  const response = await dialog.showMessageBox(window, {
    type: 'warning',
    buttons: ['Approve', 'Deny'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: actionLabel,
    message: `${actionLabel}?`,
    detail: detailLines.join('\n'),
  });
  return response.response === 0;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function showSecretPromptDialog(request) {
  const parentWindow =
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? undefined;
  const channel = `acon-secret-prompt:${request.id}`;

  return await new Promise((resolve) => {
    let settled = false;
    const window = new BrowserWindow({
      parent: parentWindow,
      modal: Boolean(parentWindow),
      width: 460,
      height: 280,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      autoHideMenuBar: true,
      title: request.title || 'Store Secret',
      backgroundColor: getWindowBackgroundColor(),
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });

    const cleanup = () => {
      ipcMain.removeAllListeners(channel);
    };

    ipcMain.once(channel, (_event, payload) => {
      settled = true;
      cleanup();
      const secretValue =
        payload && typeof payload === 'object' && typeof payload.secretValue === 'string'
          ? payload.secretValue
          : null;
      window.close();
      resolve({
        approved: Boolean(secretValue && secretValue.trim()),
        secretValue,
      });
    });

    window.on('closed', () => {
      if (settled) {
        return;
      }
      cleanup();
      resolve({
        approved: false,
        secretValue: null,
      });
    });

    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(request.title || 'Store Secret')}</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #0f172a;
        color: #e2e8f0;
      }
      main {
        width: min(26rem, calc(100vw - 2rem));
        padding: 1.25rem;
        border-radius: 0.9rem;
        background: rgba(15, 23, 42, 0.96);
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
        border: 1px solid rgba(148, 163, 184, 0.18);
      }
      h1 {
        margin: 0 0 0.75rem;
        font-size: 1.1rem;
      }
      p {
        margin: 0 0 0.9rem;
        line-height: 1.5;
        color: #cbd5e1;
        white-space: pre-wrap;
      }
      .meta {
        margin-bottom: 0.9rem;
        font-size: 0.85rem;
        color: #94a3b8;
      }
      label {
        display: block;
        margin-bottom: 0.4rem;
        font-size: 0.9rem;
      }
      input {
        width: 100%;
        box-sizing: border-box;
        padding: 0.65rem 0.75rem;
        border-radius: 0.6rem;
        border: 1px solid rgba(148, 163, 184, 0.24);
        background: rgba(15, 23, 42, 0.85);
        color: inherit;
      }
      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 0.75rem;
        margin-top: 1rem;
      }
      button {
        border: 0;
        border-radius: 999px;
        padding: 0.6rem 0.95rem;
        cursor: pointer;
      }
      .cancel {
        background: rgba(51, 65, 85, 0.9);
        color: #e2e8f0;
      }
      .submit {
        background: #e2e8f0;
        color: #0f172a;
        font-weight: 600;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(request.title || 'Store Secret')}</h1>
      ${
        request.message
          ? `<p>${escapeHtml(request.message)}</p>`
          : ''
      }
      <div class="meta">Reference: ${escapeHtml(request.secretRef)}</div>
      <label for="secret-input">${escapeHtml(request.fieldLabel || 'Secret')}</label>
      <input id="secret-input" type="password" autocomplete="off" autofocus />
      <div class="actions">
        <button class="cancel" type="button" id="cancel-button">Cancel</button>
        <button class="submit" type="button" id="submit-button">Store</button>
      </div>
    </main>
    <script>
      const { ipcRenderer } = require('electron');
      const channel = ${JSON.stringify(channel)};
      const input = document.getElementById('secret-input');
      document.getElementById('cancel-button').addEventListener('click', () => {
        window.close();
      });
      document.getElementById('submit-button').addEventListener('click', () => {
        ipcRenderer.send(channel, { secretValue: input.value });
      });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          ipcRenderer.send(channel, { secretValue: input.value });
        }
        if (event.key === 'Escape') {
          window.close();
        }
      });
    </script>
  </body>
</html>`;

    window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(
      () => {
        window.close();
      },
    );
    window.once('ready-to-show', () => {
      applyWindowAppearance(window);
      window.show();
    });
  });
}

function getWindowBackgroundColor() {
  return nativeTheme.shouldUseDarkColors ? '#09090b' : '#f5f5f4';
}

function applyWindowAppearance(window) {
  window.setBackgroundColor(getWindowBackgroundColor());
}

function recordStartup(stage, detail = {}) {
  const event = {
    at: new Date().toISOString(),
    stage,
    ...detail,
  };
  startupEvents.push(event);
  if (startupProbeEnabled) {
    process.stderr.write(`[desktop-startup] ${JSON.stringify(event)}\n`);
  }
}

function finishStartupProbe(ok, detail = {}) {
  if (!startupProbeEnabled || startupProbeResolved) {
    return;
  }
  startupProbeResolved = true;
  if (startupProbeTimeout) {
    clearTimeout(startupProbeTimeout);
    startupProbeTimeout = null;
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        ok,
        events: startupEvents,
        latestSnapshotSummary: latestSnapshot
          ? {
              provider: latestSnapshot.provider,
              authSource: latestSnapshot.auth.source,
              hasAuth: latestSnapshot.auth.available,
              runtimeState: latestSnapshot.runtimeStatus.state,
              activeThreadId: latestSnapshot.activeThreadId,
            }
          : null,
        ...detail,
      },
      null,
      2
    )}\n`
  );
  setTimeout(() => {
    app.quit();
  }, 50);
}

function cleanupBackendResources() {
  if (backendCleanupDone) {
    return;
  }

  backendCleanupDone = true;
  isQuitting = true;
  if (unsubscribeDesktopService) {
    unsubscribeDesktopService();
    unsubscribeDesktopService = null;
  }
  if (directDesktopService && typeof directDesktopService.dispose === 'function') {
    directDesktopService.dispose();
  }
  directDesktopService = null;
  if (backendProcess && backendProcess.exitCode === null) {
    backendProcess.kill('SIGTERM');
  }
}

function getDesktopResourcesDir() {
  if (process.env.DESKTOP_APP_RESOURCES_DIR) {
    return process.env.DESKTOP_APP_RESOURCES_DIR;
  }
  if (app.isPackaged) {
    return resolve(process.resourcesPath, 'desktop');
  }
  return resolve(__dirname, '..');
}

function getRendererEntry() {
  if (devRendererUrl) {
    return devRendererUrl;
  }

  const resourcesDir = getDesktopResourcesDir();
  const stagedRendererEntry = resolve(resourcesDir, 'renderer/index.html');
  if (existsSync(stagedRendererEntry)) {
    return `file://${stagedRendererEntry}`;
  }

  return `file://${resolve(__dirname, '../renderer-dist/index.html')}`;
}

function getBackendModuleEntry() {
  if (process.env.DESKTOP_BACKEND_MODULE_ENTRY) {
    return resolveDesktopOverridePath(process.env.DESKTOP_BACKEND_MODULE_ENTRY);
  }
  const resourcesDir = getDesktopResourcesDir();
  const stagedBackendModuleEntry = resolve(resourcesDir, 'backend/index.mjs');
  return existsSync(stagedBackendModuleEntry) ? stagedBackendModuleEntry : null;
}

function resolveDesktopOverridePath(target) {
  if (!target) {
    return null;
  }
  return isAbsolute(target) ? target : resolve(repoRoot, target);
}

function canResolveLocalWebviewPath(targetPath) {
  if (!targetPath || typeof targetPath !== 'string' || !isAbsolute(targetPath)) {
    return false;
  }

  try {
    return statSync(targetPath).isFile();
  } catch {
    return false;
  }
}

function toDesktopPluginUrl(entrypoint) {
  const fileUrl =
    typeof entrypoint === 'string' && entrypoint.startsWith('file:')
      ? new URL(entrypoint)
      : pathToFileURL(entrypoint);
  return `desktop-plugin://local${fileUrl.pathname}`;
}

function fromDesktopPluginUrl(requestUrl) {
  const url = new URL(requestUrl);
  if (url.protocol !== 'desktop-plugin:' || url.hostname !== 'local') {
    throw new Error(`Unsupported desktop plugin URL: ${requestUrl}`);
  }
  return fileURLToPath(`file://${url.pathname}`);
}

function getDesktopRuntimeEnv() {
  const resourcesDir = getDesktopResourcesDir();
  const userDataDirectory = app.getPath('userData');
  const dataDirectory = resolve(userDataDirectory, 'data');
  const runtimeDirectory = resolve(userDataDirectory, 'runtime');
  const stagedRuntimeHelperPath = resolve(resourcesDir, 'bin/camelai-runtime-helper');
  const devRuntimeHelperPath = resolve(__dirname, '../runtime-helper/.build/debug/camelai-runtime-helper');
  const runtimeHelperPath = existsSync(stagedRuntimeHelperPath) ? stagedRuntimeHelperPath : devRuntimeHelperPath;
  const stagedKernelPath = resolve(resourcesDir, 'kernel/vmlinux');
  const devKernelPath = resolve(__dirname, '../runtime-helper/assets/vmlinux');
  const runtimeKernelPath = existsSync(stagedKernelPath) ? stagedKernelPath : devKernelPath;
  const stagedContainerBinPath = resolve(resourcesDir, 'bin/container');
  const devBundledContainerBinPath = resolve(
    repoRoot,
    'desktop-container/vendor/apple-container/bin/container',
  );
  const stagedContainerImageRoot = resolve(resourcesDir, 'container-images');
  const devContainerImageRoot = resolve(repoRoot, 'desktop-container/container-images');
  const stagedBuiltinPluginRoot = resolve(resourcesDir, 'plugins/builtin');
  const devBuiltinPluginRoot = resolve(repoRoot, 'desktop-container/plugins/builtin');
  const containerBinPath = app.isPackaged
    ? stagedContainerBinPath
    : existsSync(devBundledContainerBinPath)
      ? devBundledContainerBinPath
      : null;
  const containerImageRoot = app.isPackaged
    ? stagedContainerImageRoot
    : devContainerImageRoot;

  const runtimeEnv = {
    DESKTOP_DATA_DIR: dataDirectory,
    DESKTOP_RUNTIME_DIR: runtimeDirectory,
    DESKTOP_RUNTIME_HELPER_PATH: runtimeHelperPath,
    DESKTOP_RUNTIME_KERNEL_PATH: runtimeKernelPath,
    DESKTOP_CONTAINER_IMAGE_ROOT: containerImageRoot,
    DESKTOP_BUILTIN_PLUGIN_DIR: app.isPackaged
      ? stagedBuiltinPluginRoot
      : devBuiltinPluginRoot,
    DESKTOP_CONTAINER_REQUIRE_BUNDLED: app.isPackaged ? '1' : '0',
  };

  if (containerBinPath) {
    runtimeEnv.DESKTOP_CONTAINER_BIN_PATH = containerBinPath;
  }

  return runtimeEnv;
}

function applyDesktopRuntimeEnv() {
  const runtimeEnv = getDesktopRuntimeEnv();
  for (const [key, value] of Object.entries(runtimeEnv)) {
    process.env[key] = value;
  }
  return runtimeEnv;
}

function ensureDirectory(path) {
  mkdirSync(path, { recursive: true });
}

function getDesktopPluginDirectory() {
  return resolve(getDesktopRuntimeEnv().DESKTOP_DATA_DIR, 'plugins');
}

function getManagedWorkspaceRoot() {
  return resolve(getDesktopRuntimeEnv().DESKTOP_DATA_DIR, 'workspaces', 'default', 'root');
}

function getTransferDirectory(kind) {
  const directory = resolve(getDesktopRuntimeEnv().DESKTOP_DATA_DIR, 'transfers', kind);
  ensureDirectory(directory);
  return directory;
}

function normalizeWorkspacePreviewPath(pathValue) {
  const trimmed = typeof pathValue === 'string' ? pathValue.trim() : '';
  if (!trimmed) {
    return '';
  }

  const normalized = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  for (const prefix of ['/workspace', '/home/claude', '/root']) {
    if (normalized === prefix) {
      return '/';
    }
    if (normalized.startsWith(`${prefix}/`)) {
      return normalized.slice(prefix.length) || '/';
    }
  }

  return normalized;
}

function resolvePathWithin(rootDirectory, targetPath) {
  const normalizedPath = typeof targetPath === 'string' ? targetPath.trim() : '';
  if (!normalizedPath) {
    throw new Error('File path is required.');
  }

  const candidate = resolve(rootDirectory, normalizedPath.replace(/^[/\\]+/, ''));
  const relativePath = relative(rootDirectory, candidate);
  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${pathSeparator()}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Path must stay within ${rootDirectory}.`);
  }
  return candidate;
}

function pathSeparator() {
  return process.platform === 'win32' ? '\\' : '/';
}

function sanitizeUploadBaseName(filename) {
  const ext = extname(filename);
  const base = basename(filename, ext);
  const sanitizedBase =
    base
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'file';
  const sanitizedExt = ext.replace(/[^A-Za-z0-9.]+/g, '').slice(0, 32);
  return { base: sanitizedBase, ext: sanitizedExt };
}

function createImportedFilename(originalName) {
  const { base, ext } = sanitizeUploadBaseName(originalName);
  return `${base}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
}

function importLocalFile(sourcePath) {
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) {
    throw new Error('Import path must be a non-empty string.');
  }

  const resolvedSourcePath = resolve(sourcePath);
  const sourceStats = statSync(resolvedSourcePath);
  if (!sourceStats.isFile()) {
    throw new Error(`${resolvedSourcePath} is not a file.`);
  }

  const uploadsDirectory = getTransferDirectory('uploads');
  const originalName = basename(resolvedSourcePath);
  const storedName = createImportedFilename(originalName);
  const destinationPath = resolve(uploadsDirectory, storedName);
  cpSync(resolvedSourcePath, destinationPath, { force: true });

  return {
    originalName,
    relativePath: storedName,
    absolutePath: destinationPath,
    size: sourceStats.size,
  };
}

function resolveDesktopFileSource(request) {
  if (!request || typeof request !== 'object') {
    throw new Error('Download request must be an object.');
  }

  const { source, path: targetPath } = request;
  if (source === 'workspace') {
    return resolvePathWithin(
      getManagedWorkspaceRoot(),
      normalizeWorkspacePreviewPath(targetPath),
    );
  }
  if (source === 'upload') {
    return resolvePathWithin(getTransferDirectory('uploads'), targetPath);
  }
  if (source === 'output') {
    return resolvePathWithin(getTransferDirectory('outputs'), targetPath);
  }

  throw new Error(`Unsupported file source: ${String(source)}`);
}

function readPluginManifestFromDirectory(pluginDirectory) {
  if (!pluginDirectory || !statSync(pluginDirectory).isDirectory()) {
    throw new Error('Plugin selection must be a directory.');
  }

  const packagePath = resolve(pluginDirectory, 'package.json');
  if (!existsSync(packagePath)) {
    throw new Error('Selected folder is missing package.json.');
  }

  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  } catch {
    throw new Error('Selected plugin package.json is not valid JSON.');
  }

  const manifest =
    packageJson?.camelai && typeof packageJson.camelai === 'object'
      ? packageJson.camelai
      : null;
  const pluginId =
    manifest && typeof manifest.id === 'string' && manifest.id.trim().length > 0
      ? manifest.id.trim()
      : null;

  if (!pluginId) {
    throw new Error('Selected folder is not a camelai plugin. Expected package.json camelai.id.');
  }

  if (pluginId === '.' || pluginId === '..') {
    throw new Error('Plugin id may not be a dot-segment path.');
  }

  if (!/^[A-Za-z0-9._-]+$/.test(pluginId)) {
    throw new Error('Plugin id may only contain letters, numbers, dots, underscores, and hyphens.');
  }

  const pluginName =
    manifest && typeof manifest.name === 'string' && manifest.name.trim().length > 0
      ? manifest.name.trim()
      : typeof packageJson.name === 'string' && packageJson.name.trim().length > 0
        ? packageJson.name.trim()
        : pluginId;

  return {
    id: pluginId,
    name: pluginName,
    version:
      typeof packageJson.version === 'string' && packageJson.version.trim().length > 0
        ? packageJson.version.trim()
        : '0.0.0',
  };
}

function installPluginFromDirectory(sourceDirectory) {
  const sourcePath = resolve(sourceDirectory);
  const manifest = readPluginManifestFromDirectory(sourcePath);
  const pluginDirectory = getDesktopPluginDirectory();
  const targetPath = resolve(pluginDirectory, manifest.id);
  const targetRelativePath = relative(pluginDirectory, targetPath);
  const replacing = existsSync(targetPath);

  if (
    targetRelativePath === '' ||
    targetRelativePath === '.' ||
    targetRelativePath === '..' ||
    targetRelativePath.startsWith('..\\') ||
    targetRelativePath.startsWith('../') ||
    isAbsolute(targetRelativePath)
  ) {
    throw new Error('Plugin install target must stay within the desktop plugins directory.');
  }

  ensureDirectory(pluginDirectory);

  if (sourcePath !== targetPath) {
    rmSync(targetPath, { recursive: true, force: true });
    cpSync(sourcePath, targetPath, { recursive: true, force: true });
  }

  return {
    status: 'installed',
    pluginId: manifest.id,
    pluginName: manifest.name,
    installPath: targetPath,
    replaced: replacing,
  };
}

function settlePendingPluginRefresh(result) {
  if (!pendingPluginRefresh) {
    return;
  }

  const { resolve, reject, timeoutId } = pendingPluginRefresh;
  pendingPluginRefresh = null;
  clearTimeout(timeoutId);

  if (result instanceof Error) {
    reject(result);
    return;
  }

  resolve(result);
}

async function refreshPluginsInBackend() {
  if (pendingPluginRefresh) {
    return pendingPluginRefresh.promise;
  }

  const promise = new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      settlePendingPluginRefresh(
        new Error('Timed out while refreshing installed plugins.'),
      );
    }, 10000);

    pendingPluginRefresh = {
      promise: null,
      resolve,
      reject,
      timeoutId,
    };
  });

  if (pendingPluginRefresh) {
    pendingPluginRefresh.promise = promise;
  }

  try {
    await sendBackendEvent({ type: 'refresh_plugins' });
    await promise;
  } catch (error) {
    settlePendingPluginRefresh(
      error instanceof Error ? error : new Error(String(error)),
    );
    throw error;
  }
}

function publishBackendEvent(event) {
  if (event.type === 'permission_request' && event.request.kind === 'host_mcp_mutation') {
    void showHostMcpPermissionDialog(event.request)
      .then((approved) =>
        sendBackendEvent({
          type: 'respond_permission_request',
          requestId: event.request.id,
          decision: approved ? 'approve' : 'deny',
        }),
      )
      .catch((error) => {
        console.error('[desktop-backend] failed to resolve permission request', error);
        return sendBackendEvent({
          type: 'respond_permission_request',
          requestId: event.request.id,
          decision: 'deny',
        });
      });
    return;
  }

  if (event.type === 'permission_request' && event.request.kind === 'secret_prompt') {
    void showSecretPromptDialog(event.request)
      .then((result) =>
        sendBackendEvent({
          type: 'respond_permission_request',
          requestId: event.request.id,
          decision: result.approved ? 'approve' : 'deny',
          secretValue: result.secretValue ?? null,
        }),
      )
      .catch((error) => {
        console.error('[desktop-backend] failed to resolve secret prompt', error);
        return sendBackendEvent({
          type: 'respond_permission_request',
          requestId: event.request.id,
          decision: 'deny',
        });
      });
    return;
  }

  if (event.type === 'snapshot') {
    latestSnapshot = event.snapshot;
    settlePendingPluginRefresh(event.snapshot);
    recordStartup('backend_snapshot', {
      provider: event.snapshot.provider,
      authSource: event.snapshot.auth.source,
      hasAuth: event.snapshot.auth.available,
      runtimeState: event.snapshot.runtimeStatus.state,
    });
    if (
      startupProbeEnabled &&
      startupProbeRendererReady &&
      event.snapshot.runtimeStatus.state !== 'starting'
    ) {
      finishStartupProbe(true, {
        rendererReady: startupProbeRendererReady,
        settledRuntimeState: event.snapshot.runtimeStatus.state,
        settledRuntimeDetail: event.snapshot.runtimeStatus.detail,
      });
    }
  }

  if (event.type === 'error') {
    settlePendingPluginRefresh(new Error(event.message));
  }

  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('desktop:event', event);
  }
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: getWindowBackgroundColor(),
    show: !startupProbeEnabled,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 16 },
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  applyWindowAppearance(window);

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (startupProbeEnabled) {
    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      recordStartup('window_did_fail_load', { errorCode, errorDescription });
    });
    window.webContents.on('console-message', (_event, level, message) => {
      recordStartup('renderer_console', { level, message });
    });
    window.webContents.on('render-process-gone', (_event, details) => {
      recordStartup('render_process_gone', details);
    });
  }

  window.webContents.on('did-finish-load', () => {
    recordStartup('window_did_finish_load');
    if (latestSnapshot) {
      window.webContents.send('desktop:event', {
        type: 'snapshot',
        snapshot: latestSnapshot,
      });
    }
  });

  void window.loadURL(getRendererEntry());

  if (devRendererUrl && !startupProbeEnabled && process.env.DESKTOP_NO_DEVTOOLS !== '1') {
    window.webContents.openDevTools({ mode: 'detach' });
  }
}

async function ensureDirectDesktopService() {
  if (directDesktopService) {
    return;
  }

  applyDesktopRuntimeEnv();
  recordStartup('runtime_env_applied', { mode: 'direct-service' });

  const backendModuleEntry = getBackendModuleEntry();
  if (!backendModuleEntry) {
    throw new Error('Desktop service bundle is not available.');
  }

  const backendModule = await import(pathToFileURL(backendModuleEntry).href);
  if (typeof backendModule.createDesktopService !== 'function') {
    throw new Error('Desktop service bundle is missing createDesktopService().');
  }

  directDesktopService = backendModule.createDesktopService();
  recordStartup('direct_service_created');
  unsubscribeDesktopService = directDesktopService.subscribe((event) => {
    publishBackendEvent(event);
  });
  latestSnapshot = directDesktopService.getSnapshot();
  recordStartup('direct_service_snapshot_loaded', {
    provider: latestSnapshot.provider,
    authSource: latestSnapshot.auth.source,
    runtimeState: latestSnapshot.runtimeStatus.state,
  });
}

async function ensureBackend() {
  if (directDesktopService) {
    return;
  }

  if (backendProcess && backendProcess.exitCode === null) {
    return;
  }

  if (backendReadyPromise) {
    await backendReadyPromise;
    return;
  }

  const backendModuleEntry = getBackendModuleEntry();
  if (backendModuleEntry) {
    backendReadyPromise = ensureDirectDesktopService().finally(() => {
      backendReadyPromise = null;
    });
    await backendReadyPromise;
    return;
  }

  const resourcesDir = getDesktopResourcesDir();
  const backendBinaryPath =
    resolveDesktopOverridePath(process.env.DESKTOP_BACKEND_BINARY_PATH) ??
    resolve(resourcesDir, 'bin/camelai-desktop-backend');
  const backendEntry =
    process.env.DESKTOP_BACKEND_ENTRY || 'desktop-container/backend/server.ts';
  const backendCwd =
    resolveDesktopOverridePath(process.env.DESKTOP_BACKEND_CWD) ?? repoRoot;
  const runtimeEnv = applyDesktopRuntimeEnv();
  recordStartup('runtime_env_applied', { mode: 'backend-child' });
  const backendEnv = {
    ...process.env,
    DESKTOP_BACKEND_TRANSPORT: 'stdio',
    ...runtimeEnv,
  };

  backendReadyPromise = new Promise((resolvePromise, rejectPromise) => {
    let ready = false;
    const command = existsSync(backendBinaryPath) ? backendBinaryPath : 'bun';
    const args = existsSync(backendBinaryPath) ? [] : ['run', backendEntry];
    recordStartup('backend_process_spawn', { command, args });

    backendProcess = spawn(command, args, {
      cwd: backendCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: backendEnv,
    });

    backendProcess.stdout.setEncoding('utf8');
    backendProcess.stdout.on('data', (chunk) => {
      backendStdoutBuffer += chunk;
      while (true) {
        const newlineIndex = backendStdoutBuffer.indexOf('\n');
        if (newlineIndex === -1) {
          break;
        }

        const line = backendStdoutBuffer.slice(0, newlineIndex).trim();
        backendStdoutBuffer = backendStdoutBuffer.slice(newlineIndex + 1);
        if (!line) {
          continue;
        }

        try {
          const event = JSON.parse(line);
          publishBackendEvent(event);
          if (event.type === 'snapshot' && !ready) {
            ready = true;
            recordStartup('backend_process_ready');
            resolvePromise();
          }
        } catch (error) {
          console.error('[desktop-backend] invalid stdio event', error);
        }
      }
    });

    backendProcess.stderr.setEncoding('utf8');
    backendProcess.stderr.on('data', (chunk) => {
      process.stderr.write(`[desktop-backend] ${chunk}`);
    });

    backendProcess.on('exit', (code, signal) => {
      backendProcess = null;
      backendReadyPromise = null;
      if (!ready) {
        recordStartup('backend_process_exit_before_ready', { code, signal });
        rejectPromise(new Error(`desktop backend exited before ready: code=${code ?? 'null'} signal=${signal ?? 'null'}`));
        return;
      }
      if (!isQuitting) {
        recordStartup('backend_process_exit', { code, signal });
        console.error(`[desktop-backend] exited with code ${code ?? 'null'} signal ${signal ?? 'null'}`);
      }
    });
  });

  await backendReadyPromise;
}

async function sendBackendEvent(event) {
  await ensureBackend();
  if (directDesktopService) {
    directDesktopService.handleClientEvent(event);
    return;
  }
  if (!backendProcess || backendProcess.exitCode !== null) {
    throw new Error('Desktop backend is not running.');
  }
  backendProcess.stdin.write(`${JSON.stringify(event)}\n`);
}

ipcMain.handle('desktop:get-snapshot', async () => {
  recordStartup('renderer_requested_snapshot');
  await ensureBackend();
  return latestSnapshot;
});

ipcMain.handle('desktop:install-plugin', async () => {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
  const selection = await dialog.showOpenDialog(window ?? undefined, {
    title: 'Install plugin',
    buttonLabel: 'Install Plugin',
    properties: ['openDirectory'],
  });

  if (selection.canceled || selection.filePaths.length === 0) {
    return {
      status: 'cancelled',
      pluginId: null,
      pluginName: null,
      installPath: null,
      replaced: false,
    };
  }

  const installation = installPluginFromDirectory(selection.filePaths[0]);
  await refreshPluginsInBackend();
  return installation;
});

ipcMain.handle('desktop:pick-local-files', async () => {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
  const selection = await dialog.showOpenDialog(window ?? undefined, {
    title: 'Choose files to upload',
    buttonLabel: 'Add Files',
    properties: ['openFile', 'multiSelections'],
  });

  return selection.canceled ? [] : selection.filePaths;
});

ipcMain.handle('desktop:import-local-files', async (_event, filePaths) => {
  if (!Array.isArray(filePaths)) {
    throw new Error('Import requires an array of file paths.');
  }

  return filePaths.map((filePath) => importLocalFile(filePath));
});

ipcMain.handle('desktop:download-file', async (_event, request) => {
  const sourcePath = resolveDesktopFileSource(request);
  const sourceStats = statSync(sourcePath);
  if (!sourceStats.isFile()) {
    throw new Error(`${sourcePath} is not a file.`);
  }

  const suggestedName =
    request && typeof request === 'object' && typeof request.filename === 'string' && request.filename.trim()
      ? request.filename.trim()
      : basename(sourcePath);
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
  const selection = await dialog.showSaveDialog(window ?? undefined, {
    title: 'Save file',
    defaultPath: join(app.getPath('downloads'), suggestedName),
  });

  if (selection.canceled || !selection.filePath) {
    return {
      canceled: true,
      destinationPath: null,
    };
  }

  cpSync(sourcePath, selection.filePath, { force: true });
  return {
    canceled: false,
    destinationPath: selection.filePath,
  };
});

ipcMain.handle('desktop:open-plugin-directory', async () => {
  const pluginDirectory = getDesktopPluginDirectory();
  ensureDirectory(pluginDirectory);
  const error = await shell.openPath(pluginDirectory);
  if (error) {
    throw new Error(error);
  }
  return pluginDirectory;
});

ipcMain.handle('desktop:resolve-webview-src', async (_event, entrypoint) => {
  if (typeof entrypoint !== 'string') {
    throw new Error('Webview entrypoint must be a string.');
  }

  if (/^(https?:|data:)/.test(entrypoint)) {
    return entrypoint;
  }

  if (entrypoint.startsWith('file:')) {
    return toDesktopPluginUrl(entrypoint);
  }

  if (!canResolveLocalWebviewPath(entrypoint)) {
    throw new Error(`Unsupported local webview entrypoint: ${entrypoint}`);
  }

  return toDesktopPluginUrl(entrypoint);
});

ipcMain.on('desktop:send', (_event, payload) => {
  void sendBackendEvent(payload).catch((error) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('desktop:event', {
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
});

ipcMain.on('desktop:ready', (_event, payload) => {
  startupProbeRendererReady = payload;
  recordStartup('renderer_reported_ready', payload);
  if (!startupProbeEnabled) {
    return;
  }
  if (latestSnapshot && latestSnapshot.runtimeStatus.state !== 'starting') {
    finishStartupProbe(true, {
      rendererReady: payload,
      settledRuntimeState: latestSnapshot.runtimeStatus.state,
      settledRuntimeDetail: latestSnapshot.runtimeStatus.detail,
    });
  }
});

app.whenReady().then(async () => {
  recordStartup('app_ready');
  protocol.handle('desktop-plugin', (request) => {
    try {
      return net.fetch(pathToFileURL(fromDesktopPluginUrl(request.url)).toString());
    } catch (error) {
      return new Response(error instanceof Error ? error.message : String(error), {
        status: 404,
      });
    }
  });
  if (startupProbeEnabled) {
    startupProbeTimeout = setTimeout(() => {
      finishStartupProbe(false, { timeout: true });
    }, startupProbeTimeoutMs);
  }
  await ensureBackend();
  createWindow();
  nativeTheme.on('updated', () => {
    for (const window of BrowserWindow.getAllWindows()) {
      applyWindowAppearance(window);
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  cleanupBackendResources();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

process.once('exit', () => {
  cleanupBackendResources();
});
process.once('SIGTERM', () => {
  cleanupBackendResources();
  process.exit(0);
});
process.once('SIGINT', () => {
  cleanupBackendResources();
  process.exit(0);
});
