const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const log = require('./logger');

// Persisted instance id so restarts keep the same namespace when no explicit
// isolation value is provided. Stored alongside other process data.
const INSTANCE_FILE = process.env.INSTANCE_ID_FILE || path.join(process.cwd(), '.instance-id');
// Keep in sync with src/utils/encryption.js so we can derive a stable isolation
// namespace from the encryption key even when it's loaded from disk instead of
// the environment. This lets multiple pods share redis sessions/caches when
// the encryption key file is mounted into each container.
const ENCRYPTION_KEY_FILE = process.env.ENCRYPTION_KEY_FILE || path.join(process.cwd(), '.encryption-key');

function sanitizeSegment(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_{2,}/g, '_')
    .slice(0, 32) || 'default';
}

function loadOrCreateInstanceId() {
  try {
    if (fs.existsSync(INSTANCE_FILE)) {
      const raw = fs.readFileSync(INSTANCE_FILE, 'utf8').trim();
      if (raw) {
        return sanitizeSegment(raw);
      }
    }

    const generated = sanitizeSegment(crypto.randomBytes(8).toString('hex'));
    try {
      fs.writeFileSync(INSTANCE_FILE, generated, { mode: 0o600 });
    } catch (err) {
      log.warn(() => ['[Isolation] Failed to persist instance id, using in-memory value:', err.message]);
    }
    return generated;
  } catch (err) {
    log.warn(() => ['[Isolation] Unable to read/write instance id file:', err.message]);
    return 'default';
  }
}

function hashValue(value) {
  try {
    return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
  } catch (_) {
    return null;
  }
}

function getIsolationKey() {
  const envKey = process.env.INSTANCE_ISOLATION_KEY || process.env.INSTANCE_ID || process.env.APP_INSTANCE;
  if (envKey) {
    return sanitizeSegment(envKey);
  }

  if (process.env.ENCRYPTION_KEY) {
    const hashed = hashValue(process.env.ENCRYPTION_KEY);
    if (hashed) {
      return `enc_${hashed.slice(0, 8)}`;
    }
  }

  try {
    if (fs.existsSync(ENCRYPTION_KEY_FILE)) {
      const keyHex = fs.readFileSync(ENCRYPTION_KEY_FILE, 'utf8').trim();
      const hashed = hashValue(keyHex);
      if (hashed) {
        return `enc_${hashed.slice(0, 8)}`;
      }
    }
  } catch (err) {
    log.warn(() => ['[Isolation] Unable to hash encryption key file for isolation:', err.message]);
  }

  return loadOrCreateInstanceId();
}

module.exports = {
  getIsolationKey,
};

