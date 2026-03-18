const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

test('smdb, subtitle-sync, and configure pages emit compile-safe scripts and direct cache-busted assets', async () => {
  const script = `
    process.env.LOG_TO_FILE = 'false';
    process.env.ALLOW_BASE64_CONFIG = 'true';
    const fs = require('node:fs');
    const path = require('node:path');
    const vm = require('node:vm');
    const { generateSmdbPage } = require('./src/utils/smdbPageGenerator');
    const { generateSubtitleSyncPage } = require('./src/utils/syncPageGenerator');
    const { getDefaultConfig } = require('./src/utils/config');
    const { version } = require('./package.json');

    (async () => {
      const config = getDefaultConfig();
      config.uiLanguage = 'en';
      config.subToolboxEnabled = true;
      config.targetLanguages = ['pob'];
      config.sourceLanguages = ['eng'];

      const pages = [
        ['smdb', await generateSmdbPage('test-config', 'tt0944947:1:1', 'Game.of.Thrones.S01E01.mkv', config)],
        ['subtitle-sync', await generateSubtitleSyncPage([], 'tt0944947:1:1', 'Game.of.Thrones.S01E01.mkv', 'test-config', config)],
        ['configure', fs.readFileSync(path.join(process.cwd(), 'public', 'configure.html'), 'utf8')]
      ];

      const scriptRegex = new RegExp('<script(?:[^>]*)>([\\\\s\\\\S]*?)<\\\\/script>', 'g');
      const assetRegex = new RegExp('(?:src|href)="([^"]+)"', 'g');

      for (const [name, html] of pages) {
        const scripts = [...html.matchAll(scriptRegex)].map(match => match[1]);
        if (!scripts.length) {
          throw new Error(name + ' expected inline scripts');
        }

        scripts.forEach((code, index) => {
          new vm.Script(code, { filename: name + '-inline-' + (index + 1) + '.js' });
        });

        const localAssets = [...html.matchAll(assetRegex)]
          .map(match => match[1])
          .filter(url => /^\\//.test(url))
          .filter(url => /\\.(?:js|css|svg)(?:[?#]|$)/.test(url));

        localAssets.forEach((url) => {
          if (!/[?&]_cb=/.test(url)) {
            throw new Error(name + ' emits local asset without _cb: ' + url);
          }
        });
      }

      const configureHtml = pages.find(([name]) => name === 'configure')[1];
      if (!configureHtml.includes("window.__APP_VERSION__ = '" + version + "';")) {
        throw new Error('configure page is missing current window.__APP_VERSION__ bootstrap');
      }

      const configureAssets = [...configureHtml.matchAll(assetRegex)]
        .map(match => match[1])
        .filter(url => /^\\//.test(url))
        .filter(url => /\\.(?:js|css|svg)(?:[?#]|$)/.test(url));

      configureAssets.forEach((url) => {
        const cbMatch = url.match(/[?&]_cb=([^&]+)/);
        if (!cbMatch) {
          throw new Error('configure asset missing _cb: ' + url);
        }
        if (cbMatch[1] !== version) {
          throw new Error('configure asset _cb must match package version: ' + url + ' (expected ' + version + ')');
        }
      });

      const configureScriptSrcs = [...configureHtml.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match => match[1]);
      configureScriptSrcs.forEach((src) => {
        const relPath = src.replace(/^\\//, '').split('?')[0];
        const filePath = path.join(process.cwd(), 'public', relPath.replace(/^public[\\\\/]/, ''));
        const code = fs.readFileSync(filePath, 'utf8');
        new vm.Script(code, { filename: 'configure-asset-' + path.basename(filePath) });
      });

      process.exit(0);
    })().catch((error) => {
      console.error(error && error.stack || error);
      process.exit(1);
    });
  `;

  assert.doesNotThrow(() => {
    execFileSync(process.execPath, ['-e', script], {
      cwd: process.cwd(),
      stdio: 'pipe'
    });
  });
});
