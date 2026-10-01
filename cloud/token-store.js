// Guarda los tokens de las cuentas conectadas (Google Drive, etc.) cifrados
// en disco con safeStorage de Electron (usa el llavero del sistema operativo:
// Keychain en Mac, Credential Vault en Windows, libsecret en Linux). Nunca
// quedan en texto plano.
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

function filePath() {
  return path.join(app.getPath('userData'), 'cloud-tokens.json');
}

function readRaw() {
  try {
    return JSON.parse(fs.readFileSync(filePath(), 'utf8'));
  } catch (e) {
    return {};
  }
}

function writeRaw(obj) {
  fs.writeFileSync(filePath(), JSON.stringify(obj), { mode: 0o600 });
}

function getToken(provider) {
  const all = readRaw();
  const enc = all[provider];
  if (!enc) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const buf = Buffer.from(enc, 'base64');
    return JSON.parse(safeStorage.decryptString(buf));
  } catch (e) {
    return null;
  }
}

function saveToken(provider, tokenObj) {
  const all = readRaw();
  if (tokenObj === null) {
    delete all[provider];
  } else {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('encryption_unavailable');
    }
    const enc = safeStorage.encryptString(JSON.stringify(tokenObj));
    all[provider] = enc.toString('base64');
  }
  writeRaw(all);
}

module.exports = { getToken, saveToken };
