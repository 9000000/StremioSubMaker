const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('.dockerignore keeps CHANGELOG.md in the Docker build context', () => {
    const dockerIgnorePath = path.join(__dirname, '..', '.dockerignore');
    const raw = fs.readFileSync(dockerIgnorePath, 'utf-8');

    assert.match(raw, /^!CHANGELOG\.md$/m);
});