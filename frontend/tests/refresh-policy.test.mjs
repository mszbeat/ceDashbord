import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('middleware refreshes whenever a refresh cookie exists', () => {
  const source = read('middleware.ts');
  assert.match(source, /const canAttemptRefresh = hasCookie\(probe\.cookieHeader, 'ce_refresh'\)/);
  assert.doesNotMatch(source, /canRefresh !== false/);
  assert.doesNotMatch(source, /pathname !== '\/'/);
});

test('BFF strips an expired/visitor token before calling refresh', () => {
  const source = read('lib/server-auth.ts');
  assert.match(source, /stripCookie\(probe\.cookieHeader, 'token'\)/);
  assert.match(source, /postRefresh\(refreshBaseCookies\)/);
});

test('client auth layers do not bail out on canRefresh:false from /me', () => {
  const frontend = read('lib/auth-client.ts');
  assert.doesNotMatch(frontend, /canRefresh === false/);
  assert.doesNotMatch(frontend, /me\.canRefresh \|\| !me\._ok/);
  assert.match(frontend, /if \(!me\.authenticated\)/);

  const report = read('../backend/services/legacy-report/assets/client.js');
  assert.doesNotMatch(report, /canRefresh === false/);
  assert.doesNotMatch(report, /canRefresh !== false/);
  // حالت syncAuthState بازنویسی شده است: تلاش دوباره، بررسی me.authenticated و شکست فقط با پاسخ معتبر
  assert.match(report, /for \(let attempt = 0; attempt < 2; attempt \+= 1\)/);
  assert.match(report, /me\.authenticated === false/);
});
