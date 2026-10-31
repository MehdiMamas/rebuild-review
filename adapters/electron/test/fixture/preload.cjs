const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('bridge', {
  api: (process.argv.find((a) => a.startsWith('--api=')) || '').slice(6),
  chooseFile: () => ipcRenderer.invoke('choose-file'),
  openInspector: () => ipcRenderer.invoke('open-inspector'),
});
