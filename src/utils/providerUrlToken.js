'use strict';

const crypto = require('node:crypto');
const { getEncryptionKey } = require('./encryption');

const TOKEN_MARKER = 'e1_';
const TOKEN_VERSION = 1;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAX_URL_BYTES = 4096;
// A maximum-size URL produces roughly 5.5K base64url characters after the
// version, nonce, and authentication tag are added. Leave bounded room for the
// provider prefix and season-pack suffix used by route file IDs.
const MAX_PROVIDER_FILE_ID_CHARS = 6144;
const TOKEN_CONTEXT_PREFIX = 'SubMaker provider URL';

function getTokenContext(providerPrefix) {
    const normalized = String(providerPrefix || '').replace(/_+$/, '');
    if (!/^[a-z0-9-]{1,32}$/i.test(normalized)) {
        throw new Error('Invalid provider URL token context');
    }
    return `${TOKEN_CONTEXT_PREFIX}:${normalized}:v${TOKEN_VERSION}`;
}

function assertUrlPayloadSize(urlBuffer) {
    if (urlBuffer.length === 0 || urlBuffer.length > MAX_URL_BYTES) {
        throw new Error(`Provider download URL must be between 1 and ${MAX_URL_BYTES} bytes`);
    }
}

/**
 * Seal a provider URL into an authenticated, opaque, path-safe file ID.
 * AES-GCM prevents callers from reading or changing the embedded destination.
 */
function encodeProviderUrl(providerPrefix, rawUrl) {
    if (typeof rawUrl !== 'string') {
        throw new Error('Provider download URL must be a string');
    }

    const plaintext = Buffer.from(rawUrl, 'utf8');
    assertUrlPayloadSize(plaintext);

    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
    cipher.setAAD(Buffer.from(getTokenContext(providerPrefix), 'utf8'), {
        plaintextLength: plaintext.length
    });
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const payload = Buffer.concat([
        Buffer.from([TOKEN_VERSION]),
        iv,
        authTag,
        ciphertext
    ]);

    return `${providerPrefix}${TOKEN_MARKER}${payload.toString('base64url')}`;
}

function decodeOpaquePayload(providerPrefix, encodedPayload) {
    try {
        if (!encodedPayload || !/^[A-Za-z0-9_-]+$/.test(encodedPayload)) {
            throw new Error('Malformed opaque token');
        }

        const payload = Buffer.from(encodedPayload, 'base64url');
        if (payload.toString('base64url') !== encodedPayload) {
            throw new Error('Non-canonical opaque token');
        }

        const minimumBytes = 1 + IV_BYTES + AUTH_TAG_BYTES + 1;
        if (payload.length < minimumBytes || payload[0] !== TOKEN_VERSION) {
            throw new Error('Unsupported opaque token');
        }

        const ivStart = 1;
        const tagStart = ivStart + IV_BYTES;
        const ciphertextStart = tagStart + AUTH_TAG_BYTES;
        const iv = payload.subarray(ivStart, tagStart);
        const authTag = payload.subarray(tagStart, ciphertextStart);
        const ciphertext = payload.subarray(ciphertextStart);
        if (ciphertext.length > MAX_URL_BYTES) {
            throw new Error('Opaque token payload is too large');
        }

        const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), iv);
        decipher.setAAD(Buffer.from(getTokenContext(providerPrefix), 'utf8'), {
            plaintextLength: ciphertext.length
        });
        decipher.setAuthTag(authTag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        assertUrlPayloadSize(plaintext);

        const decodedUrl = plaintext.toString('utf8');
        if (!Buffer.from(decodedUrl, 'utf8').equals(plaintext)) {
            throw new Error('Opaque token is not valid UTF-8');
        }
        return decodedUrl;
    } catch (_) {
        const error = new Error('Invalid or tampered provider download ID');
        error.code = 'EINVALID_PROVIDER_URL_TOKEN';
        throw error;
    }
}

function decodeLegacyUrl(encodedPayload) {
    if (!encodedPayload || !/^[A-Za-z0-9_-]+$/.test(encodedPayload)) {
        throw new Error('Invalid legacy provider download ID');
    }

    const decoded = Buffer.from(encodedPayload, 'base64url');
    if (decoded.toString('base64url') !== encodedPayload) {
        throw new Error('Invalid legacy provider download ID');
    }
    assertUrlPayloadSize(decoded);

    const url = decoded.toString('utf8');
    if (!Buffer.from(url, 'utf8').equals(decoded)) {
        throw new Error('Invalid legacy provider download URL encoding');
    }
    return url;
}

/**
 * Decode an opaque file ID. Unsigned pre-v1 IDs are rejected by default; an
 * emergency compatibility flag exists for self-hosters and remains protected
 * by the public-network request guard at the actual call site.
 */
function decodeProviderUrl(fileId, providerPrefix) {
    if (typeof fileId !== 'string' || !fileId.startsWith(providerPrefix)) {
        throw new Error('Invalid provider file ID format');
    }

    const encodedPayload = fileId.slice(providerPrefix.length);
    if (encodedPayload.startsWith(TOKEN_MARKER)) {
        return decodeOpaquePayload(providerPrefix, encodedPayload.slice(TOKEN_MARKER.length));
    }

    if (process.env.ALLOW_LEGACY_UNSIGNED_SUBTITLE_URL_IDS !== 'true') {
        const error = new Error('Legacy unsigned provider download IDs are no longer accepted');
        error.code = 'EUNSIGNED_PROVIDER_URL_ID';
        throw error;
    }

    return decodeLegacyUrl(encodedPayload);
}

module.exports = {
    TOKEN_MARKER,
    MAX_URL_BYTES,
    MAX_PROVIDER_FILE_ID_CHARS,
    encodeProviderUrl,
    decodeProviderUrl
};
