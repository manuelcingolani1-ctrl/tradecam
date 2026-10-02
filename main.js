const { app, BrowserWindow, session, desktopCapturer, systemPreferences, shell, ipcMain } = require('electron');
const path = require('path');

// Proveedores de almacenamiento en la nube con conexión real implementada.
const cloudProviders = {
  gdrive: require('./cloud/google-drive'),
  dropbox: require('./cloud/dropbox'),
  r2: require('./cloud/r2'),
  b2: require('./cloud/b2')
};

ipcMain.handle('cloud:connect', async (event, provider) => {
  const mod = cloudProviders[provider];
  if (!mod) return { ok: false, error: 'not_implemented' };
  try {
    return await mod.connect();
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('cloud:disconnect', async (event, provider) => {
  const mod = cloudProviders[provider];
  if (!mod) return { ok: false, error: 'not_implemented' };
  try {
    return await mod.disconnect();
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('cloud:status', async (event, provider) => {
  const mod = cloudProviders[provider];
  if (!mod) return { connected: false, error: 'not_implemented' };
  try {
    return await mod.status();
  } catch (e) {
    return { connected: false, error: String((e && e.message) || e) };
  }
});

// arrayBuffer llega desde el renderer con los bytes del video ya leídos en
// memoria (ver uploadRecordingToCloud en index.html) — no una ruta de
// archivo, porque los videos grabados con la File System Access API del
// navegador no tienen una ruta real que este proceso pueda leer con fs.
ipcMain.handle('cloud:upload', async (event, provider, fileName, mimeType, arrayBuffer) => {
  const mod = cloudProviders[provider];
  if (!mod) return { ok: false, error: 'not_implemented' };
  try {
    await mod.uploadBuffer(Buffer.from(arrayBuffer), fileName, mimeType);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0A0D12',
    title: 'CamTrader',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Los links externos (si algún día hay alguno) se abren en el navegador
  // del sistema, no dentro de la app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(async () => {
  // macOS pide permiso de cámara/micrófono a nivel de sistema operativo
  // (esto dispara el cartel nativo de "CamTrader quiere acceder a tu cámara").
  if (process.platform === 'darwin' && systemPreferences.askForMediaAccess) {
    try { await systemPreferences.askForMediaAccess('camera'); } catch (e) {}
    try { await systemPreferences.askForMediaAccess('microphone'); } catch (e) {}
  }

  // Autoriza los permisos que la app realmente usa (cámara/micrófono,
  // compartir pantalla, y portapapeles si hiciera falta). Sin esto, Electron
  // rechaza los pedidos de la página por defecto.
  const allowedPermissions = ['media', 'display-capture', 'clipboard-read', 'clipboard-sanitized-write', 'fileSystem'];
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(allowedPermissions.includes(permission));
  });
  // El selector de carpeta (showDirectoryPicker en modo "readwrite") hace,
  // además del pedido de arriba, un chequeo de permiso aparte para escribir
  // ("fileSystem") cada vez que se intenta escribir. Sin este handler,
  // Electron lo deniega en silencio y el selector termina en un AbortError
  // aunque el usuario sí haya elegido una carpeta — por eso la app no podía
  // guardar grabaciones.
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return allowedPermissions.includes(permission);
  });

  // Habilita navigator.mediaDevices.getDisplayMedia() (grabar pantalla).
  // useSystemPicker le pide a Windows/macOS que muestren su selector nativo
  // de pantalla/ventana; si el sistema no lo soporta, cae en elegir la
  // pantalla principal automáticamente.
  if (session.defaultSession.setDisplayMediaRequestHandler) {
    session.defaultSession.setDisplayMediaRequestHandler(
      async (request, callback) => {
        try {
          const sources = await desktopCapturer.getSources({ types: ['screen'] });
          callback({ video: sources[0], audio: undefined });
        } catch (e) {
          callback({});
        }
      },
      { useSystemPicker: true }
    );
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
