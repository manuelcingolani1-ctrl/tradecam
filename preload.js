// Puente seguro entre la página (index.html, sin acceso a Node por el
// sandbox/contextIsolation) y el proceso principal, que es el único que
// puede abrir el navegador del sistema, guardar tokens cifrados y hablar
// con las APIs de cada proveedor de almacenamiento.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('cloudAPI', {
  connect: (provider) => ipcRenderer.invoke('cloud:connect', provider),
  disconnect: (provider) => ipcRenderer.invoke('cloud:disconnect', provider),
  status: (provider) => ipcRenderer.invoke('cloud:status', provider),
  // Sube un archivo ya guardado en disco (la grabación local) al proveedor
  // conectado. filePath sale de fileAPI.getPathForFile sobre el File ya escrito.
  uploadFile: (provider, filePath, fileName, mimeType) =>
    ipcRenderer.invoke('cloud:upload', provider, filePath, fileName, mimeType)
});

// La página graba y guarda el video con la File System Access API del propio
// navegador (showDirectoryPicker/createWritable), que no expone una ruta de
// disco común. webUtils.getPathForFile sí la da a partir del File ya escrito,
// y es la única forma de conseguirla sin tocar cómo se guarda el video.
contextBridge.exposeInMainWorld('fileAPI', {
  getPathForFile: (file) => webUtils.getPathForFile(file)
});
