// Puente seguro entre la página (index.html, sin acceso a Node por el
// sandbox/contextIsolation) y el proceso principal, que es el único que
// puede abrir el navegador del sistema, guardar tokens cifrados y hablar
// con las APIs de cada proveedor de almacenamiento.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cloudAPI', {
  connect: (provider) => ipcRenderer.invoke('cloud:connect', provider),
  disconnect: (provider) => ipcRenderer.invoke('cloud:disconnect', provider),
  status: (provider) => ipcRenderer.invoke('cloud:status', provider)
});
