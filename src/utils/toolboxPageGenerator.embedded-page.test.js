const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

test('embedded subtitles page inline scripts compile and include required client helpers', async () => {
  const script = `
    process.env.LOG_TO_FILE = 'false';
    const vm = require('node:vm');
    const { generateEmbeddedSubtitlePage } = require('./src/utils/toolboxPageGenerator');

    (async () => {
      const config = {
        uiLanguage: 'en',
        subToolboxEnabled: true,
        targetLanguages: ['eng'],
        sourceLanguages: ['eng']
      };
      const html = await generateEmbeddedSubtitlePage(
        'test-config',
        '',
        'Example.Show.S01E01.mkv',
        config
      );
      const scriptRegex = new RegExp('<script(?:[^>]*)>([\\\\s\\\\S]*?)<\\\\/script>', 'g');
      const scripts = [...html.matchAll(scriptRegex)].map(match => match[1]);
      if (!scripts.length) {
        throw new Error('expected embedded page to emit inline scripts');
      }
      const runtimeScript = scripts[scripts.length - 1];
      if (!/function cleanDisplayNameClient\\(/.test(runtimeScript)) {
        throw new Error('embedded runtime is missing cleanDisplayNameClient');
      }
      scripts.forEach((code, index) => {
        new vm.Script(code, { filename: 'embedded-inline-' + (index + 1) + '.js' });
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
