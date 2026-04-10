const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopShell', {
  platform: process.platform,
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node,
  },
  getSnapshot: () => ipcRenderer.invoke('desktop:get-snapshot'),
  pickLocalFiles: () => ipcRenderer.invoke('desktop:pick-local-files'),
  importLocalFiles: (paths) => ipcRenderer.invoke('desktop:import-local-files', paths),
  importFilePayloads: (payloads) => ipcRenderer.invoke('desktop:import-file-payloads', payloads),
  downloadFile: (request) => ipcRenderer.invoke('desktop:download-file', request),
  installPlugin: () => ipcRenderer.invoke('desktop:install-plugin'),
  openPluginDirectory: () => ipcRenderer.invoke('desktop:open-plugin-directory'),
  resolveWebviewSrc: (entrypoint) =>
    ipcRenderer.invoke('desktop:resolve-webview-src', entrypoint),
  sendEvent: (event) => ipcRenderer.send('desktop:send', event),
  reportReady: (payload) => ipcRenderer.send('desktop:ready', payload),
  onEvent: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('desktop:event', handler);
    return () => {
      ipcRenderer.removeListener('desktop:event', handler);
    };
  },
});
