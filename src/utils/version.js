// Centralized version source: read from package.json at runtime
const path = require('path');

function getVersion() {
  try {
    // Resolve package.json relative to this file
    const pkg = require(path.join(__dirname, '..', '..', 'package.json'));
    return pkg.version || '0.0.0';
  } catch (e) {
    return '0.0.0';
  }
}

module.exports = { version: getVersion() };

