const { app, BrowserWindow, session, desktopCapturer, systemPreferences, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');

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

// =======================================================================
// REPLAY / BACKTESTING: velas históricas para el módulo de replay manual.
// Se guardan en disco como JSON plano (una por símbolo+timeframe+fuente)
// para no tener que volver a pedirlas cada vez — mismo criterio 100% local
// que el resto de TradeCam, sin ninguna base de datos extra.
// =======================================================================
const CANDLE_CACHE_DIR = path.join(app.getPath('userData'), 'candle-cache');

function candleCacheFile(source, symbol, timeframe) {
  const safe = (s) => String(s).replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(CANDLE_CACHE_DIR, safe(source) + '__' + safe(symbol) + '__' + safe(timeframe) + '.json');
}

function readCandleCache(source, symbol, timeframe) {
  try {
    const file = candleCacheFile(source, symbol, timeframe);
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function writeCandleCache(source, symbol, timeframe, candles) {
  try {
    if (!fs.existsSync(CANDLE_CACHE_DIR)) fs.mkdirSync(CANDLE_CACHE_DIR, { recursive: true });
    const file = candleCacheFile(source, symbol, timeframe);
    fs.writeFileSync(file, JSON.stringify(candles));
  } catch (e) {
    // Si no se puede escribir el caché no es grave: el replay sigue
    // funcionando, solo que la próxima vez va a tener que volver a pedir
    // las velas a la fuente original.
  }
}

// Combina velas viejas (caché) con nuevas (recién traídas), sin duplicar
// el mismo instante de tiempo, y ordenadas de más vieja a más nueva.
function mergeCandles(oldCandles, newCandles) {
  const byTime = new Map();
  oldCandles.forEach((c) => byTime.set(c.time, c));
  newCandles.forEach((c) => byTime.set(c.time, c));
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

const MT5_TIMEFRAME_SECONDS = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400 };
const BINANCE_INTERVAL_MAP = { M1: '1m', M5: '5m', M15: '15m', M30: '30m', H1: '1h', H4: '4h', D1: '1d' };

// Llama al script de Python (cloud/../python/mt5_fetch.py) que habla con la
// terminal de MetaTrader 5 ya abierta en esta computadora. Le manda el
// pedido por stdin como JSON y espera una sola línea de JSON por stdout.
function fetchFromMT5(symbol, timeframe, fromTs, toTs, pythonPath) {
  return new Promise((resolve) => {
    const scriptPath = path.join(__dirname, 'python', 'mt5_fetch.py');
    const py = spawn(pythonPath || 'python', [scriptPath]);
    let stdout = '';
    let stderr = '';
    py.stdout.on('data', (d) => { stdout += d.toString(); });
    py.stderr.on('data', (d) => { stderr += d.toString(); });
    py.on('error', (err) => {
      resolve({ ok: false, error: 'No se pudo ejecutar Python (' + (pythonPath || 'python') + '): ' + err.message + '. ¿Está instalado y en el PATH de esta computadora?' });
    });
    py.on('close', () => {
      try {
        const parsed = JSON.parse(stdout.trim().split('\n').pop());
        resolve(parsed);
      } catch (e) {
        resolve({ ok: false, error: 'El script de Python no devolvió una respuesta válida.' + (stderr ? ' Detalle: ' + stderr.slice(0, 500) : '') });
      }
    });
    py.stdin.write(JSON.stringify({ symbol, timeframe, fromTs, toTs }));
    py.stdin.end();
  });
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'TradeCam' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error('HTTP ' + res.statusCode + ': ' + data.slice(0, 300)));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Respuesta inválida de Binance: ' + e.message));
        }
      });
    }).on('error', reject);
  });
}

// Trae velas públicas de Binance (sin API key, solo lectura de mercado),
// paginando de 1000 en 1000 (el máximo que deja el endpoint) hasta cubrir
// todo el rango pedido.
async function fetchFromBinance(symbol, timeframe, fromTs, toTs) {
  const interval = BINANCE_INTERVAL_MAP[timeframe];
  if (!interval) return { ok: false, error: 'Timeframe inválido: ' + timeframe };

  const candles = [];
  let startMs = fromTs * 1000;
  const endMs = toTs * 1000;
  let pages = 0;
  const MAX_PAGES = 50; // tope defensivo: 50x1000 velas = 50.000 velas por pedido, de sobra para uso manual.

  try {
    while (startMs < endMs && pages < MAX_PAGES) {
      const url = 'https://api.binance.com/api/v3/klines?symbol=' + encodeURIComponent(symbol) +
        '&interval=' + interval + '&startTime=' + startMs + '&endTime=' + endMs + '&limit=1000';
      const rows = await httpsGetJson(url);
      if (!Array.isArray(rows) || rows.length === 0) break;
      rows.forEach((r) => {
        candles.push({
          time: Math.floor(r[0] / 1000),
          open: parseFloat(r[1]),
          high: parseFloat(r[2]),
          low: parseFloat(r[3]),
          close: parseFloat(r[4]),
          volume: parseFloat(r[5])
        });
      });
      const lastOpenMs = rows[rows.length - 1][0];
      if (lastOpenMs <= startMs) break; // no avanzó, evita loop infinito
      startMs = lastOpenMs + 1;
      pages++;
      if (rows.length < 1000) break; // ya llegamos a la última página disponible
    }
    return { ok: true, candles };
  } catch (e) {
    return { ok: false, error: 'No se pudo traer velas de Binance: ' + e.message + '. Revisá tu conexión a internet y el nombre del símbolo (ej. BTCUSDT).' };
  }
}

ipcMain.handle('replay:getCandles', async (event, params) => {
  const { source, symbol, timeframe, fromTs, toTs, pythonPath } = params || {};
  if (!source || !symbol || !timeframe || !fromTs || !toTs) {
    return { ok: false, error: 'Faltan datos del pedido de velas.' };
  }

  const cached = readCandleCache(source, symbol, timeframe);
  const haveFullRange = cached.length && cached[0].time <= fromTs && cached[cached.length - 1].time >= toTs;

  let freshResult = { ok: true, candles: [] };
  if (!haveFullRange) {
    if (source === 'mt5') {
      freshResult = await fetchFromMT5(symbol, timeframe, fromTs, toTs, pythonPath);
    } else if (source === 'binance') {
      freshResult = await fetchFromBinance(symbol, timeframe, fromTs, toTs);
    } else {
      return { ok: false, error: 'Fuente desconocida: ' + source };
    }
    if (!freshResult.ok) {
      // Si falló pero ya había algo en caché que cubre parte del rango, lo
      // devolvemos igual (mejor datos parciales que nada), avisando el error.
      if (cached.length) {
        const partial = cached.filter((c) => c.time >= fromTs && c.time <= toTs);
        if (partial.length) return { ok: true, candles: partial, warning: freshResult.error };
      }
      return freshResult;
    }
  }

  const merged = mergeCandles(cached, freshResult.candles || []);
  writeCandleCache(source, symbol, timeframe, merged);
  const windowed = merged.filter((c) => c.time >= fromTs && c.time <= toTs);
  return { ok: true, candles: windowed };
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
