// Conexión real a Google Drive (OAuth 2.0 + PKCE, flujo "Desktop app").
//
// Las credenciales (Client ID / Client Secret) NO van acá adentro: CamTrader
// es un repo público, y aunque Google trata el secret de un cliente
// "Desktop app" como no-confidencial, igual no corresponde publicarlo en
// GitHub (es lo que bloqueó el push protection la primera vez). Van en
// cloud/credentials.local.json, que está en .gitignore y nunca se sube.
//
// Para configurarlo: copiá cloud/credentials.local.json.example a
// cloud/credentials.local.json y completá los valores que te da Google
// Cloud Console (ver README.md, sección "Conectar Google Drive"). Ese
// archivo SÍ queda incluido cuando se empaqueta la app para distribuir
// (ver "files" en package.json), solo que nunca viaja por git.
//
// No pedimos acceso a todo tu Drive: el scope "drive.file" solo le da a
// CamTrader permiso sobre los archivos que la propia app suba, nunca a los
// que ya tenías ahí.
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
    return (json && json.gdrive) || {};
  } catch (e) {
    return {};
  }
}

const creds = loadCredentials();
const CLIENT_ID = creds.clientId || '';
const CLIENT_SECRET = creds.clientSecret || '';

const PROVIDER = 'gdrive';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const CALLBACK_PORT = 42813; // Google permite cualquier puerto en 127.0.0.1 para clientes "Desktop app", sin registrarlo.

function isConfigured() {
  return !!CLIENT_ID && !!CLIENT_SECRET;
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
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPE);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);

  const callbackPromise = waitForCallback(CALLBACK_PORT);
  // Abre el navegador del sistema (NUNCA un login de Google adentro de la
  // propia ventana de Electron: Google lo bloquea por seguridad y es
  // justamente el "no me lo está permitiendo" que pasó antes).
  await shell.openExternal(authUrl.toString());
  const code = await callbackPromise;

  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
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
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
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
    const res = await fetch('https://www.googleapis.com/drive/v3/about?fields=storageQuota,user', {
      headers: { Authorization: 'Bearer ' + accessToken }
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '(sin cuerpo)');
      console.error('[gdrive status] respuesta no OK', res.status, bodyText);
      return { connected: true, usedBytes: null, totalBytes: null };
    }
    const json = await res.json();
    const q = json.storageQuota || {};
    return {
      connected: true,
      email: json.user && json.user.emailAddress,
      // Google Workspace / cuentas "ilimitadas" no mandan "limit": en ese
      // caso dejamos totalBytes en null y la interfaz avisa que no hay dato.
      usedBytes: q.usage !== undefined ? Number(q.usage) : null,
      totalBytes: q.limit !== undefined ? Number(q.limit) : null
    };
  } catch (e) {
    console.error('[gdrive status] excepción', e);
    return { connected: true, usedBytes: null, totalBytes: null };
  }
}

async function disconnect() {
  const t = tokenStore.getToken(PROVIDER);
  if (t && t.access_token) {
    try {
      await fetch(REVOKE_URL + '?token=' + encodeURIComponent(t.access_token), { method: 'POST' });
    } catch (e) {
      // si falla la revocación en Google no importa: igual borramos el token local.
    }
  }
  tokenStore.saveToken(PROVIDER, null);
  return { ok: true };
}

// Sube un archivo a Drive con upload resumable (apto para videos grandes:
// no carga todo el archivo en memoria). Se llama automáticamente apenas
// termina cada grabación (ver uploadRecordingToCloud en index.html), si
// Google Drive es el proveedor conectado con mayor prioridad.
async function uploadFile(filePath, fileName, mimeType) {
  const accessToken = await getAccessToken();
  if (!accessToken) throw new Error('not_connected');

  const stat = fs.statSync(filePath);
  const initRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mimeType,
      'X-Upload-Content-Length': String(stat.size)
    },
    body: JSON.stringify({ name: fileName })
  });
  if (!initRes.ok) throw new Error('upload_init_failed');
  const sessionUrl = initRes.headers.get('location');

  const stream = fs.createReadStream(filePath);
  const putRes = await fetch(sessionUrl, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType, 'Content-Length': String(stat.size) },
    body: stream,
    duplex: 'half'
  });
  if (!putRes.ok) throw new Error('upload_failed');
  return putRes.json();
}

module.exports = { connect, disconnect, status, uploadFile, isConfigured };
