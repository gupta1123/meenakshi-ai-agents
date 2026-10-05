const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("meenakshiBridge", {
  onStatus(callback) {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("status", listener);
    return () => ipcRenderer.removeListener("status", listener);
  },
});
