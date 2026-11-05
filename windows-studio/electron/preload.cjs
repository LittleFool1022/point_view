const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("surveyDesktop", {
  deviceProjects: origin => ipcRenderer.invoke("survey:device-projects", origin),
  deviceReceive: (origin, session) => ipcRenderer.invoke("survey:device-receive", origin, session),
  keyframePage: (token, id) => ipcRenderer.invoke("survey:keyframe-page", token, id),
  updateKeyframePage: (token, id, review) => ipcRenderer.invoke("survey:update-keyframe-page", token, id, review),
  addKeyframePage: (token, review) => ipcRenderer.invoke("survey:add-keyframe-page", token, review),
  clearKeyframePages: token => ipcRenderer.invoke("survey:clear-keyframe-pages", token),
  keyframeIndex: token => ipcRenderer.invoke("survey:keyframe-index", token),
  semanticAssets: () => ipcRenderer.invoke("survey:semantic-assets"),
  open: kind => ipcRenderer.invoke("survey:open", kind),
  renderPdf: document => ipcRenderer.invoke("survey:render-pdf", document),
  save: (name, data) => ipcRenderer.invoke("survey:save", name, data),
  read: (token, offset, size) => ipcRenderer.invoke("survey:read", token, offset, size),
  release: token => ipcRenderer.invoke("survey:release", token),
  saveProject: (token, state) => ipcRenderer.invoke("survey:save-project", token, state),
  cancel: () => ipcRenderer.invoke("survey:cancel"),
  onProgress: callback => { const listener = (_event, stage) => callback(stage); ipcRenderer.on("survey:progress", listener); return () => ipcRenderer.removeListener("survey:progress", listener); }
});
