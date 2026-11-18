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
  setupServer:()=>ipcRenderer.invoke("server:setup"),
  update:{
    check:()=>ipcRenderer.invoke("update:check"),
    download:()=>ipcRenderer.invoke("update:download"),
    restart:()=>ipcRenderer.invoke("update:restart"),
    onStatus(callback){const listener=(_event,state)=>callback(state);ipcRenderer.on("update-status",listener);return()=>ipcRenderer.removeListener("update-status",listener);}
  },
});
