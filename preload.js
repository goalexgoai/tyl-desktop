const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openExternal: (url) => ipcRenderer.send('open-external', url),
  openBilling: () => ipcRenderer.invoke('open-billing'),
  platform: process.platform,
  isDesktop: true,
});
