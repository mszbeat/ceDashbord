// Sample-level smoke test for the parts of sampleController that don't need
// the framework running: the plain helper in helpers.js. main.js itself uses
// @Route/@HTTP class decorators that only the framework's loader can
// transpile, so it can't be required directly here — see the note at the
// top of main.js. Use postman/ to exercise the real, routed handlers.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildGreeting } = require('../controllers/sampleController/helpers');

test('buildGreeting uses the given name', () => {
  assert.deepEqual(buildGreeting('World'), { message: 'hello World' });
});

test('buildGreeting falls back to "world" when no name is given', () => {
  assert.deepEqual(buildGreeting(undefined), { message: 'hello world' });
  assert.deepEqual(buildGreeting(''), { message: 'hello world' });
});
