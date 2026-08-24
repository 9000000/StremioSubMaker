'use strict';

/**
 * Serialize a value as a JavaScript literal that is safe to place inside an
 * inline <script> element. JSON escaping alone is insufficient because HTML
 * parsers recognize a literal </script> even when it occurs inside a JS string.
 */
function serializeJsonForInlineScript(value) {
  const json = JSON.stringify(value);
  if (json === undefined) return 'undefined';

  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

module.exports = { serializeJsonForInlineScript };
