'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    getApiErrorMessage,
    isOpenSubtitlesQuotaError,
    parseApiError,
    handleDownloadError
} = require('./apiErrorHandler');
const OpenSubtitlesService = require('../services/opensubtitles');
const { handleSubtitleDownload } = require('../handlers/subtitles');

function upstream406(message) {
    const error = new Error(message);
    error.response = { status: 406, data: { message }, headers: {} };
    return error;
}

test('does not classify a generic OpenSubtitles 406 as exhausted quota', () => {
    const error = upstream406('The requested file ID is not available');
    assert.equal(isOpenSubtitlesQuotaError(error), false);
    assert.equal(parseApiError(error, 'OpenSubtitles').type, 'client_error');
});

test('preserves the upstream 406 message through the download error wrapper', () => {
    const error = upstream406('The requested file ID is not available');
    let wrapped;
    try {
        handleDownloadError(error, 'OpenSubtitles');
    } catch (caught) {
        wrapped = caught;
    }

    assert.ok(wrapped);
    assert.equal(wrapped.statusCode, 406);
    assert.equal(wrapped.type, 'client_error');
    assert.equal(getApiErrorMessage(wrapped), 'The requested file ID is not available');
    assert.equal(isOpenSubtitlesQuotaError(wrapped), false);
});

test('still recognizes real OpenSubtitles quota responses, including wrapped errors', () => {
    const message = 'You have downloaded the allowed 200 subtitles in the last 24h. Your quota will be renewed later.';
    const error = upstream406(message);
    assert.equal(isOpenSubtitlesQuotaError(error), true);
    assert.equal(parseApiError(error, 'OpenSubtitles').type, 'quota_exceeded');

    let wrapped;
    try {
        handleDownloadError(error, 'OpenSubtitles');
    } catch (caught) {
        wrapped = caught;
    }
    assert.equal(wrapped.type, 'quota_exceeded');
    assert.equal(isOpenSubtitlesQuotaError(wrapped), true);
});

test('download handler only renders the quota subtitle for a real quota response', async (t) => {
    const originalDownload = OpenSubtitlesService.prototype.downloadSubtitle;
    t.after(() => {
        OpenSubtitlesService.prototype.downloadSubtitle = originalDownload;
    });

    OpenSubtitlesService.prototype.downloadSubtitle = async function (fileId) {
        const message = fileId === 'real-quota'
            ? 'You have downloaded the allowed 1000 subtitles in the last 24h. Your quota will be renewed later.'
            : 'The requested file ID is not available';
        handleDownloadError(upstream406(message), 'OpenSubtitles');
    };

    const config = {
        __configHash: 'quota-classification-test',
        uiLanguage: 'en',
        convertAssToVtt: true,
        forceSRTOutput: false,
        subtitleProviders: {
            opensubtitles: {
                enabled: true,
                implementationType: 'auth',
                username: 'user',
                password: 'pass'
            }
        }
    };

    const rejectedFile = await handleSubtitleDownload('invalid-file', 'eng', config);
    assert.doesNotMatch(rejectedFile, /daily download limit reached/i);
    assert.match(rejectedFile, /download failed/i);

    const actualQuota = await handleSubtitleDownload('real-quota', 'eng', config);
    assert.match(actualQuota, /daily download limit reached/i);
    assert.match(actualQuota, /allowed 1000 subtitles/i);
});
