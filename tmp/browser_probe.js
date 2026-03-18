process.env.LOG_TO_FILE = 'false';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { chromium } = require('playwright-core');
const { getDefaultConfig } = require('../src/utils/config');
const { version } = require('../package.json');

function toBase64Url(input) {
  return Buffer.from(String(input), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function pickBrowserExecutable() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

async function waitForServer(baseUrl, child, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch (_) {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('server did not become ready before timeout');
}

function createProbeConfig() {
  const config = getDefaultConfig();
  config.uiLanguage = 'en';
  config.subToolboxEnabled = true;
  config.targetLanguages = ['pob'];
  config.sourceLanguages = ['eng'];
  config.autoTranslate = true;
  return config;
}

function dedupeByKey(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function probePage(browser, baseUrl, spec) {
  const page = await browser.newPage();
  const consoleMessages = [];
  const pageErrors = [];
  const requestFailures = [];
  const badResponses = [];
  const redirectChains = [];

  page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'error' || type === 'warning') {
      consoleMessages.push({ type, text: msg.text() });
    }
  });
  page.on('pageerror', (error) => {
    pageErrors.push(String(error && error.stack ? error.stack : error));
  });
  page.on('requestfailed', (request) => {
    requestFailures.push({
      url: request.url(),
      resourceType: request.resourceType(),
      errorText: request.failure() ? request.failure().errorText : 'unknown'
    });
  });
  page.on('response', (response) => {
    const request = response.request();
    const resourceType = request.resourceType();
    if (response.status() >= 400) {
      badResponses.push({
        status: response.status(),
        url: response.url(),
        resourceType
      });
    }
    if (resourceType === 'script' || resourceType === 'stylesheet' || resourceType === 'image') {
      const chain = [];
      let current = request;
      while (current) {
        chain.unshift(current.url());
        current = current.redirectedFrom();
      }
      if (chain.length > 1) {
        redirectChains.push({ resourceType, chain });
      }
    }
  });

  await page.goto(`${baseUrl}${spec.path}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

  const result = {
    name: spec.name,
    path: spec.path,
    consoleMessages,
    pageErrors,
    requestFailures,
    badResponses,
    redirectChains: dedupeByKey(redirectChains, (item) => `${item.resourceType}:${item.chain.join(' -> ')}`),
    checks: {}
  };

  if (spec.name === 'configure') {
    await page.waitForFunction(() => !!window.partialsReady, null, { timeout: 10000 });
    await page.evaluate(() => window.partialsReady);
    result.checks.partialTargetsRemaining = await page.locator('[data-include]').count();
    result.checks.loadErrorBanner = await page.locator('text=/Failed to load/i').count();
    result.checks.documentTitle = await page.title();
    result.checks.appVersion = await page.evaluate(() => window.__APP_VERSION__ || null);
  }

  if (spec.name === 'subtitle-sync') {
    await page.waitForTimeout(1200);
    result.checks.extensionLabelBeforePong = await page.locator('#ext-label').innerText();
    await page.evaluate(() => {
      window.postMessage({ type: 'SUBMAKER_PONG', source: 'extension', version: '1.2.3' }, '*');
    });
    await page.waitForTimeout(1500);
    result.checks.extensionLabelAfterPong1_5s = await page.locator('#ext-label').innerText();
    await page.waitForTimeout(5000);
    result.checks.extensionLabelAfterPong6_5s = await page.locator('#ext-label').innerText();
  }

  if (spec.name === 'smdb') {
    result.checks.heading = await page.locator('h1').first().innerText().catch(() => '');
  }

  await page.close();
  return result;
}

async function main() {
  const executablePath = pickBrowserExecutable();
  if (!executablePath) {
    throw new Error('could not find Edge or Chrome executable for Playwright');
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'submaker-page-probe-'));
  const port = 7137;
  const baseUrl = `http://127.0.0.1:${port}`;
  const config = createProbeConfig();
  const configStr = toBase64Url(JSON.stringify(config));

  const child = spawn(process.execPath, ['index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      STORAGE_TYPE: 'filesystem',
      ALLOW_BASE64_CONFIG: 'true',
      LOG_TO_FILE: 'false',
      SESSION_PERSISTENCE_PATH: path.join(tempRoot, 'sessions.json'),
      INSTANCE_ID_FILE: path.join(tempRoot, '.instance-id'),
      INSTANCE_ISOLATION_KEY: 'page_probe'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  try {
    await waitForServer(baseUrl, child);
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const pages = [
        {
          name: 'smdb',
          path: `/smdb?config=${encodeURIComponent(configStr)}&videoId=${encodeURIComponent('tt0944947:1:1')}&filename=${encodeURIComponent('Game.of.Thrones.S01E01.mkv')}`
        },
        {
          name: 'subtitle-sync',
          path: `/subtitle-sync?config=${encodeURIComponent(configStr)}&videoId=${encodeURIComponent('tt0944947:1:1')}&filename=${encodeURIComponent('Game.of.Thrones.S01E01.mkv')}`
        },
        {
          name: 'configure',
          path: `/configure?config=${encodeURIComponent(configStr)}`
        }
      ];

      const pageResults = [];
      for (const spec of pages) {
        pageResults.push(await probePage(browser, baseUrl, spec));
      }

      process.stdout.write(JSON.stringify({
        ok: true,
        version,
        executablePath,
        pageResults
      }, null, 2));
    } finally {
      await browser.close();
    }
  } catch (error) {
    process.stderr.write(JSON.stringify({
      ok: false,
      error: error && error.stack ? error.stack : String(error),
      serverStdout: stdout,
      serverStderr: stderr
    }, null, 2));
    process.exitCode = 1;
  } finally {
    if (child.exitCode === null) {
      child.kill();
    }
  }
}

main();
