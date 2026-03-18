const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

test('tool pages inline scripts compile and cache-busted assets are direct', async () => {
  const script = `
    process.env.LOG_TO_FILE = 'false';
    const fs = require('node:fs');
    const vm = require('node:vm');
    const { generateSubToolboxPage, generateAutoSubtitlePage } = require('./src/utils/toolboxPageGenerator');
    const { generateFileTranslationPage } = require('./src/utils/fileUploadPageGenerator');
    const { generateHistoryPage } = require('./src/utils/historyPageGenerator');
    const { getDefaultConfig } = require('./src/utils/config');

    (async () => {
      const config = getDefaultConfig();
      config.uiLanguage = 'en';
      config.subToolboxEnabled = true;
      config.targetLanguages = ['eng'];
      config.sourceLanguages = ['eng'];

      const pages = [
        ['sub-toolbox', generateSubToolboxPage('test-config', 'tt0944947:1:1', 'Game.of.Thrones.S01E01.mkv', config)],
        ['file-upload', generateFileTranslationPage('tt0944947:1:1', 'test-config', config, 'Game.of.Thrones.S01E01.mkv')],
        ['sub-history', generateHistoryPage('test-config', [], config, 'tt0944947:1:1', 'Game.of.Thrones.S01E01.mkv', {
          deferHistoryLoad: true,
          historyContentEndpoint: '/api/sub-history-content?config=test-config'
        })],
        ['auto-subtitles', await generateAutoSubtitlePage('test-config', 'tt0944947:1:1', 'Game.of.Thrones.S01E01.mkv', config, '')]
      ];

      const scriptRegex = new RegExp('<script(?:[^>]*)>([\\\\s\\\\S]*?)<\\\\/script>', 'g');
      const assetMatchers = [
        { name: 'sw-register', regex: /<script[^>]+src="([^"]*\\/js\\/sw-register\\.js[^"]*)"/g },
        { name: 'theme-toggle', regex: /<script[^>]+src="([^"]*\\/js\\/theme-toggle\\.js[^"]*)"/g },
        { name: 'subtitle-menu', regex: /<script[^>]+src="([^"]*\\/js\\/subtitle-menu\\.js[^"]*)"/g },
        { name: 'combobox.css', regex: /<link[^>]+href="([^"]*\\/css\\/combobox\\.css[^"]*)"/g }
      ];
      const swRegisterScript = fs.readFileSync('./public/js/sw-register.js', 'utf8');

      if (!swRegisterScript.includes(\"navigator.serviceWorker.register('/sw.js?v=' + encodeURIComponent(cacheBust) + '&_cb=' + encodeURIComponent(versionTag),\")) {
        throw new Error('sw-register.js must register /sw.js with _cb to avoid redirect-rejected service worker loads');
      }

      for (const [name, html] of pages) {
        const scripts = [...html.matchAll(scriptRegex)].map(match => match[1]);
        if (!scripts.length) {
          throw new Error(name + ' expected inline scripts');
        }
        scripts.forEach((code, index) => {
          new vm.Script(code, { filename: name + '-inline-' + (index + 1) + '.js' });
        });

        assetMatchers.forEach(({ name: assetName, regex }) => {
          const matches = [...html.matchAll(regex)].map(match => match[1]);
          matches.forEach((url) => {
            if (!/_cb=/.test(url)) {
              throw new Error(name + ' emits redirect-prone ' + assetName + ' URL without _cb: ' + url);
            }
          });
        });
      }

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
