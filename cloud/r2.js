// Conexión real a Cloudflare R2 (almacenamiento compatible con S3).
//
// A diferencia de Google Drive y Dropbox, R2 no usa un login con navegador
// (OAuth): se conecta con credenciales fijas tipo "API key" que vos mismo
// generás una sola vez en el dashboard de Cloudflare y pegás en
// cloud/credentials.local.json (gitignoreado, nunca se sube — ver
// cloud/credentials.local.json.example). Por eso "conectar" acá es
// instantáneo: no abre el navegador, solo valida que las credenciales
// funcionen.
//
// Las requests a la API se firman a mano con el algoritmo AWS Signature V4
// (el mismo que usa Amazon S3 — Cloudflare lo imita a propósito), sin
// depender de ningún SDK de AWS.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const tokenStore = require('./token-store');

function loadCredentials() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'credentials.local.json'), 'utf8');
    const json = JSON.parse(raw);
    return (json && json.r2) || {};
  } catch (e) {
    return {};
  }
}

const creds = loadCredentials();
const ACCOUNT_ID = creds.accountId || '';
const ACCESS_KEY_ID = creds.accessKeyId || '';
const SECRET_ACCESS_KEY = creds.secretAccessKey || '';
const BUCKET = creds.bucketName || '';
// Tope de seguridad: si subir el próximo archivo haría que el total usado
// en el bucket supere este valor, CamTrader NO sube a R2 y pasa al
// siguiente proveedor conectado en la lista de prioridad (ver
// uploadRecordingToCloud en index.html). Por defecto un poco por debajo de
// los 10 GB gratis mensuales de R2, para no arriesgarse a que empiece a
// cobrar. Se puede ajustar agregando "safetyCapGB" dentro de "r2" en
// cloud/credentials.local.json (por ejemplo, 50 si contrataste más espacio
// a propósito).
const SAFETY_CAP_BYTES = (creds.safetyCapGB || 9.5) * 1024 * 1024 * 1024;

const PROVIDER = 'r2';
const REGION = 'auto';
const SERVICE = 's3';
const UPLOAD_PREFIX = 'CamTrader/'; // todo lo que sube la app queda ordenado bajo este "folder" lógico dentro del bucket.
// Límite de un PUT simple en la API compatible con S3 (igual que Amazon
// S3). Grabaciones más largas que esto necesitarían subida multipart, que
// todavía no está implementada — por ahora directamente se avisa con un
// error claro en vez de fallar en silencio.
const MAX_SINGLE_PUT_BYTES = 5 * 1024 * 1024 * 1024;

function isConfigured() {
  return !!ACCOUNT_ID && !!ACCESS_KEY_ID && !!SECRET_ACCESS_KEY && !!BUCKET;
}

function host() {
  return ACCOUNT_ID + '.r2.cloudflarestorage.com';
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function signingKey(dateStamp) {
  const kDate = hmac('AWS4' + SECRET_ACCESS_KEY, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  return hmac(kService, 'aws4_request');
}

// Codificación de URI "estilo AWS": como encodeURIComponent, pero además
// escapa !, ', (, ) — que AWS exige escapar y el estándar de JS no toca.
function awsEncode(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function encodePath(objectPath) {
  // Cada segmento (separado por "/") se codifica individualmente, sin
  // tocar las barras que separan carpeta/archivo.
  return objectPath
    .split('/')
    .map((seg) => awsEncode(seg))
    .join('/');
}

function canonicalQueryString(query) {
  const keys = Object.keys(query || {}).sort();
  return keys.map((k) => awsEncode(k) + '=' + awsEncode(String(query[k]))).join('&');
}

// Firma y ejecuta una request contra la API de R2. `objectKey` ya incluye
// el prefijo de carpeta cuando corresponde (o '' para operaciones a nivel
// de bucket, como listar).
async function signedRequest({ method, objectKey, query, body, contentType }) {
  if (!isConfigured()) throw new Error('not_configured');

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payload = body || Buffer.alloc(0);
  const payloadHash = sha256Hex(payload);

  const canonicalUri = '/' + BUCKET + (objectKey ? '/' + encodePath(objectKey) : '');
  const canonicalQs = canonicalQueryString(query);
  const h = host();

  const headersToSign = {
    host: h,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate
  };
  const signedHeaderNames = Object.keys(headersToSign).sort();
  const canonicalHeaders = signedHeaderNames.map((k) => k + ':' + headersToSign[k] + '\n').join('');
  const signedHeadersStr = signedHeaderNames.join(';');

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQs,
    canonicalHeaders,
    signedHeadersStr,
    payloadHash
  ].join('\n');

  const credentialScope = dateStamp + '/' + REGION + '/' + SERVICE + '/aws4_request';
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const signature = hmac(signingKey(dateStamp), stringToSign).toString('hex');

  const authorization =
    'AWS4-HMAC-SHA256 Credential=' + ACCESS_KEY_ID + '/' + credentialScope +
    ', SignedHeaders=' + signedHeadersStr + ', Signature=' + signature;

  const url = 'https://' + h + canonicalUri + (canonicalQs ? '?' + canonicalQs : '');
  const headers = {
    Authorization: authorization,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate
  };
  if (contentType) headers['Content-Type'] = contentType;
  if (body) headers['Content-Length'] = String(body.length);

  return fetch(url, { method, headers, body: body || undefined });
}

async function connect() {
  if (!isConfigured()) return { ok: false, error: 'not_configured' };
  try {
    // Pedimos como mucho 1 objeto: alcanza para confirmar que las
    // credenciales y el nombre del bucket son válidos, sin gastar cuota.
    const res = await signedRequest({ method: 'GET', objectKey: '', query: { 'list-type': '2', 'max-keys': '1' } });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '(sin cuerpo)');
      console.error('[r2 connect] respuesta no OK', res.status, bodyText);
      return { ok: false, error: 'invalid_credentials' };
    }
    tokenStore.saveToken(PROVIDER, { connectedAt: Date.now() });
    return { ok: true };
  } catch (e) {
    console.error('[r2 connect] excepción', e);
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function disconnect() {
  tokenStore.saveToken(PROVIDER, null);
  return { ok: true };
}

// Suma el tamaño de todos los objetos del bucket (paginando de a 1000, que
// es el máximo por página de ListObjectsV2) para saber cuánto espacio se
// usó hasta ahora. R2 no expone un endpoint liviano de "espacio total
// usado" en su API compatible con S3, así que esta es la forma exacta de
// calcularlo — queda desactualizado como mucho por los objetos que se
// hayan subido o borrado en el mismo instante en que se llama.
async function getUsedBytes() {
  let total = 0;
  let continuationToken = null;
  do {
    const query = { 'list-type': '2', 'max-keys': '1000', prefix: UPLOAD_PREFIX };
    if (continuationToken) query['continuation-token'] = continuationToken;
    const res = await signedRequest({ method: 'GET', objectKey: '', query });
    if (!res.ok) throw new Error('list_objects_failed');
    const xml = await res.text();
    const sizeMatches = xml.match(/<Size>(\d+)<\/Size>/g) || [];
    for (const m of sizeMatches) {
      total += Number(m.replace(/<\/?Size>/g, ''));
    }
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    const tokenMatch = xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/);
    continuationToken = truncated && tokenMatch ? tokenMatch[1] : null;
  } while (continuationToken);
  return total;
}

async function status() {
  if (!isConfigured()) return { connected: false, error: 'not_configured' };
  const t = tokenStore.getToken(PROVIDER);
  if (!t) return { connected: false };

  try {
    const usedBytes = await getUsedBytes();
    return { connected: true, usedBytes, totalBytes: SAFETY_CAP_BYTES };
  } catch (e) {
    console.error('[r2 status] excepción', e);
    return { connected: true, usedBytes: null, totalBytes: SAFETY_CAP_BYTES };
  }
}

// Sube un Buffer ya en memoria (no una ruta de archivo — ver nota en
// google-drive.js sobre por qué los videos grabados con la File System
// Access API no tienen una ruta real que Electron pueda leer con fs).
async function uploadBuffer(buffer, fileName, mimeType) {
  if (!isConfigured()) throw new Error('not_connected');
  if (buffer.length > MAX_SINGLE_PUT_BYTES) {
    // Límite conocido: una grabación de más de 5GB no entra en un solo PUT.
    // Hace falta "multipart upload" para soportar eso, que todavía no está
    // implementado acá.
    throw new Error('file_too_large_for_single_put');
  }
  const res = await signedRequest({
    method: 'PUT',
    objectKey: UPLOAD_PREFIX + fileName,
    body: buffer,
    contentType: mimeType
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '(sin cuerpo)');
    console.error('[r2 upload] respuesta no OK', res.status, bodyText);
    throw new Error('upload_failed');
  }
  return { ok: true };
}

module.exports = { connect, disconnect, status, uploadBuffer, isConfigured };
