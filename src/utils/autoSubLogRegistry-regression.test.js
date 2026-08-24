const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { AutoSubLogRegistry } = require('./autoSubLogRegistry');

const TOKEN_A = 'a'.repeat(32);
const TOKEN_B = 'b'.repeat(32);
const TOKEN_C = 'c'.repeat(32);

test('unknown and unauthorized log lookups never allocate channels', () => {
  const registry = new AutoSubLogRegistry();

  assert.equal(registry.lookup('unknown-job', TOKEN_A), null);
  assert.equal(registry.lookup('../invalid', TOKEN_A), null);
  assert.equal(registry.size, 0);

  const reservation = registry.reserve('known-job', TOKEN_A, 'owner-a', 1000);
  assert.equal(reservation.ok, true);
  assert.equal(registry.reserve('known-job', TOKEN_B, 'owner-b', 1001).reason, 'exists');
  assert.equal(registry.lookup('known-job', TOKEN_B, 1001), null);
  assert.equal(registry.lookup('known-job', TOKEN_A, 1001), reservation.channel);
  assert.equal(registry.size, 1);
});

test('channel counts are capped globally and per owner, then released on removal', () => {
  const registry = new AutoSubLogRegistry({
    maxChannels: 2,
    maxChannelsPerOwner: 1
  });

  assert.equal(registry.reserve('job-a', TOKEN_A, 'owner-a').ok, true);
  assert.equal(registry.reserve('job-b', TOKEN_B, 'owner-a').reason, 'owner-capacity');
  assert.equal(registry.reserve('job-b', TOKEN_B, 'owner-b').ok, true);
  assert.equal(registry.reserve('job-c', TOKEN_C, 'owner-c').reason, 'global-capacity');

  assert.equal(registry.remove('job-a'), true);
  assert.equal(registry.reserve('job-c', TOKEN_C, 'owner-a').ok, true);
});

test('logs stay bounded and finalization closes every attached listener', () => {
  const registry = new AutoSubLogRegistry({ maxEntries: 2 });
  const { channel } = registry.reserve('job-a', TOKEN_A, 'owner-a', 1000);
  const received = [];
  let doneCount = 0;
  let closeCount = 0;
  const listener = {
    sendEntry(entry) {
      received.push(entry.message);
      return true;
    },
    sendDone() {
      doneCount += 1;
      return true;
    },
    close() {
      closeCount += 1;
    }
  };

  assert.equal(registry.attach(channel, 'viewer-a', listener).ok, true);
  registry.append('job-a', { ts: 1, message: 'one' }, 1001);
  registry.append('job-a', { ts: 2, message: 'two' }, 1002);
  registry.append('job-a', { ts: 3, message: 'three' }, 1003);

  assert.deepEqual(received, ['one', 'two', 'three']);
  assert.deepEqual(channel.logs.map((entry) => entry.message), ['two', 'three']);
  assert.equal(registry.finalize('job-a', channel.logs, 1004), true);
  assert.equal(doneCount, 1);
  assert.equal(closeCount, 1);
  assert.equal(channel.listeners.size, 0);
  assert.equal(registry.listenerCount, 0);
});

test('listener caps and slow-consumer cleanup bound open SSE state', () => {
  const registry = new AutoSubLogRegistry({
    maxChannels: 3,
    maxChannelsPerOwner: 3,
    maxListeners: 2,
    maxListenersPerOwner: 1,
    maxListenersPerChannel: 1
  });
  const first = registry.reserve('job-a', TOKEN_A, 'owner-a').channel;
  const second = registry.reserve('job-b', TOKEN_B, 'owner-b').channel;
  const third = registry.reserve('job-c', TOKEN_C, 'owner-c').channel;
  let slowClosed = 0;
  const slowListener = {
    sendEntry() { return false; },
    sendDone() { return true; },
    close() { slowClosed += 1; }
  };
  const otherListener = {
    sendEntry() { return true; },
    sendDone() { return true; },
    close() {}
  };

  assert.equal(registry.attach(first, 'viewer-a', slowListener).ok, true);
  assert.equal(registry.attach(first, 'viewer-b', otherListener).reason, 'channel-capacity');
  assert.equal(registry.attach(second, 'viewer-a', otherListener).reason, 'owner-capacity');
  assert.equal(registry.attach(second, 'viewer-b', otherListener).ok, true);
  assert.equal(registry.attach(third, 'viewer-c', {
    sendEntry() { return true; }, sendDone() {}, close() {}
  }).reason, 'global-capacity');

  registry.append('job-a', { ts: 1, message: 'backpressure' });
  assert.equal(slowClosed, 1);
  assert.equal(first.listeners.size, 0);
  assert.equal(registry.listenerCount, 1);
});

test('expired channels are removed with their listener accounting', () => {
  const registry = new AutoSubLogRegistry({ ttlMs: 1000 });
  const { channel } = registry.reserve('job-a', TOKEN_A, 'owner-a', 1000);
  let closed = 0;
  registry.attach(channel, 'viewer-a', {
    sendEntry() { return true; },
    sendDone() { return true; },
    close() { closed += 1; }
  });

  assert.equal(registry.sweep(1999), 0);
  assert.equal(registry.sweep(2000), 1);
  assert.equal(registry.size, 0);
  assert.equal(registry.listenerCount, 0);
  assert.equal(closed, 1);
});

test('route wiring reserves only from authenticated run and uses browser crypto', () => {
  const indexSource = fs.readFileSync(path.join(process.cwd(), 'index.js'), 'utf8');
  const pageSource = fs.readFileSync(
    path.join(process.cwd(), 'src/utils/toolboxPageGenerator.js'),
    'utf8'
  );
  const logRouteStart = indexSource.indexOf("app.get('/api/auto-subtitles/logs'");
  const logRouteEnd = indexSource.indexOf('// API: Automatic subtitles', logRouteStart);
  const runRouteStart = indexSource.indexOf("app.post('/api/auto-subtitles/run'");
  const runRouteEnd = indexSource.indexOf('// API endpoint: Download Auto subtitle', runRouteStart);
  const logRoute = indexSource.slice(logRouteStart, logRouteEnd);
  const runRoute = indexSource.slice(runRouteStart, runRouteEnd);

  assert.notEqual(logRouteStart, -1);
  assert.notEqual(logRouteEnd, -1);
  assert.notEqual(runRouteStart, -1);
  assert.notEqual(runRouteEnd, -1);
  assert.match(logRoute, /autoSubLogLimiter/);
  assert.match(logRoute, /liveAutoSubLogs\.lookup/);
  assert.doesNotMatch(logRoute, /liveAutoSubLogs\.reserve/);
  assert.match(logRoute, /status\(404\)/);
  assert.match(indexSource, /\[\?&\]logToken=/);
  assert.ok(
    runRoute.indexOf('__sessionTokenError') < runRoute.indexOf('liveAutoSubLogs.reserve'),
    'channel reservation must occur only after session-token validation'
  );
  assert.match(pageSource, /window\.crypto\.getRandomValues/);
  assert.match(pageSource, /logToken=' \+ encodeURIComponent\(logToken\)/);
  assert.match(pageSource, /payload\.logToken = String\(overrides\.logToken\)/);
});
