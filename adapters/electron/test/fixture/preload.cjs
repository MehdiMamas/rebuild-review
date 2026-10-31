const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('bridge', {
  chooseFile: () => ipcRenderer.invoke('choose-file'),
  openInspector: () => ipcRenderer.invoke('open-inspector'),
});
