const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopShell', {
  platform: process.platform,
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node,
  },
  getSnapshot: () => ipcRenderer.invoke('desktop:get-snapshot'),
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
  onCommand: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('desktop:command', handler);
    return () => {
      ipcRenderer.removeListener('desktop:command', handler);
    };
  },
});
