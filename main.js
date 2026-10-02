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

// Pide una URL por HTTPS y devuelve el body crudo (texto). Base de
// httpsGetJson (abajo) y de fetchFromStooq, que necesita CSV, no JSON.
function httpsGetText(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: Object.assign({ 'User-Agent': 'TradeCam' }, headers || {}) }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error('HTTP ' + res.statusCode + ': ' + data.slice(0, 300)));
          return;
        }
        resolve(data);
      });
    }).on('error', reject);
  });
}

function httpsGetJson(url, headers) {
  return httpsGetText(url, headers).then((data) => {
    try {
      return JSON.parse(data);
    } catch (e) {
      throw new Error('Respuesta inválida (no es JSON): ' + e.message);
    }
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

// Yahoo Finance no tiene un timeframe de 4 horas, así que H4 se arma acá
// agrupando de a 4 velas de 1 hora (open=primera, close=última, high/low y
// volumen agregados). El último grupo puede quedar incompleto (vela "en
// formación"), que es lo esperado en un replay.
const YAHOO_INTERVAL_MAP = { M1: '1m', M5: '5m', M15: '15m', M30: '30m', H1: '60m', H4: '60m', D1: '1d' };

// Ventanas reales que Yahoo deja pedir hacia atrás para cada intervalo
// intradía (documentadas por reportes de usuarios, no por Yahoo mismo, que
// no publica esto formalmente): 1 minuto solo llega a ~7 días; el resto de
// los intradía (5m, 15m, 30m, 60m) a ~60 días. D1 no tiene este límite.
const YAHOO_MAX_INTRADAY_DAYS = { '1m': 7, '5m': 60, '15m': 60, '30m': 60, '60m': 60 };

function aggregateCandles(candles, groupSize) {
  const out = [];
  for (let i = 0; i < candles.length; i += groupSize) {
    const group = candles.slice(i, i + groupSize);
    if (!group.length) continue;
    out.push({
      time: group[0].time,
      open: group[0].open,
      high: Math.max.apply(null, group.map((c) => c.high)),
      low: Math.min.apply(null, group.map((c) => c.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((sum, c) => sum + (c.volume || 0), 0)
    });
  }
  return out;
}

// Trae velas de Yahoo Finance (sin API key, endpoint público "chart" que
// usa la propia web de Yahoo). Sirve para acciones de EE.UU. (AAPL, SPY),
// índices "cash" (^GSPC = S&P 500, ^NDX = Nasdaq 100, ^DJI = Dow Jones),
// metales y commodities como futuro continuo (GC=F = oro, SI=F = plata,
// CL=F = petróleo), y de yapa también forex (EURUSD=X) y cripto (BTC-USD)
// con la misma notación de Yahoo — útil como fuente alternativa a MT5/
// Binance para esos dos casos, aunque MT5 y Binance siguen siendo la
// fuente principal recomendada ahí. Yahoo cambia esta API sin aviso de
// tanto en tanto (ver notas del repo) — si deja de funcionar, es lo
// primero a revisar.
async function fetchFromYahoo(symbol, timeframe, fromTs, toTs) {
  const interval = YAHOO_INTERVAL_MAP[timeframe];
  if (!interval) return { ok: false, error: 'Timeframe inválido: ' + timeframe };

  let effectiveFromTs = fromTs;
  let warning;
  const maxDays = YAHOO_MAX_INTRADAY_DAYS[interval];
  if (maxDays) {
    const minFromTs = toTs - maxDays * 86400;
    if (effectiveFromTs < minFromTs) {
      effectiveFromTs = minFromTs;
      warning = 'Yahoo Finance solo entrega velas de ' + timeframe + ' de los últimos ' + maxDays +
        ' días aproximadamente; se ajustó la fecha de inicio. Para historial más largo, usá D1 (diario).';
    }
  }

  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) +
    '?period1=' + effectiveFromTs + '&period2=' + toTs + '&interval=' + interval + '&events=history';

  try {
    const body = await httpsGetJson(url, {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      'Accept': 'application/json'
    });
    const chartErr = body && body.chart && body.chart.error;
    if (chartErr) {
      return { ok: false, error: 'Yahoo Finance: ' + (chartErr.description || chartErr.code || 'símbolo no encontrado') + '. Revisá el símbolo (ej. AAPL, ^GSPC, ^NDX, GC=F).' };
    }
    const result = body && body.chart && body.chart.result && body.chart.result[0];
    if (!result || !result.timestamp || !result.timestamp.length) {
      return { ok: false, error: 'Yahoo Finance no devolvió velas para "' + symbol + '" en ese rango. Revisá el símbolo y las fechas.' };
    }
    const ts = result.timestamp;
    const quote = result.indicators && result.indicators.quote && result.indicators.quote[0];
    if (!quote) return { ok: false, error: 'Yahoo Finance devolvió una respuesta sin datos de precio.' };

    let candles = [];
    for (let i = 0; i < ts.length; i++) {
      // Yahoo rellena con null las velas sin datos (feriados, huecos); se
      // descartan en vez de guardar un agujero en el gráfico.
      if (quote.close[i] == null || quote.open[i] == null) continue;
      candles.push({
        time: ts[i],
        open: quote.open[i],
        high: quote.high[i],
        low: quote.low[i],
        close: quote.close[i],
        volume: quote.volume[i] || 0
      });
    }
    if (timeframe === 'H4') candles = aggregateCandles(candles, 4);

    return { ok: true, candles, warning };
  } catch (e) {
    return { ok: false, error: 'No se pudo traer velas de Yahoo Finance: ' + e.message + '. Revisá tu conexión a internet y el símbolo (ej. AAPL, ^GSPC, ^NDX, GC=F).' };
  }
}

// Fallback de Yahoo cuando falla (Yahoo rompe esta API sin aviso de tanto
// en tanto — ver el reporte de investigación de fuentes de datos). Solo
// cubre el caso más simple y confiable: velas diarias (D1) de acciones de
// EE.UU. con ticker "plano" (AAPL, MSFT, SPY...), vía el CSV público de
// Stooq. No intenta mapear índices (^GSPC) ni futuros (GC=F) a la
// nomenclatura de Stooq porque esa tabla de equivalencias no es confiable
// sin probarla contra la API real — en esos casos simplemente no hay
// fallback y se devuelve el error original de Yahoo.
async function fetchFromStooq(symbol, fromTs, toTs) {
  if (!/^[A-Za-z]{1,6}$/.test(symbol)) return { ok: false, error: 'stooq_not_applicable' };
  const stooqSymbol = symbol.toLowerCase() + '.us';
  const fmt = (ts) => {
    const d = new Date(ts * 1000);
    return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0');
  };
  const url = 'https://stooq.com/q/d/l/?s=' + encodeURIComponent(stooqSymbol) +
    '&d1=' + fmt(fromTs) + '&d2=' + fmt(toTs) + '&i=d';
  try {
    const csv = await httpsGetText(url);
    const lines = csv.trim().split('\n');
    if (lines.length < 2 || /no data|N\/D/i.test(csv)) {
      return { ok: false, error: 'Stooq no tiene datos para "' + symbol + '".' };
    }
    const candles = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      if (cols.length < 6) continue;
      const [dateStr, open, high, low, close, volume] = cols;
      const time = Math.floor(Date.UTC(
        parseInt(dateStr.slice(0, 4), 10),
        parseInt(dateStr.slice(5, 7), 10) - 1,
        parseInt(dateStr.slice(8, 10), 10)
      ) / 1000);
      candles.push({ time, open: parseFloat(open), high: parseFloat(high), low: parseFloat(low), close: parseFloat(close), volume: parseFloat(volume) || 0 });
    }
    return { ok: true, candles };
  } catch (e) {
    return { ok: false, error: 'No se pudo traer velas de Stooq: ' + e.message };
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
    } else if (source === 'yahoo') {
      freshResult = await fetchFromYahoo(symbol, timeframe, fromTs, toTs);
      if (!freshResult.ok && timeframe === 'D1') {
        // Yahoo es la fuente menos estable de las tres (rompe su propia API
        // sin aviso de tanto en tanto). Para velas diarias, antes de
        // rendirse, probamos Stooq como segunda opción.
        const stooqResult = await fetchFromStooq(symbol, fromTs, toTs);
        if (stooqResult.ok && stooqResult.candles.length) {
          freshResult = { ok: true, candles: stooqResult.candles, warning: 'Yahoo Finance falló (' + freshResult.error + '); se usó Stooq como respaldo.' };
        }
      }
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
  return { ok: true, candles: windowed, warning: freshResult.warning };
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

  // Si se cierra la ventana principal, la flotante (si quedó abierta) se va
  // con ella — no tendría sentido que sobreviva sin la app detrás.
  mainWindow.on('closed', () => {
    if (floatingWindow && !floatingWindow.isDestroyed()) floatingWindow.close();
    mainWindow = null;
  });
}

// ---- Ventana flotante "notas + cámara" ----
// Reemplaza al viejo mecanismo basado en documentPictureInPicture (API web
// que no está bien implementada en Electron: requestWindow() tira "Internal
// error: no window" al invocarla, aunque figure como soportada). Esta es la
// forma correcta de hacer una ventana "siempre encima" en una app de
// escritorio: un BrowserWindow real, independiente, con su propio preload y
// su propia conexión de cámara (un MediaStream no se puede mandar por IPC
// entre ventanas — cada BrowserWindow es un proceso de renderer separado).
let floatingWindow = null;

function createFloatingWindow() {
  if (floatingWindow && !floatingWindow.isDestroyed()) return floatingWindow;
  floatingWindow = new BrowserWindow({
    width: 300,
    height: 480,
    minWidth: 240,
    minHeight: 320,
    alwaysOnTop: true,
    title: 'CamTrader · notas y cámara',
    backgroundColor: '#0A0D12',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  floatingWindow.setMenuBarVisibility(false);
  floatingWindow.loadFile(path.join(__dirname, 'floating-panel.html'));
  floatingWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  floatingWindow.on('closed', () => {
    floatingWindow = null;
    // Avisa a la ventana principal para que el botón vuelva a su estado
    // normal, tanto si se cerró con el botón de la app como si el usuario
    // cerró la ventana flotante directamente (la cruz del sistema).
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('floating:closed');
    }
  });
  return floatingWindow;
}

ipcMain.handle('floating:open', () => {
  createFloatingWindow();
  return { ok: true };
});

ipcMain.handle('floating:close', () => {
  if (floatingWindow && !floatingWindow.isDestroyed()) floatingWindow.close();
  return { ok: true };
});

// Relés simples de estado: la ventana principal es la única fuente de
// verdad (sessionNoteLog, selectedNoteTag, etc.) — la flotante es un
// "control remoto" que solo muestra lo que le llega y avisa acciones.
ipcMain.on('floating:push-state', (event, state) => {
  if (floatingWindow && !floatingWindow.isDestroyed()) {
    floatingWindow.webContents.send('floating:state', state);
  }
});

ipcMain.on('floating:note-submit', (event, text) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('floating:note-submit', text);
  }
});

ipcMain.on('floating:tag-toggle', (event, tag) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('floating:tag-toggle', tag);
  }
});

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
