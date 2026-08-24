'use strict';

const http = require('node:http');
const https = require('node:https');
const {
    assertSafePublicRequestUrl,
    createSsrfSafeLookup,
    createSsrfSafeRedirectValidator
} = require('./ssrfProtection');
const { MAX_REMOTE_SUBTITLE_BYTES } = require('./resourceLimits');

const publicLookup = createSsrfSafeLookup({ allowInternal: false });
const publicRedirectValidator = createSsrfSafeRedirectValidator({
    allowInternal: false,
    context: 'remote subtitle'
});
const publicHttpsRedirectValidator = createSsrfSafeRedirectValidator({
    allowInternal: false,
    allowedProtocols: ['https:'],
    context: 'remote subtitle'
});

const commonAgentOptions = {
    keepAlive: true,
    maxSockets: 100,
    maxFreeSockets: 20,
    timeout: 60000,
    keepAliveMsecs: 30000,
    lookup: publicLookup
};

const publicHttpAgent = new http.Agent(commonAgentOptions);
const publicHttpsAgent = new https.Agent({
    ...commonAgentOptions,
    minVersion: 'TLSv1.2',
    rejectUnauthorized: true
});

/**
 * Build Axios options for a URL obtained from an untrusted provider response or
 * client-visible token. Security properties are assigned after caller options
 * so a call site cannot accidentally override them.
 */
function createPublicRemoteRequestConfig(rawUrl, requestConfig = {}, policy = {}) {
    const allowedProtocols = policy.requireHttps === true
        ? ['https:']
        : ['http:', 'https:'];
    assertSafePublicRequestUrl(rawUrl, {
        allowedProtocols,
        context: policy.context || 'remote subtitle'
    });

    const configuredLimit = Number.isSafeInteger(policy.maxBytes) && policy.maxBytes > 0
        ? policy.maxBytes
        : MAX_REMOTE_SUBTITLE_BYTES;

    return {
        ...requestConfig,
        httpAgent: publicHttpAgent,
        httpsAgent: publicHttpsAgent,
        lookup: publicLookup,
        beforeRedirect: policy.requireHttps === true
            ? publicHttpsRedirectValidator
            : publicRedirectValidator,
        proxy: false,
        maxRedirects: 5,
        decompress: true,
        maxContentLength: configuredLimit,
        maxBodyLength: configuredLimit
    };
}

function isRemoteResponseTooLargeError(error) {
    return error?.code === 'ERR_BAD_RESPONSE' && /maxContentLength size of \d+ exceeded/i.test(error?.message || '');
}

/**
 * follow-redirects wraps exceptions raised by beforeRedirect as
 * ERR_FR_REDIRECTION_FAILURE. Preserve the security meaning of the original
 * exception so callers stop immediately instead of retrying a blocked hop.
 */
function isSsrfBlockedRequestError(error) {
    const code = String(error?.code || '');
    const message = String(error?.message || '');
    return code.startsWith('ESSRF') || message.includes('[SSRF]');
}

module.exports = {
    MAX_REMOTE_SUBTITLE_BYTES,
    createPublicRemoteRequestConfig,
    isRemoteResponseTooLargeError,
    isSsrfBlockedRequestError,
    publicHttpAgent,
    publicHttpsAgent,
    publicLookup,
    publicRedirectValidator,
    publicHttpsRedirectValidator
};
