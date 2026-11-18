const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pointViewDesktop", {
  openFile: (filters) => ipcRenderer.invoke("point-view:open", filters),
  openColmapDirectory: () => ipcRenderer.invoke("point-view:open-colmap"),
  saveFile: (name, data) => ipcRenderer.invoke("point-view:save", name, data),
  objectCapability: () => ipcRenderer.invoke("point-view:object-capability"),
  reconstructObject: (input) => ipcRenderer.invoke("point-view:object-reconstruct", input),
  cancelObject: () => ipcRenderer.invoke("point-view:object-cancel"),
  onObjectProgress: (callback) => {
    const listener = (_event, stage) => callback(stage);
    ipcRenderer.on("point-view:object-progress", listener);
    return () => ipcRenderer.removeListener("point-view:object-progress", listener);
  }
});
