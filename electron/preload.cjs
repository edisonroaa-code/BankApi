const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bankapi', {
  getAppVersion: () => ipcRenderer.invoke('bankapi:getAppVersion'),
  connection: {
    get: () => ipcRenderer.invoke('bankapi:connection:get'),
    save: (payload) => ipcRenderer.invoke('bankapi:connection:save', payload),
    clear: () => ipcRenderer.invoke('bankapi:connection:clear'),
  },
  services: {
    status: () => ipcRenderer.invoke('bankapi:services:status'),
    autoStartStatus: () => ipcRenderer.invoke('bankapi:services:autoStartStatus'),
    startDb: () => ipcRenderer.invoke('bankapi:services:startDb'),
    stopDb: () => ipcRenderer.invoke('bankapi:services:stopDb'),
    startBackend: () => ipcRenderer.invoke('bankapi:services:startBackend'),
    stopBackend: () => ipcRenderer.invoke('bankapi:services:stopBackend'),
    startAll: () => ipcRenderer.invoke('bankapi:services:startAll'),
    setMainServer: () => ipcRenderer.invoke('bankapi:services:setMainServer'),
  },
  credentials: {
    isAvailable: () => ipcRenderer.invoke('bankapi:credentials:isAvailable'),
    get: () => ipcRenderer.invoke('bankapi:credentials:get'),
    save: (payload) => ipcRenderer.invoke('bankapi:credentials:save', payload),
    clear: () => ipcRenderer.invoke('bankapi:credentials:clear'),
  },
});
