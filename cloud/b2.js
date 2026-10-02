// Conexión real a Backblaze B2 (almacenamiento compatible con S3), usando
// su "S3 Compatible API". El patrón es prácticamente idéntico al de
// cloud/r2.js (ambos firman las requests a mano con AWS Signature V4),
// salvo que B2 identifica la cuenta con un endpoint + región propios en
// vez de un "account ID" como Cloudflare, así que acá la región se extrae
// del endpoint en vez de ser siempre "auto".
//
// Igual que R2: no hay login por navegador, es una API key fija (keyID +
// applicationKey) que generás una sola vez en el dashboard de Backblaze y
// pegás en cloud/credentials.local.json (gitignoreado, nunca se sube —
// ver cloud/credentials.local.json.example).
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const tokenStore = require('./token-store');

function loadCredentials() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'credentials.local.json'), 'utf8');
    const json = JSON.parse(raw);
    return (json && json.b2) || {};
  } catch (e) {
    return {};
  }
}

const creds = loadCredentials();
// El endpoint que muestra Backblaze tiene la forma
// "s3.<region>.backblazeb2.com" — de ahí sacamos la región que hace falta
// para firmar las requests (a diferencia de R2, que siempre usa "auto").
const ENDPOINT = (creds.endpoint || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
const REGION_MATCH = ENDPOINT.match(/^s3\.([^.]+)\.backblazeb2\.com$/);
const REGION = REGION_MATCH ? REGION_MATCH[1] : 'us-west-004';
const KEY_ID = creds.keyId || '';
const APPLICATION_KEY = creds.applicationKey || '';
const BUCKET = creds.bucketName || '';
// Mismo concepto de "tope de seguridad" que en R2: si la próxima subida
// haría que el total usado en el bucket supere esto, CamTrader salta a
// otro proveedor en vez de arriesgarse a generar cargos. Por defecto un
// poco por debajo de los 10 GB gratis de B2. Ajustable con "safetyCapGB"
// dentro de "b2" en cloud/credentials.local.json.
const SAFETY_CAP_BYTES = (creds.safetyCapGB || 9.5) * 1024 * 1024 * 1024;

const PROVIDER = 'b2';
const SERVICE = 's3';
const UPLOAD_PREFIX = 'CamTrader/';
const MAX_SINGLE_PUT_BYTES = 5 * 1024 * 1024 * 1024; // mismo límite de un PUT simple que en R2; falta multipart para archivos más grandes.

function isConfigured() {
  return !!ENDPOINT && !!KEY_ID && !!APPLICATION_KEY && !!BUCKET;
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function signingKey(dateStamp) {
  const kDate = hmac('AWS4' + APPLICATION_KEY, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  return hmac(kService, 'aws4_request');
}

function awsEncode(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function encodePath(objectPath) {
  return objectPath
    .split('/')
    .map((seg) => awsEncode(seg))
    .join('/');
}

function canonicalQueryString(query) {
  const keys = Object.keys(query || {}).sort();
  return keys.map((k) => awsEncode(k) + '=' + awsEncode(String(query[k]))).join('&');
}

async function signedRequest({ method, objectKey, query, body, contentType }) {
  if (!isConfigured()) throw new Error('not_configured');

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payload = body || Buffer.alloc(0);
  const payloadHash = sha256Hex(payload);

  const canonicalUri = '/' + BUCKET + (objectKey ? '/' + encodePath(objectKey) : '');
  const canonicalQs = canonicalQueryString(query);

  const headersToSign = {
    host: ENDPOINT,
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
    'AWS4-HMAC-SHA256 Credential=' + KEY_ID + '/' + credentialScope +
    ', SignedHeaders=' + signedHeadersStr + ', Signature=' + signature;

  const url = 'https://' + ENDPOINT + canonicalUri + (canonicalQs ? '?' + canonicalQs : '');
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
    const res = await signedRequest({ method: 'GET', objectKey: '', query: { 'list-type': '2', 'max-keys': '1' } });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '(sin cuerpo)');
      console.error('[b2 connect] respuesta no OK', res.status, bodyText);
      return { ok: false, error: 'invalid_credentials' };
    }
    tokenStore.saveToken(PROVIDER, { connectedAt: Date.now() });
    return { ok: true };
  } catch (e) {
    console.error('[b2 connect] excepción', e);
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function disconnect() {
  tokenStore.saveToken(PROVIDER, null);
  return { ok: true };
}

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
    console.error('[b2 status] excepción', e);
    return { connected: true, usedBytes: null, totalBytes: SAFETY_CAP_BYTES };
  }
}

async function uploadBuffer(buffer, fileName, mimeType) {
  if (!isConfigured()) throw new Error('not_connected');
  if (buffer.length > MAX_SINGLE_PUT_BYTES) {
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
    console.error('[b2 upload] respuesta no OK', res.status, bodyText);
    throw new Error('upload_failed');
  }
  return { ok: true };
}

module.exports = { connect, disconnect, status, uploadBuffer, isConfigured };
