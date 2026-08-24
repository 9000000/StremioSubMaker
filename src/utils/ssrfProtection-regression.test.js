'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const dns = require('node:dns');
const axios = require('axios');
const OpenAICompatibleProvider = require('../services/providers/openaiCompatible');
const {
    validateCustomBaseUrl,
    assertSafeCustomRequestUrl,
    isInternalIp,
    resolveAndValidateHost,
    createSsrfSafeLookup,
    createSsrfSafeRedirectValidator
} = require('./ssrfProtection');

async function withInternalEndpointSetting(value, callback) {
    const original = process.env.ALLOW_INTERNAL_CUSTOM_ENDPOINTS;
    if (value === undefined) {
        delete process.env.ALLOW_INTERNAL_CUSTOM_ENDPOINTS;
    } else {
        process.env.ALLOW_INTERNAL_CUSTOM_ENDPOINTS = value;
    }

    try {
        return await callback();
    } finally {
        if (original === undefined) {
            delete process.env.ALLOW_INTERNAL_CUSTOM_ENDPOINTS;
        } else {
            process.env.ALLOW_INTERNAL_CUSTOM_ENDPOINTS = original;
        }
    }
}

test('canonical IP classification blocks non-global IPv4, IPv6, and mapped forms', async () => {
    await withInternalEndpointSetting(undefined, async () => {
        const blocked = [
            '0.0.0.0',
            '10.0.0.1',
            '100.64.0.1',
            '127.0.0.1',
            '169.254.169.254',
            '172.16.0.1',
            '192.168.0.1',
            '192.0.2.1',
            '198.18.0.1',
            '224.0.0.1',
            '[::]',
            '::1',
            '::ffff:7f00:1',
            '[::ffff:7f00:1]',
            '::ffff:127.0.0.1',
            '::ffff:a9fe:a9fe',
            '::ffff:169.254.169.254',
            '64:ff9b::7f00:1',
            '100::1',
            '2001:db8::1',
            'fc00::1',
            'fe80::1',
            'ff02::1'
        ];

        for (const ip of blocked) {
            assert.equal(isInternalIp(ip), true, `${ip} must be blocked`);
        }

        for (const ip of ['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888', '2606:4700:4700::1111']) {
            assert.equal(isInternalIp(ip), false, `${ip} must remain allowed`);
        }
    });
});

test('base URL validation rejects the reported IPv6 bypasses and unsafe URL components', async () => {
    await withInternalEndpointSetting(undefined, async () => {
        const blockedUrls = [
            'http://[::]/',
            'http://[::ffff:7f00:1]/',
            'http://[::ffff:a9fe:a9fe]/',
            'http://[::ffff:169.254.169.254]/',
            'http://2130706433/',
            'https://user:password@example.com/v1',
            'https://example.com/v1#fragment'
        ];

        for (const url of blockedUrls) {
            const result = await validateCustomBaseUrl(url);
            assert.equal(result.valid, false, `${url} must be rejected`);
        }

        const publicLiteral = await validateCustomBaseUrl('https://8.8.8.8/v1');
        assert.equal(publicLiteral.valid, true);
        assert.equal(publicLiteral.sanitized, 'https://8.8.8.8/v1');
    });
});

test('redirect validation rejects internal hops while permitting safe custom-provider redirects', async () => {
    await withInternalEndpointSetting(undefined, async () => {
        const validateRedirect = createSsrfSafeRedirectValidator();
        assert.doesNotThrow(() => validateRedirect({ href: 'https://1.1.1.1/v1/models' }));

        for (const href of [
            'http://127.0.0.1/admin',
            'http://[::ffff:7f00:1]/admin',
            'http://[::ffff:a9fe:a9fe]/metadata',
            'https://user:password@example.com/v1',
            'https://example.com/v1#fragment',
            'file:///etc/passwd'
        ]) {
            assert.throws(
                () => validateRedirect({ href }),
                error => String(error?.code || '').startsWith('ESSRF'),
                `${href} must be rejected as a redirect target`
            );
        }
    });
});

test('connection-time lookup blocks mapped loopback before DNS or socket use', async () => {
    await withInternalEndpointSetting(undefined, async () => {
        const lookup = createSsrfSafeLookup();
        await assert.rejects(
            new Promise((resolve, reject) => {
                lookup('::ffff:7f00:1', { all: false }, (error, address, family) => {
                    if (error) return reject(error);
                    return resolve({ address, family });
                });
            }),
            error => error?.code === 'ESSRF_INTERNAL_IP'
        );
    });
});

test('validation and connection-time DNS checks reject mapped internal answers', async () => {
    await withInternalEndpointSetting(undefined, async () => {
        const originalLookup = dns.lookup;
        dns.lookup = (_hostname, _options, callback) => {
            callback(null, [
                { address: '8.8.8.8', family: 4 },
                { address: '::ffff:7f00:1', family: 6 }
            ]);
        };

        try {
            const validation = await resolveAndValidateHost('provider.example');
            assert.equal(validation.safe, false);
            assert.match(validation.error, /::ffff:7f00:1/);

            const lookup = createSsrfSafeLookup();
            await assert.rejects(
                new Promise((resolve, reject) => {
                    lookup('provider.example', { all: true }, (error, addresses) => {
                        if (error) return reject(error);
                        return resolve(addresses);
                    });
                }),
                error => error?.code === 'ESSRF_INTERNAL_IP'
            );
        } finally {
            dns.lookup = originalLookup;
        }
    });
});

test('custom provider requests enforce the guarded redirect and direct-connection policy', async () => {
    await withInternalEndpointSetting(undefined, async () => {
        const originalPost = axios.post;
        let requestOptions;
        axios.post = async (_url, _body, options) => {
            requestOptions = options;
            return { data: { choices: [{ message: { content: 'OK' } }] } };
        };

        const provider = new OpenAICompatibleProvider({
            providerName: 'custom',
            baseUrl: 'https://8.8.8.8/v1',
            model: 'test-model',
            maxOutputTokens: 16,
            translationTimeout: 5,
            maxRetries: 0,
            ssrfLookup: createSsrfSafeLookup()
        });

        try {
            assert.equal(await provider.validateConfiguration(), true);
            assert.equal(requestOptions.proxy, false);
            assert.equal(typeof requestOptions.beforeRedirect, 'function');
            assert.throws(
                () => requestOptions.beforeRedirect({ href: 'http://[::ffff:7f00:1]/' }),
                error => error?.code === 'ESSRF_INTERNAL_IP'
            );
        } finally {
            axios.post = originalPost;
            provider._ssrfHttpAgent.destroy();
            provider._ssrfHttpsAgent.destroy();
        }
    });
});

test('the production Axios provider cannot reach a harmless mapped-loopback server', async () => {
    await withInternalEndpointSetting(undefined, async () => {
        let reached = false;
        const server = http.createServer((_request, response) => {
            reached = true;
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
        });

        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });

        const provider = new OpenAICompatibleProvider({
            providerName: 'custom',
            baseUrl: `http://[::ffff:7f00:1]:${server.address().port}/v1`,
            model: 'test-model',
            maxOutputTokens: 16,
            translationTimeout: 5,
            maxRetries: 0,
            ssrfLookup: createSsrfSafeLookup()
        });

        try {
            await assert.rejects(
                provider.validateConfiguration(),
                error => error?.code === 'ESSRF_INTERNAL_IP'
            );
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(reached, false);
        } finally {
            provider._ssrfHttpAgent.destroy();
            provider._ssrfHttpsAgent.destroy();
            await new Promise(resolve => server.close(resolve));
        }
    });
});

test('self-hosters retain the explicit internal-endpoint escape hatch', async () => {
    await withInternalEndpointSetting('true', async () => {
        const local = await validateCustomBaseUrl('http://127.0.0.1:11434/v1');
        assert.equal(local.valid, true);
        assert.doesNotThrow(() => assertSafeCustomRequestUrl('http://[::1]:11434/v1'));
        assert.doesNotThrow(() =>
            createSsrfSafeRedirectValidator()({ href: 'http://192.168.1.10:11434/v1' })
        );

        const provider = new OpenAICompatibleProvider({
            providerName: 'custom',
            baseUrl: 'http://127.0.0.1:11434/v1',
            model: 'test-model',
            ssrfLookup: createSsrfSafeLookup()
        });
        const requestConfig = provider.getHttpRequestConfig('http://127.0.0.1:11434/v1/models');
        assert.equal(Object.hasOwn(requestConfig, 'proxy'), false);
        provider._ssrfHttpAgent.destroy();
        provider._ssrfHttpsAgent.destroy();

        const credentials = await validateCustomBaseUrl('http://user:password@127.0.0.1:11434/v1');
        assert.equal(credentials.valid, false);
    });
});
