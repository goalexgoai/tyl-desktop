const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openExternal: (url) => ipcRenderer.send('open-external', url),
  openBilling: () => ipcRenderer.invoke('open-billing'),
  platform: process.platform,
  isDesktop: true,

  // Setup wizard
  checkChatDbAccess: () => ipcRenderer.invoke('check-chat-db-access'),
  triggerMessagesPermission: () => ipcRenderer.invoke('trigger-messages-permission'),
  openFdaSettings: () => ipcRenderer.send('open-fda-settings'),
  markSetupDone: () => ipcRenderer.invoke('mark-setup-done'),
  isSetupDone: () => ipcRenderer.invoke('is-setup-done'),
});
