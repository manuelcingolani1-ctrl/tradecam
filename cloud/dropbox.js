// Conexión real a Dropbox (OAuth 2.0 + PKCE, "Authorization Code" flow para
// apps de escritorio — no se usa client secret en el navegador en ningún
// momento del intercambio final, pero Dropbox igual pide un App secret para
// el paso de "token exchange" si el tipo de app elegido lo requiere).
//
// Las credenciales (App key / App secret) NO van acá adentro: van en
// cloud/credentials.local.json, que está en .gitignore y nunca se sube.
// Para configurarlo: copiá cloud/credentials.local.json.example a
// cloud/credentials.local.json y completá los valores que te da la Dropbox
// App Console (ver README.md, sección "Conectar Dropbox"). Ese archivo SÍ
// queda incluido cuando se empaqueta la app para distribuir (ver "files" en
// package.json), solo que nunca viaja por git.
//
// Pedimos el scope mínimo: "files.content.write" (subir archivos nuevos que
// crea la propia app) + "files.metadata.read" y "account_info.read" para
// mostrar el email y el uso de espacio en Configuración.
'use strict';

const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { shell } = require('electron');
const tokenStore = require('./token-store');

function loadCredentials() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'credentials.local.json'), 'utf8');
    const json = JSON.parse(raw);
    return (json && json.dropbox) || {};
  } catch (e) {
    return {};
  }
}

const creds = loadCredentials();
const APP_KEY = creds.appKey || '';
const APP_SECRET = creds.appSecret || '';

const PROVIDER = 'dropbox';
const SCOPE = 'account_info.read files.content.write files.metadata.read';
const AUTH_URL = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const REVOKE_URL = 'https://api.dropboxapi.com/2/auth/token/revoke';
const CALLBACK_PORT = 42814; // distinto del de Google Drive (42813) para poder tener los dos flujos abiertos sin pisarse.

function isConfigured() {
  return !!APP_KEY && !!APP_SECRET;
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pageHtml(message) {
  return (
    '<html><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;' +
    'background:#0B0E11;color:#E8EAED;font-family:system-ui,sans-serif"><p>' + message + '</p></body></html>'
  );
}

// Levanta un servidor HTTP local solo para recibir la vuelta del navegador
// con el código de autorización, y se cierra apenas lo recibe (o a los 2min).
function waitForCallback(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let url;
      try {
        url = new URL(req.url, 'http://127.0.0.1:' + port);
      } catch (e) {
        res.end(pageHtml('Error.'));
        return;
      }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (error) {
        res.end(pageHtml('No se pudo conectar (' + error + '). Podés cerrar esta pestaña y volver a CamTrader.'));
        server.close();
        reject(new Error(error));
        return;
      }
      if (!code) {
        res.end(pageHtml('Falta el código. Podés cerrar esta pestaña.'));
        return;
      }
      res.end(pageHtml('Listo, ya podés volver a CamTrader. Esta pestaña se puede cerrar.'));
      server.close();
      resolve(code);
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1');
    setTimeout(() => {
      try { server.close(); } catch (e) {}
      reject(new Error('timeout'));
    }, 120000);
  });
}

async function connect() {
  if (!isConfigured()) return { ok: false, error: 'not_configured' };

  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64url(crypto.randomBytes(16));
  const redirectUri = 'http://127.0.0.1:' + CALLBACK_PORT + '/callback';

  const authUrl = new URL(AUTH_URL);
  authUrl.searchParams.set('client_id', APP_KEY);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPE);
  authUrl.searchParams.set('token_access_type', 'offline'); // pide refresh_token
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);

  const callbackPromise = waitForCallback(CALLBACK_PORT);
  // Abre el navegador del sistema (nunca el login adentro de la ventana de
  // Electron: Dropbox, como Google, bloquea el login embebido).
  await shell.openExternal(authUrl.toString());
  const code = await callbackPromise;

  const body = new URLSearchParams({
    client_id: APP_KEY,
    client_secret: APP_SECRET,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri
  });
  const tokenRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!tokenRes.ok) return { ok: false, error: 'token_exchange_failed' };
  const tokenJson = await tokenRes.json();

  tokenStore.saveToken(PROVIDER, {
    access_token: tokenJson.access_token,
    refresh_token: tokenJson.refresh_token,
    // Dropbox suele devolver access tokens de 4hs (expires_in en segundos).
    expires_at: Date.now() + tokenJson.expires_in * 1000 - 60000
  });
  return { ok: true };
}

async function getAccessToken() {
  const t = tokenStore.getToken(PROVIDER);
  if (!t) return null;
  if (t.access_token && Date.now() < t.expires_at) return t.access_token;
  if (!t.refresh_token) return null;

  const body = new URLSearchParams({
    client_id: APP_KEY,
    client_secret: APP_SECRET,
    refresh_token: t.refresh_token,
    grant_type: 'refresh_token'
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) return null;
  const json = await res.json();
  const updated = {
    ...t,
    access_token: json.access_token,
    expires_at: Date.now() + json.expires_in * 1000 - 60000
  };
  tokenStore.saveToken(PROVIDER, updated);
  return updated.access_token;
}

async function status() {
  if (!isConfigured()) return { connected: false, error: 'not_configured' };
  const t = tokenStore.getToken(PROVIDER);
  if (!t) return { connected: false };

  const accessToken = await getAccessToken();
  if (!accessToken) return { connected: false };

  try {
    // Los endpoints "RPC" de Dropbox (a diferencia de los de subida de
    // contenido) exigen Content-Type: application/json y un body, aunque no
    // reciban parámetros — si no, devuelven 400 y la app se queda sin datos
    // de uso para siempre.
    const rpcHeaders = {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json'
    };
    const [accountRes, usageRes] = await Promise.all([
      fetch('https://api.dropboxapi.com/2/users/get_current_account', {
        method: 'POST',
        headers: rpcHeaders,
        body: 'null'
      }),
      fetch('https://api.dropboxapi.com/2/users/get_space_usage', {
        method: 'POST',
        headers: rpcHeaders,
        body: 'null'
      })
    ]);

    if (!accountRes.ok || !usageRes.ok) {
      console.error('[dropbox status] respuesta no OK', accountRes.status, usageRes.status);
      return { connected: true, usedBytes: null, totalBytes: null };
    }

    const account = await accountRes.json();
    const usage = await usageRes.json();
    // El campo "allocated" viene directo en "allocation" (no anidado bajo
    // allocation.individual / allocation.team como podría sugerir el nombre
    // del tag) — tanto para cuentas individuales como de equipo. Si no
    // viene (plan sin límite fijo), dejamos totalBytes en null y la
    // interfaz avisa que no hay dato.
    const allocation = usage.allocation || {};
    const totalBytes = allocation.allocated !== undefined ? allocation.allocated : null;

    return {
      connected: true,
      email: account.email,
      usedBytes: usage.used !== undefined ? Number(usage.used) : null,
      totalBytes: totalBytes !== null ? Number(totalBytes) : null
    };
  } catch (e) {
    console.error('[dropbox status] excepción', e);
    return { connected: true, usedBytes: null, totalBytes: null };
  }
}

async function disconnect() {
  const t = tokenStore.getToken(PROVIDER);
  if (t && t.access_token) {
    try {
      await fetch(REVOKE_URL, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + t.access_token }
      });
    } catch (e) {
      // si falla la revocación en Dropbox no importa: igual borramos el token local.
    }
  }
  tokenStore.saveToken(PROVIDER, null);
  return { ok: true };
}

// Dropbox separa la subida en dos caminos según el tamaño: /upload simple
// para archivos chicos (hasta 150MB) y un "upload session" (start/append/
// finish) para archivos grandes, que es el caso típico de una grabación de
// trading de varios minutos. Usamos siempre upload session con un solo
// append + finish para no duplicar lógica: funciona igual de bien para
// archivos chicos y es lo que recomienda la propia documentación de Dropbox
// quando no se sabe de antemano cuán largo va a ser el video.
const DBX_CONTENT_START = 'https://content.dropboxapi.com/2/files/upload_session/start';
const DBX_CONTENT_APPEND = 'https://content.dropboxapi.com/2/files/upload_session/append_v2';
const DBX_CONTENT_FINISH = 'https://content.dropboxapi.com/2/files/upload_session/finish';
const UPLOAD_FOLDER = '/CamTrader'; // carpeta fija dentro del Dropbox del usuario donde caen las grabaciones.
// Dropbox acepta hasta 150MB por request individual de start/append/finish.
// Usamos 8MB por chunk: una sesión de trading grabada durante horas puede
// pesar varios GB, así que no se puede mandar todo en un solo request.
const CHUNK_SIZE = 8 * 1024 * 1024;

async function uploadBufferToSession(accessToken, buffer, fileName) {
  const total = buffer.length;

  // Sesión vacía (archivo de 0 bytes, caso límite): se abre y cierra en el
  // mismo request de start.
  if (total === 0) {
    const startRes = await fetch(DBX_CONTENT_START, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({ close: true })
      },
      body: new Uint8Array(0)
    });
    if (!startRes.ok) throw new Error('upload_session_start_failed');
    const { session_id } = await startRes.json();
    return finishSession(accessToken, session_id, total, fileName);
  }

  const firstChunk = buffer.subarray(0, Math.min(CHUNK_SIZE, total));
  const startRes = await fetch(DBX_CONTENT_START, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({ close: false })
    },
    body: firstChunk
  });
  if (!startRes.ok) throw new Error('upload_session_start_failed');
  const { session_id } = await startRes.json();

  let offset = firstChunk.length;
  while (offset < total) {
    const isLastChunk = total - offset <= CHUNK_SIZE;
    const chunk = buffer.subarray(offset, offset + CHUNK_SIZE);
    if (isLastChunk) {
      // El último chunk se manda junto con el commit en /finish, no en /append.
      return finishSession(accessToken, session_id, offset, fileName, chunk);
    }
    const appendRes = await fetch(DBX_CONTENT_APPEND, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({
          cursor: { session_id, offset },
          close: false
        })
      },
      body: chunk
    });
    if (!appendRes.ok) throw new Error('upload_append_failed');
    offset += chunk.length;
  }

  // El archivo entero entró justo en el primer chunk (total <= CHUNK_SIZE).
  return finishSession(accessToken, session_id, offset, fileName);
}

async function finishSession(accessToken, session_id, offset, fileName, finalChunk) {
  const finishRes = await fetch(DBX_CONTENT_FINISH, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({
        cursor: { session_id, offset },
        commit: {
          path: UPLOAD_FOLDER + '/' + fileName,
          mode: 'add',
          autorename: true,
          mute: false
        }
      })
    },
    body: finalChunk || new Uint8Array(0)
  });
  if (!finishRes.ok) {
    const bodyText = await finishRes.text().catch(() => '(sin cuerpo)');
    console.error('[dropbox upload] finish falló', finishRes.status, bodyText);
    throw new Error('upload_failed');
  }
  return finishRes.json();
}

// Sube un Buffer ya en memoria (no una ruta de archivo — ver nota en
// google-drive.js sobre por qué los videos grabados con la File System
// Access API no tienen una ruta real que Electron pueda leer con fs).
async function uploadBuffer(buffer, fileName, mimeType) {
  const accessToken = await getAccessToken();
  if (!accessToken) throw new Error('not_connected');
  return uploadBufferToSession(accessToken, buffer, fileName);
}

module.exports = { connect, disconnect, status, uploadBuffer, isConfigured };
