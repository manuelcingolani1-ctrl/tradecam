const { app, BrowserWindow, session, desktopCapturer, systemPreferences, shell, ipcMain } = require('electron');
const path = require('path');

// Proveedores de almacenamiento en la nube con conexión real implementada.
// Los que todavía no están acá (dropbox, onedrive, r2, b2, firebase)
// responden "not_implemented" y la interfaz lo avisa en vez de fallar
// en silencio.
const cloudProviders = {
  gdrive: require('./cloud/google-drive')
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

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0A0D12',
    title: 'TradeCam',
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
  // (esto dispara el cartel nativo de "TradeCam quiere acceder a tu cámara").
  if (process.platform === 'darwin' && systemPreferences.askForMediaAccess) {
    try { await systemPreferences.askForMediaAccess('camera'); } catch (e) {}
    try { await systemPreferences.askForMediaAccess('microphone'); } catch (e) {}
  }

  // Autoriza los permisos que la app realmente usa (cámara/micrófono,
  // compartir pantalla, y portapapeles si hiciera falta). Sin esto, Electron
  // rechaza los pedidos de la página por defecto.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ['media', 'display-capture', 'clipboard-read', 'clipboard-sanitized-write'];
    callback(allowed.includes(permission));
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
