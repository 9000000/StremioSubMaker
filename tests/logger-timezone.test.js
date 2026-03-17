const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const fixedIsoTimestamp = '2024-01-02T03:04:05.678Z';
const timestampPattern = /^\[(.+?)\] \[INFO\] hello$/m;

function runLoggerWithTimezone(tz) {
    const env = { ...process.env, LOG_TO_FILE: 'false', LOG_LEVEL: 'debug' };

    if (tz === undefined) {
        delete env.TZ;
    } else {
        env.TZ = tz;
    }

    const script = `
const fixedIso = ${JSON.stringify(fixedIsoTimestamp)};
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [fixedIso]));
  }
  static now() {
    return new RealDate(fixedIso).getTime();
  }
}
FakeDate.parse = RealDate.parse;
FakeDate.UTC = RealDate.UTC;
global.Date = FakeDate;
const log = require('./src/utils/logger');
log.info(() => 'hello');
`;

    const result = spawnSync(process.execPath, ['-e', script], {
        cwd: repoRoot,
        env,
        encoding: 'utf8'
    });

    assert.equal(result.status, 0, `logger subprocess failed: ${result.stderr || 'unknown error'}`);

    const match = result.stdout.match(timestampPattern);
    assert.ok(match, `could not extract timestamp from output: ${JSON.stringify(result.stdout)}`);
    return match[1];
}

test('logger keeps legacy UTC timestamps when TZ is unset', () => {
    assert.equal(runLoggerWithTimezone(undefined), fixedIsoTimestamp);
});

test('logger uses configured timezone offsets for valid IANA zones', () => {
    assert.equal(runLoggerWithTimezone('America/New_York'), '2024-01-01T22:04:05.678-05:00');
});

test('logger supports non-hour timezone offsets', () => {
    assert.equal(runLoggerWithTimezone('Asia/Kathmandu'), '2024-01-02T08:49:05.678+05:45');
});

test('logger falls back to UTC when TZ is invalid', () => {
    assert.equal(runLoggerWithTimezone('Invalid/Timezone'), fixedIsoTimestamp);
});
