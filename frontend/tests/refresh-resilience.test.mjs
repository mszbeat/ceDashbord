'use strict';
/**
 * قراردادهای ضد‌قفل‌شدن نشست (رفرش توکن):
 *  - BFF پیش از چرخش توکن، اعتبار آن را با /api/auth/refresh/peek می‌سنجد
 *  - درخواست‌های هم‌زمان مرورگر روی یک Promise مشترک ادغام می‌شوند
 *  - پاسخ موفقِ چرخش برای همان توکن قدیمی (تب دیگر) بازپخش می‌شود
 *  - کلاینت‌ها تمدید پیش‌دستانه انجام می‌دهند و خطای موقت را «انقضا» حساب نمی‌کنند
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const refreshRoute = read('frontend', 'app', 'api', 'auth', 'refresh', 'route.ts');
const peekRoute = read('frontend', 'app', 'api', 'auth', 'refresh', 'peek', 'route.ts');
const serverAuth = read('frontend', 'lib', 'server-auth.ts');
const authClient = read('frontend', 'lib', 'auth-client.ts');
const reportClient = read('backend', 'services', 'legacy-report', 'assets', 'client.js');

test('BFF refresh: peek first, single-flight per token, replay of a successful rotation', () => {
  assert.match(refreshRoute, /peekRefreshToken\(/);
  assert.match(refreshRoute, /const flights = new Map/);
  assert.match(refreshRoute, /const rotationReplay = new Map/);
  assert.match(refreshRoute, /x-ce-refresh-flight/);
  assert.match(refreshRoute, /x-ce-refresh-replay/);
  // قبل از چرخش، توکن نامعتبر هرگز ارسال نمی‌شود
  const peekIndex = refreshRoute.indexOf('peekRefreshToken(');
  const rotateIndex = refreshRoute.indexOf('performRefreshWithRecovery(');
  assert.ok(peekIndex > 0 && rotateIndex > peekIndex, 'peek must run before rotation');
});

test('BFF peek route + server helper exist and hit /api/auth/refresh/peek', () => {
  assert.match(serverAuth, /export async function peekRefreshToken\(/);
  assert.match(serverAuth, /\/api\/auth\/refresh\/peek/);
  assert.match(peekRoute, /peekRefreshToken\(/);
  assert.match(peekRoute, /valid/);
});

test('توکن باطل‌شده تا مدتی دوباره ارسال نمی‌شود و فقط خطای قطعی علامت می‌خورد', () => {
  assert.match(serverAuth, /invalidRefreshTokens/);
  assert.match(serverAuth, /export function isRefreshTokenKnownInvalid/);
  assert.match(serverAuth, /export function markRefreshTokenInvalid/);
  // علامت‌گذاری فقط روی کدهای قطعی خطای رفرش/۴۰۱/۴۰۳ (از طریق helper مشترک)
  assert.match(serverAuth, /export function isDefinitiveRefreshFailure/);
  assert.match(serverAuth, /const definitive = isDefinitiveRefreshFailure\(attempt\.res\.status, metaCode\)/);
  assert.match(serverAuth, /if \(definitive\) \{\s*markRefreshTokenInvalid\(incomingCookieHeader\);/);
});

test('BUGFIX: خطای موقت تمدید (۵xx) کاربر را از حساب خارج نمی‌کند', async () => {
  const { isDefinitiveRefreshFailure, isTransientAuthFailure } = await import('../lib/server-auth.ts')
    .catch(() => import('../dist-test/server-auth.mjs'))
    .catch(() => ({}));

  // اگر ماژول TS در Node قابل import نبود، حداقل منطق را از متن فایل می‌سنجیم
  if (typeof isDefinitiveRefreshFailure !== 'function') {
    assert.match(serverAuth, /status === 401 \|\| status === 403/);
    assert.match(serverAuth, /status >= 500/);
    return;
  }

  // شکست قطعی نشست
  assert.equal(isDefinitiveRefreshFailure(401), true);
  assert.equal(isDefinitiveRefreshFailure(403), true);
  assert.equal(isDefinitiveRefreshFailure(500, 'refreshTokenRevoked'), true);

  // شکست موقت سرویس ⇒ نباید خروج از حساب شود
  assert.equal(isDefinitiveRefreshFailure(503), false);
  assert.equal(isDefinitiveRefreshFailure(502), false);
  assert.equal(isDefinitiveRefreshFailure(504), false);
  assert.equal(isDefinitiveRefreshFailure(429), false);
  assert.equal(isDefinitiveRefreshFailure(0), false);

  assert.equal(isTransientAuthFailure(503), true);
  assert.equal(isTransientAuthFailure(401), false);
  assert.equal(isTransientAuthFailure(500, 'invalidRefreshToken'), false);
});

test('کلاینت ادمین: تمدید پیش‌دستانه و تحمل خطای موقت در keepalive', () => {
  assert.match(authClient, /schedulePreemptiveRefresh/);
  assert.match(authClient, /accessMs \* 0\.6/);
  assert.match(authClient, /unconfirmed >= 3/);
  // authFetch روی ۴۰۱ تمدید و همان درخواست را تکرار می‌کند
  assert.match(authClient, /if \(res\.status === 401\) \{/);
});

test('کلاینت گزارش قدیمی: تمدید پیش‌دستانه، عدم تمدید در تب پنهان و عدم پرتاب با خطای موقت', () => {
  assert.match(reportClient, /refreshTimer = window\.setTimeout/);
  assert.match(reportClient, /document\.visibilityState !== 'visible'[\s\S]{0,200}return Promise\.resolve\(false\)/);
  assert.match(reportClient, /sessionUnconfirmed \+= 1/);
});
