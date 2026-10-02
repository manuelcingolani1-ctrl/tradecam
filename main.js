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

// =========================================================================
// Búsqueda unificada de activos (replay:searchSymbols) — alimenta el
// selector de activo del módulo Replay. A diferencia de fetchFromYahoo/
// fetchFromBinance/fetchFromMT5 (que traen VELAS de un símbolo ya elegido),
// estas funciones buscan QUÉ símbolos existen, para que el usuario no
// dependa de una lista fija. Siempre devuelven el mismo formato:
// { symbol, label, category, source }, con category en
// forex|crypto|index|equity|metal|energy|other.
// =========================================================================

// Lista curada de MT5: no hay una API pública de búsqueda de símbolos de
// MetaTrader 5 (depende del bróker), así que se mantiene a mano una lista
// amplia de los símbolos más comunes. Se muestra igual en el selector
// unificado, marcada con fuente "mt5" para que el usuario sepa que necesita
// la terminal de MT5 local corriendo.
const MT5_CURATED_SYMBOLS = [
  { symbol: 'NAS100', name: 'Nasdaq 100', category: 'index' },
  { symbol: 'US30', name: 'Dow Jones 30', category: 'index' },
  { symbol: 'US100', name: 'Nasdaq 100 (alias US100)', category: 'index' },
  { symbol: 'SPX500', name: 'S&P 500', category: 'index' },
  { symbol: 'GER40', name: 'DAX 40 (Alemania)', category: 'index' },
  { symbol: 'UK100', name: 'FTSE 100 (Reino Unido)', category: 'index' },
  { symbol: 'JPN225', name: 'Nikkei 225 (Japón)', category: 'index' },
  { symbol: 'EURUSD', name: 'Euro / Dólar', category: 'forex' },
  { symbol: 'GBPUSD', name: 'Libra / Dólar', category: 'forex' },
  { symbol: 'USDJPY', name: 'Dólar / Yen', category: 'forex' },
  { symbol: 'AUDUSD', name: 'Dólar australiano / Dólar', category: 'forex' },
  { symbol: 'USDCHF', name: 'Dólar / Franco suizo', category: 'forex' },
  { symbol: 'USDCAD', name: 'Dólar / Dólar canadiense', category: 'forex' },
  { symbol: 'NZDUSD', name: 'Dólar neocelandés / Dólar', category: 'forex' },
  { symbol: 'EURJPY', name: 'Euro / Yen', category: 'forex' },
  { symbol: 'GBPJPY', name: 'Libra / Yen', category: 'forex' },
  { symbol: 'EURGBP', name: 'Euro / Libra', category: 'forex' },
  { symbol: 'XAUUSD', name: 'Oro / Dólar', category: 'metal' },
  { symbol: 'XAGUSD', name: 'Plata / Dólar', category: 'metal' },
  { symbol: 'XPTUSD', name: 'Platino / Dólar', category: 'metal' },
  { symbol: 'USOIL', name: 'Petróleo WTI', category: 'energy' },
  { symbol: 'UKOIL', name: 'Petróleo Brent', category: 'energy' },
  { symbol: 'NATGAS', name: 'Gas natural', category: 'energy' }
];

function searchMt5Symbols(query, category) {
  const q = (query || '').trim().toUpperCase();
  return MT5_CURATED_SYMBOLS
    .filter((s) => !category || category === 'all' || s.category === category)
    .filter((s) => !q || s.symbol.includes(q) || s.name.toUpperCase().includes(q))
    .map((s) => ({
      symbol: s.symbol,
      label: s.symbol + ' — ' + s.name,
      category: s.category,
      source: 'mt5'
    }));
}

// Yahoo Finance no tiene una lista pública de "todos los símbolos", pero sí
// un endpoint de búsqueda libre que cubre forex, índices, acciones, ETFs,
// metales y energía (como futuros) sin API key.
function mapYahooQuoteTypeToCategory(quoteType, symbol) {
  const s = (symbol || '').toUpperCase();
  switch (quoteType) {
    case 'CURRENCY': return 'forex';
    case 'CRYPTOCURRENCY': return 'crypto';
    case 'INDEX': return 'index';
    case 'EQUITY':
    case 'ETF': return 'equity';
    case 'FUTURE':
      if (/^(GC|SI|HG|PL|PA)=F/.test(s)) return 'metal';
      if (/^(CL|BZ|NG|RB|HO)=F/.test(s)) return 'energy';
      return 'other';
    default: return 'other';
  }
}

// Lista de "sugeridos" de Yahoo para cuando el usuario todavía no escribió
// nada: el buscador abre mostrando algo navegable en vez de un panel vacío.
// El endpoint de búsqueda de Yahoo necesita texto (no tiene un "traeme
// todo"), así que para el estado inicial se usa esta lista curada de los
// activos más consultados por categoría; apenas el usuario escribe algo,
// se reemplaza por resultados reales y libres de searchYahooSymbols.
const YAHOO_POPULAR_SYMBOLS = [
  { symbol: '^GSPC', name: 'S&P 500', category: 'index' },
  { symbol: '^NDX', name: 'Nasdaq 100', category: 'index' },
  { symbol: '^DJI', name: 'Dow Jones', category: 'index' },
  { symbol: '^RUT', name: 'Russell 2000', category: 'index' },
  { symbol: '^VIX', name: 'VIX (volatilidad)', category: 'index' },
  { symbol: '^GDAXI', name: 'DAX 40 (Alemania)', category: 'index' },
  { symbol: '^FTSE', name: 'FTSE 100 (Reino Unido)', category: 'index' },
  { symbol: '^N225', name: 'Nikkei 225 (Japón)', category: 'index' },
  { symbol: 'EURUSD=X', name: 'Euro / Dólar', category: 'forex' },
  { symbol: 'GBPUSD=X', name: 'Libra / Dólar', category: 'forex' },
  { symbol: 'USDJPY=X', name: 'Dólar / Yen', category: 'forex' },
  { symbol: 'AUDUSD=X', name: 'Dólar australiano / Dólar', category: 'forex' },
  { symbol: 'USDCHF=X', name: 'Dólar / Franco suizo', category: 'forex' },
  { symbol: 'USDCAD=X', name: 'Dólar / Dólar canadiense', category: 'forex' },
  { symbol: 'NZDUSD=X', name: 'Dólar neocelandés / Dólar', category: 'forex' },
  { symbol: 'GC=F', name: 'Oro (futuro continuo)', category: 'metal' },
  { symbol: 'SI=F', name: 'Plata (futuro continuo)', category: 'metal' },
  { symbol: 'HG=F', name: 'Cobre (futuro continuo)', category: 'metal' },
  { symbol: 'PL=F', name: 'Platino (futuro continuo)', category: 'metal' },
  { symbol: 'CL=F', name: 'Petróleo WTI (futuro)', category: 'energy' },
  { symbol: 'BZ=F', name: 'Petróleo Brent (futuro)', category: 'energy' },
  { symbol: 'NG=F', name: 'Gas natural (futuro)', category: 'energy' },
  { symbol: 'AAPL', name: 'Apple', category: 'equity' },
  { symbol: 'MSFT', name: 'Microsoft', category: 'equity' },
  { symbol: 'GOOGL', name: 'Alphabet (Google)', category: 'equity' },
  { symbol: 'AMZN', name: 'Amazon', category: 'equity' },
  { symbol: 'NVDA', name: 'Nvidia', category: 'equity' },
  { symbol: 'TSLA', name: 'Tesla', category: 'equity' },
  { symbol: 'META', name: 'Meta', category: 'equity' },
  { symbol: 'SPY', name: 'ETF S&P 500 (SPY)', category: 'equity' },
  { symbol: 'QQQ', name: 'ETF Nasdaq 100 (QQQ)', category: 'equity' }
];

function defaultYahooSymbols(category) {
  return YAHOO_POPULAR_SYMBOLS
    .filter((s) => !category || category === 'all' || s.category === category)
    .map((s) => ({ symbol: s.symbol, label: s.symbol + ' — ' + s.name, category: s.category, source: 'yahoo' }));
}

async function searchYahooSymbols(query) {
  const q = (query || '').trim();
  if (!q) return [];
  const url = 'https://query1.finance.yahoo.com/v1/finance/search?q=' + encodeURIComponent(q) +
    '&quotesCount=15&newsCount=0&lang=en-US';
  const body = await httpsGetJson(url, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
  });
  const quotes = (body && body.quotes) || [];
  return quotes
    .filter((quote) => quote && quote.symbol)
    .map((quote) => {
      const name = quote.shortname || quote.longname || quote.symbol;
      return {
        symbol: quote.symbol,
        label: quote.symbol + ' — ' + name,
        category: mapYahooQuoteTypeToCategory(quote.quoteType, quote.symbol),
        source: 'yahoo'
      };
    });
}

// Binance publica la lista completa de pares en un solo endpoint
// (exchangeInfo, ~2000+ pares). En vez de pedirla en cada letra que tipea el
// usuario, se cachea una vez por sesión de la app y se filtra en memoria —
// así el selector tiene TODOS los pares de Binance sin pegarle a la red de
// nuevo por cada búsqueda.
let binanceSymbolsCache = null;
let binanceSymbolsCacheAt = 0;
const BINANCE_SYMBOLS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hora

async function getBinanceSymbolsCached() {
  const now = Date.now();
  if (binanceSymbolsCache && (now - binanceSymbolsCacheAt) < BINANCE_SYMBOLS_CACHE_TTL_MS) {
    return binanceSymbolsCache;
  }
  const body = await httpsGetJson('https://api.binance.com/api/v3/exchangeInfo', { 'User-Agent': 'TradeCam' });
  const allowedQuotes = ['USDT', 'USD', 'BUSD'];
  const symbols = (body && body.symbols) || [];
  const filtered = symbols
    .filter((s) => s.status === 'TRADING' && allowedQuotes.includes(s.quoteAsset))
    .map((s) => ({ symbol: s.symbol, baseAsset: s.baseAsset, quoteAsset: s.quoteAsset }));
  binanceSymbolsCache = filtered;
  binanceSymbolsCacheAt = now;
  return filtered;
}

// Orden de prioridad para cuando el usuario todavía no escribió nada: el
// exchangeInfo de Binance no viene ordenado por volumen/popularidad, así
// que sin esto el "sugerido" sería alfabético (poco útil). Se arma con los
// pares USDT de las monedas más conocidas, en este orden, y recién después
// se completa con el resto si hiciera falta.
const BINANCE_POPULAR_BASE_ASSETS = [
  'BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'ADA', 'AVAX', 'LINK', 'TON',
  'TRX', 'DOT', 'MATIC', 'LTC', 'SHIB'
];

function defaultBinanceSymbols(symbols) {
  const picked = [];
  const seen = new Set();
  BINANCE_POPULAR_BASE_ASSETS.forEach((base) => {
    const match = symbols.find((s) => s.baseAsset === base && s.quoteAsset === 'USDT');
    if (match && !seen.has(match.symbol)) { picked.push(match); seen.add(match.symbol); }
  });
  return picked;
}

async function searchBinanceSymbols(query) {
  const symbols = await getBinanceSymbolsCached();
  const q = (query || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const matches = !q ? defaultBinanceSymbols(symbols) : symbols.filter((s) => s.symbol.includes(q) || s.baseAsset.includes(q));
  return matches.slice(0, 20).map((s) => ({
    symbol: s.symbol,
    label: s.symbol + ' — ' + s.baseAsset + '/' + s.quoteAsset,
    category: 'crypto',
    source: 'binance'
  }));
}

ipcMain.handle('replay:searchSymbols', async (event, query, category) => {
  const q = (query || '').trim();
  const cat = category || 'all';
  try {
    const results = [];
    if (cat === 'crypto') {
      // searchBinanceSymbols ya devuelve una selección "popular" cuando q
      // está vacío (ver defaultBinanceSymbols), así que esto sirve tanto
      // para navegar sin escribir como para buscar.
      results.push(...(await searchBinanceSymbols(q)));
    } else {
      if (q) {
        // Yahoo cubre forex/índices/acciones/metales/energía con búsqueda
        // libre real.
        try {
          results.push(...(await searchYahooSymbols(q)));
        } catch (e) {
          // Yahoo rompe su propia API sin aviso de tanto en tanto (ver
          // reporte de investigación) — si falla, seguimos con MT5/Binance
          // en vez de tirar abajo toda la búsqueda.
        }
      } else {
        // Campo vacío (el usuario recién abrió el buscador): mostramos una
        // lista de sugeridos para que pueda navegar sin tener que escribir.
        results.push(...defaultYahooSymbols(cat));
      }
      results.push(...searchMt5Symbols(q, cat));
      if (cat === 'all') {
        try { results.push(...(await searchBinanceSymbols(q))); } catch (e) { /* idem Yahoo */ }
      }
    }
    const filtered = cat === 'all' ? results : results.filter((r) => r.category === cat);
    // De-duplicar (un mismo símbolo puede aparecer por Yahoo y por la lista
    // curada de MT5) y limitar el total para que el panel no quede enorme.
    const seen = new Set();
    const uniq = [];
    for (const r of filtered) {
      const key = r.source + ':' + r.symbol;
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(r);
      if (uniq.length >= 40) break;
    }
    return { ok: true, results: uniq, isDefault: !q };
  } catch (e) {
    return { ok: false, error: 'No se pudo buscar activos: ' + e.message };
  }
});

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
