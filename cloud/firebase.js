// Conexión real a Firebase Storage.
//
// Firebase Storage es, por debajo, un bucket de Google Cloud Storage. No usa
// un login por navegador (OAuth) como Google Drive: se conecta con una
// "cuenta de servicio" (service account) — un archivo JSON que generás una
// sola vez en Firebase/Google Cloud Console y pegás completo dentro de
// cloud/credentials.local.json (gitignoreado, nunca se sube — ver
// cloud/credentials.local.json.example). Por eso "conectar" acá es
// instantáneo: no abre el navegador, solo valida que las credenciales
// funcionen.
//
// Para autenticar las requests, CamTrader firma un JWT a mano (algoritmo
// RS256, con la clave privada de la cuenta de servicio) y lo cambia por un
// access token en el endpoint de OAuth2 de Google — esto es el flujo
// estándar "JWT Bearer" para cuentas de servicio, sin depender de ningún SDK
// de Google/Firebase.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const tokenStore = require('./token-store');

function loadCredentials() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'credentials.local.json'), 'utf8');
    const json = JSON.parse(raw);
    return (json && json.firebase) || {};
  } catch (e) {
    return {};
  }
}

const creds = loadCredentials();
const SERVICE_ACCOUNT = creds.serviceAccountJson || {};
const CLIENT_EMAIL = SERVICE_ACCOUNT.client_email || '';
const PRIVATE_KEY = SERVICE_ACCOUNT.private_key || '';
const BUCKET = creds.bucketName || '';
// Tope de seguridad: si subir el próximo archivo haría que el total usado
// en el bucket supere este valor, CamTrader NO sube a Firebase y pasa al
// siguiente proveedor conectado en la lista de prioridad (ver
// uploadRecordingToCloud en index.html). Por defecto un poco por debajo de
// los 5 GB gratis del plan "Spark" de Firebase, para no arriesgarse a que
// haga falta pasar al plan pago. Se puede ajustar agregando "safetyCapGB"
// dentro de "firebase" en cloud/credentials.local.json.
const SAFETY_CAP_BYTES = (creds.safetyCapGB || 4.5) * 1024 * 1024 * 1024;

const PROVIDER = 'firebase';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/devstorage.read_write';
const UPLOAD_PREFIX = 'CamTrader/'; // todo lo que sube la app queda ordenado bajo este "folder" lógico dentro del bucket.
// Límite de una subida "simple" (no reanudable) contra la API de Google
// Cloud Storage. Grabaciones más largas que esto necesitarían subida
// reanudable (como la que ya usa google-drive.js para Drive), que todavía
// no está implementada acá — por ahora se avisa con un error claro en vez
// de fallar en silencio.
const MAX_SINGLE_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

function isConfigured() {
  return !!CLIENT_EMAIL && !!PRIVATE_KEY && !!BUCKET;
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Arma y firma un JWT "self-signed" con la clave privada de la cuenta de
// servicio, como pide Google para el flujo de autenticación "JWT Bearer".
function buildSignedJwt() {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: CLIENT_EMAIL,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600
  };
  const encodedHeader = base64url(Buffer.from(JSON.stringify(header)));
  const encodedClaim = base64url(Buffer.from(JSON.stringify(claim)));
  const toSign = encodedHeader + '.' + encodedClaim;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(toSign);
  signer.end();
  const signature = base64url(signer.sign(PRIVATE_KEY));
  return toSign + '.' + signature;
}

// Pide un access token nuevo cambiando el JWT firmado en el endpoint de
// OAuth2 de Google. A diferencia de Google Drive, no hace falta guardar un
// refresh token: la cuenta de servicio puede firmar un JWT nuevo en
// cualquier momento, así que simplemente se pide un token de corta duración
// (1 hora) cada vez que hace falta uno (sin cachear entre llamadas del
// proceso principal, que son esporádicas: una conexión, un status, una
// subida por grabación).
async function getAccessToken() {
  if (!isConfigured()) return null;
  const jwt = buildSignedJwt();
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '(sin cuerpo)');
    console.error('[firebase token] respuesta no OK', res.status, bodyText);
    return null;
  }
  const json = await res.json();
  return json.access_token || null;
}

async function connect() {
  if (!isConfigured()) return { ok: false, error: 'not_configured' };
  try {
    const accessToken = await getAccessToken();
    if (!accessToken) return { ok: false, error: 'invalid_credentials' };
    // Pedimos como mucho 1 objeto: alcanza para confirmar que las
    // credenciales y el nombre del bucket son válidos, sin gastar cuota.
    const url = 'https://storage.googleapis.com/storage/v1/b/' + encodeURIComponent(BUCKET) + '/o?maxResults=1';
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '(sin cuerpo)');
      console.error('[firebase connect] respuesta no OK', res.status, bodyText);
      return { ok: false, error: 'invalid_credentials' };
    }
    tokenStore.saveToken(PROVIDER, { connectedAt: Date.now() });
    return { ok: true };
  } catch (e) {
    console.error('[firebase connect] excepción', e);
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function disconnect() {
  tokenStore.saveToken(PROVIDER, null);
  return { ok: true };
}

// Suma el tamaño de todos los objetos del bucket (paginando de a 1000) para
// saber cuánto espacio se usó hasta ahora. La API JSON de Google Cloud
// Storage no expone un endpoint liviano de "espacio total usado", así que
// esta es la forma exacta de calcularlo — queda desactualizado como mucho
// por los objetos que se hayan subido o borrado en el mismo instante en que
// se llama.
async function getUsedBytes(accessToken) {
  let total = 0;
  let pageToken = null;
  do {
    const url = new URL('https://storage.googleapis.com/storage/v1/b/' + encodeURIComponent(BUCKET) + '/o');
    url.searchParams.set('prefix', UPLOAD_PREFIX);
    url.searchParams.set('maxResults', '1000');
    url.searchParams.set('fields', 'items(size),nextPageToken');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
    if (!res.ok) throw new Error('list_objects_failed');
    const json = await res.json();
    for (const item of json.items || []) {
      total += Number(item.size || 0);
    }
    pageToken = json.nextPageToken || null;
  } while (pageToken);
  return total;
}

async function status() {
  if (!isConfigured()) return { connected: false, error: 'not_configured' };
  const t = tokenStore.getToken(PROVIDER);
  if (!t) return { connected: false };

  try {
    const accessToken = await getAccessToken();
    if (!accessToken) return { connected: true, usedBytes: null, totalBytes: SAFETY_CAP_BYTES };
    const usedBytes = await getUsedBytes(accessToken);
    return { connected: true, usedBytes, totalBytes: SAFETY_CAP_BYTES };
  } catch (e) {
    console.error('[firebase status] excepción', e);
    return { connected: true, usedBytes: null, totalBytes: SAFETY_CAP_BYTES };
  }
}

// Sube un Buffer ya en memoria (no una ruta de archivo — ver nota en
// google-drive.js sobre por qué los videos grabados con la File System
// Access API no tienen una ruta real que Electron pueda leer con fs).
async function uploadBuffer(buffer, fileName, mimeType) {
  if (!isConfigured()) throw new Error('not_connected');
  if (buffer.length > MAX_SINGLE_UPLOAD_BYTES) {
    // Límite conocido: una grabación de más de 5GB no entra en una sola
    // subida simple. Hace falta "subida reanudable" para soportar eso, que
    // todavía no está implementada acá.
    throw new Error('file_too_large_for_single_upload');
  }
  const accessToken = await getAccessToken();
  if (!accessToken) throw new Error('not_connected');

  const objectName = UPLOAD_PREFIX + fileName;
  const url = new URL('https://storage.googleapis.com/upload/storage/v1/b/' + encodeURIComponent(BUCKET) + '/o');
  url.searchParams.set('uploadType', 'media');
  url.searchParams.set('name', objectName);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': mimeType,
      'Content-Length': String(buffer.length)
    },
    body: buffer
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '(sin cuerpo)');
    console.error('[firebase upload] respuesta no OK', res.status, bodyText);
    throw new Error('upload_failed');
  }
  return { ok: true };
}

module.exports = { connect, disconnect, status, uploadBuffer, isConfigured };
