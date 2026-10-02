// Puente seguro entre la página (index.html, sin acceso a Node por el
// sandbox/contextIsolation) y el proceso principal, que es el único que
// puede abrir el navegador del sistema, guardar tokens cifrados y hablar
// con las APIs de cada proveedor de almacenamiento.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cloudAPI', {
  connect: (provider) => ipcRenderer.invoke('cloud:connect', provider),
  disconnect: (provider) => ipcRenderer.invoke('cloud:disconnect', provider),
  status: (provider) => ipcRenderer.invoke('cloud:status', provider),
  // Sube el contenido de un archivo (los bytes, ya leídos en el renderer con
  // file.arrayBuffer()) al proveedor conectado. No se manda una ruta de
  // archivo porque los videos grabados con la File System Access API del
  // navegador no tienen una ruta real que este proceso pueda leer con fs.
  uploadFile: (provider, fileName, mimeType, arrayBuffer) =>
    ipcRenderer.invoke('cloud:upload', provider, fileName, mimeType, arrayBuffer)
});

// Puente para el módulo de Replay/Backtesting: pide velas históricas (MT5
// vía Python, o Binance vía HTTPS) al proceso principal, que es el único
// que puede ejecutar procesos externos y guardar el caché en disco.
contextBridge.exposeInMainWorld('replayAPI', {
  getCandles: (params) => ipcRenderer.invoke('replay:getCandles', params),
  // Selector de activo unificado: busca en Yahoo Finance (forex/índices/
  // acciones/metales/energía), en el caché de pares de Binance (cripto) y en
  // la lista curada de MT5, según la categoría pedida ("all" busca en todas).
  searchSymbols: (query, category) => ipcRenderer.invoke('replay:searchSymbols', query, category)
});
