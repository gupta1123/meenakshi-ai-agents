const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("meenakshiBridge", {
  onStatus(callback) {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("status", listener);
    return () => ipcRenderer.removeListener("status", listener);
  },
  logs: {
    list: () => ipcRenderer.invoke("logs:list"),
    send: (days) => ipcRenderer.invoke("logs:send", days),
    openFolder: () => ipcRenderer.invoke("logs:open"),
  },
  version: () => ipcRenderer.invoke("app:version"),
});
