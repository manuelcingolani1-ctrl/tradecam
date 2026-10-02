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
  getCandles: (params) => ipcRenderer.invoke('replay:getCandles', params)
});

// Puente para el panel flotante "notas + cámara" (ventana real de Electron,
// no la vieja documentPictureInPicture del navegador, que no funciona
// dentro de Electron). Este mismo preload.js lo cargan tanto la ventana
// principal como la ventana flotante — cada lado usa solo los métodos que
// le corresponden, pero exponer todo en los dos no tiene costo.
contextBridge.exposeInMainWorld('floatingAPI', {
  // Lado ventana principal: abrir/cerrar la flotante, empujarle el estado
  // actual, y escuchar lo que el usuario hace allá (nota enviada, chip de
  // etiqueta tocado, o la ventana cerrada a mano).
  open: () => ipcRenderer.invoke('floating:open'),
  close: () => ipcRenderer.invoke('floating:close'),
  pushState: (state) => ipcRenderer.send('floating:push-state', state),
  onNoteSubmit: (cb) => ipcRenderer.on('floating:note-submit', (event, text) => cb(text)),
  onTagToggle: (cb) => ipcRenderer.on('floating:tag-toggle', (event, tag) => cb(tag)),
  onClosed: (cb) => ipcRenderer.on('floating:closed', () => cb()),
  // Lado ventana flotante: recibir el estado que empuja la principal, y
  // avisarle acciones del usuario.
  onState: (cb) => ipcRenderer.on('floating:state', (event, state) => cb(state)),
  submitNote: (text) => ipcRenderer.send('floating:note-submit', text),
  toggleTag: (tag) => ipcRenderer.send('floating:tag-toggle', tag)
});
