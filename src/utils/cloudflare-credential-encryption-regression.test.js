'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// Keep these tests independent from the developer or deployment key file.
process.env.ENCRYPTION_KEY = 'ab'.repeat(32);
process.env.STORAGE_TYPE = 'redis';

const {
  encrypt,
  isEncrypted,
  encryptUserConfig,
  decryptUserConfig,
  findEncryptedSensitiveInputPaths
} = require('./encryption');
const { normalizeConfig } = require('./config');
const StorageFactory = require('../storage/StorageFactory');
const { SessionManager } = require('./sessionManager');

const WORKERS_CREDENTIAL = '0123456789abcdef0123456789abcdef|cloudflare-test-token';

function hash(value, length) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, length);
}

test('Cloudflare Workers credential is encrypted at rest and decrypted for runtime', () => {
  const input = {
    cloudflareWorkersApiKey: WORKERS_CREDENTIAL,
    geminiApiKey: 'gemini-test-key',
    assemblyAiApiKey: 'assembly-test-key'
  };

  const stored = encryptUserConfig(input);

  assert.equal(input.cloudflareWorkersApiKey, WORKERS_CREDENTIAL);
  assert.equal(stored._encrypted, true);
  assert.equal(isEncrypted(stored.cloudflareWorkersApiKey), true);
  assert.equal(isEncrypted(stored.geminiApiKey), true);
  assert.equal(isEncrypted(stored.assemblyAiApiKey), true);
  assert.equal(JSON.stringify(stored).includes(WORKERS_CREDENTIAL), false);

  const runtime = decryptUserConfig(stored);
  assert.equal(runtime.cloudflareWorkersApiKey, WORKERS_CREDENTIAL);
  assert.equal(runtime.geminiApiKey, 'gemini-test-key');
  assert.equal(runtime.assemblyAiApiKey, 'assembly-test-key');
  assert.equal(runtime.__plaintextSensitiveFieldsDetected, undefined);
});

test('Cloudflare Workers credential avoids double encryption and retains bounded nested recovery', () => {
  const encryptedOnce = encrypt(WORKERS_CREDENTIAL);

  const preserved = encryptUserConfig({ cloudflareWorkersApiKey: encryptedOnce });
  assert.equal(preserved.cloudflareWorkersApiKey, encryptedOnce);
  assert.deepEqual(
    findEncryptedSensitiveInputPaths({ cloudflareWorkersApiKey: encryptedOnce }),
    ['cloudflareWorkersApiKey']
  );

  const nestedRuntime = decryptUserConfig({
    _encrypted: true,
    cloudflareWorkersApiKey: encrypt(encryptedOnce)
  });
  assert.equal(nestedRuntime.cloudflareWorkersApiKey, WORKERS_CREDENTIAL);
  assert.equal(nestedRuntime.__nestedEncryptionRecovered, true);
  assert.deepEqual(nestedRuntime.__nestedEncryptionRecoveredFields, ['cloudflareWorkersApiKey']);

  const undecryptable = '1:not-an-iv:not-an-auth-tag:not-ciphertext';
  const failedRuntime = decryptUserConfig({
    _encrypted: true,
    cloudflareWorkersApiKey: undecryptable
  });
  assert.equal(failedRuntime.cloudflareWorkersApiKey, '');
  assert.equal(failedRuntime.__decryptionWarning, true);
  assert.deepEqual(failedRuntime.__decryptionWarningFields, ['cloudflareWorkersApiKey']);
  assert.equal(failedRuntime.__plaintextSensitiveFieldsDetected, undefined);
});

test('normalizeConfig trims Cloudflare credentials and rejects ciphertext before runtime use', () => {
  const normalized = normalizeConfig({
    cloudflareWorkersApiKey: `  ${WORKERS_CREDENTIAL}  `
  });
  assert.equal(normalized.cloudflareWorkersApiKey, WORKERS_CREDENTIAL);

  const failedDecrypt = normalizeConfig({
    cloudflareWorkersApiKey: '1:not-an-iv:not-an-auth-tag:not-ciphertext'
  });
  assert.equal(failedDecrypt.cloudflareWorkersApiKey, '');
  assert.equal(failedDecrypt.__credentialDecryptionFailed, true);
  assert.deepEqual(failedDecrypt.__credentialDecryptionFailedFields, ['cloudflareWorkersApiKey']);

  assert.equal(normalizeConfig({ cloudflareWorkersApiKey: { token: 'invalid' } }).cloudflareWorkersApiKey, '');
});

test('marked legacy sessions keep the plaintext credential working and rewrite it encrypted', async (t) => {
  const token = '0123456789abcdef0123456789abcdef';
  const userConfig = { cloudflareWorkersApiKey: WORKERS_CREDENTIAL };
  const fingerprint = hash(JSON.stringify(userConfig), 16);
  const sessionData = {
    token,
    tokenFingerprint: hash(token, 16),
    historyUserHash: 'sesshist_test',
    config: {
      ...userConfig,
      __sessionToken: token,
      __sessionFingerprint: fingerprint,
      _encrypted: true
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastAccessedAt: Date.now(),
    disabled: false,
    disabledAt: null,
    fingerprint,
    integrity: hash(`${token}|${fingerprint}`, 24)
  };

  const persisted = [];
  const fakeAdapter = {
    async set(key, value, cacheType) {
      persisted.push({ key, value: JSON.parse(JSON.stringify(value)), cacheType });
      return true;
    }
  };
  const previousAdapter = StorageFactory.instance;
  StorageFactory.instance = fakeAdapter;
  t.after(() => { StorageFactory.instance = previousAdapter; });

  const manager = Object.create(SessionManager.prototype);
  manager.cache = new Map([[token, sessionData]]);
  manager.decryptedCache = new Map();
  manager.failedLookups = new Map();
  manager.pendingPersistence = new Set();
  manager.maxAge = 90 * 24 * 60 * 60 * 1000;
  manager.redisTtlEnabled = true;
  manager.dirty = false;

  const runtime = await manager.getSession(token);
  await manager._flushPendingPersistence();

  assert.equal(runtime.cloudflareWorkersApiKey, WORKERS_CREDENTIAL);
  assert.equal(runtime.__plaintextSensitiveFieldsDetected, undefined);
  assert.equal(isEncrypted(sessionData.config.cloudflareWorkersApiKey), true);
  assert.ok(persisted.length > 0);
  assert.equal(isEncrypted(persisted.at(-1).value.config.cloudflareWorkersApiKey), true);
  assert.match(persisted.at(-1).value.integrity, /^[a-f0-9]{24}$/);
  assert.match(persisted.at(-1).value.integrityHmac, /^h1:[a-f0-9]{64}$/);
  assert.equal(
    decryptUserConfig(persisted.at(-1).value.config).cloudflareWorkersApiKey,
    WORKERS_CREDENTIAL
  );
});

test('legacy migration never rewrites the config when another credential cannot decrypt', async (t) => {
  const token = 'fedcba9876543210fedcba9876543210';
  const undecryptableGeminiKey = '1:not-an-iv:not-an-auth-tag:not-ciphertext';
  const userConfig = {
    cloudflareWorkersApiKey: WORKERS_CREDENTIAL,
    geminiApiKey: undecryptableGeminiKey
  };
  const fingerprint = hash(JSON.stringify(userConfig), 16);
  const sessionData = {
    token,
    tokenFingerprint: hash(token, 16),
    historyUserHash: 'sesshist_mismatched_key',
    config: {
      ...userConfig,
      __sessionToken: token,
      __sessionFingerprint: fingerprint,
      _encrypted: true
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastAccessedAt: Date.now(),
    disabled: false,
    disabledAt: null,
    fingerprint,
    integrity: hash(`${token}|${fingerprint}`, 24)
  };

  const persisted = [];
  const fakeAdapter = {
    async set(key, value, cacheType) {
      persisted.push({ key, value: JSON.parse(JSON.stringify(value)), cacheType });
      return true;
    }
  };
  const previousAdapter = StorageFactory.instance;
  StorageFactory.instance = fakeAdapter;
  t.after(() => { StorageFactory.instance = previousAdapter; });

  const manager = Object.create(SessionManager.prototype);
  manager.cache = new Map([[token, sessionData]]);
  manager.decryptedCache = new Map();
  manager.failedLookups = new Map();
  manager.pendingPersistence = new Set();
  manager.maxAge = 90 * 24 * 60 * 60 * 1000;
  manager.redisTtlEnabled = true;
  manager.dirty = false;

  const runtime = await manager.getSession(token);
  await manager._flushPendingPersistence();

  assert.equal(runtime.cloudflareWorkersApiKey, WORKERS_CREDENTIAL);
  assert.equal(runtime.geminiApiKey, '');
  assert.equal(sessionData.config.cloudflareWorkersApiKey, WORKERS_CREDENTIAL);
  assert.equal(sessionData.config.geminiApiKey, undecryptableGeminiKey);
  assert.equal(persisted.every(entry => (
    entry.value.config.cloudflareWorkersApiKey === WORKERS_CREDENTIAL
      && entry.value.config.geminiApiKey === undecryptableGeminiKey
  )), true);
});
