/**
 * تطابق پیاده‌سازی امضای BFF بین Next.js (`lib/server-auth.ts`) و بک‌اند
 * (`backend/services/http/bff-bridge.js`).
 *
 * ⚠️ اگر این دو از هم جدا شوند، **همهٔ ورودها** می‌شکنند (بک‌اند امضا را رد می‌کند و
 * کوکی‌ها به مرورگر نمی‌رسند). این تست همان قفلی است که جلوی آن را می‌گیرد.
 *
 * فرانت از WebCrypto (`crypto.subtle`) استفاده می‌کند چون middleware در Edge Runtime
 * اجرا می‌شود؛ بک‌اند از `node:crypto`. هر دو HMAC-SHA256 روی رشتهٔ
 * `ts.nonce.method.path.sha256(cookies)` می‌زنند و باید خروجی بایت‌به‌بایت یکسان بدهند.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const backend = require('../../backend/services/http/bff-bridge.js');

const SECRET = 'test-shared-secret-32-bytes-abcdefgh';
const NOW = 1_700_000_000_000;

const encoder = new TextEncoder();
const toBase64Url = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** همان الگوریتمی که در `lib/server-auth.ts` نوشته شده (تست تطابق الگوریتم) */
async function frontSign({ method, path, cookies = '', secret, nonce, now = Date.now() }) {
  const clean = String(secret || '').trim();
  if (clean.length < 16) return {};
  const ts = String(now);
  const n = nonce || toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const cookieHash = createHash('sha256').update(String(cookies || '')).digest('hex');
  const signing = [ts, n, method, path, cookieHash].join('.');
  const key = await crypto.subtle.importKey('raw', encoder.encode(clean), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(signing));
  return { 'x-ce-bff-ts': ts, 'x-ce-bff-nonce': n, 'x-ce-bff-sig': toBase64Url(new Uint8Array(sig)) };
}

const serverAuthSource = fs.readFileSync(new URL('../lib/server-auth.ts', import.meta.url), 'utf8');

test('BFF: کد فرانت همان الگوریتم مستندشده را دارد (بدون drift)', () => {
  assert.match(serverAuthSource, /export async function signBffRequest/);
  assert.match(serverAuthSource, /'x-ce-bff-ts'/);
  assert.match(serverAuthSource, /'x-ce-bff-nonce'/);
  assert.match(serverAuthSource, /'x-ce-bff-sig'/);
  // Edge Runtime: نباید به node:crypto وابسته شود
  assert.doesNotMatch(
    serverAuthSource.split('\n').filter((l) => l.trim().startsWith('import ')).join('\n'),
    /node:crypto/,
    'server-auth.ts نباید node:crypto import کند (middleware در Edge است)',
  );
  assert.match(serverAuthSource, /crypto\.subtle\.sign/);
  assert.match(serverAuthSource, /\[p\.ts, p\.nonce, p\.method, p\.path, p\.cookieHash\]\.join\('\.'\)/);
});

test('BFF: امضای فرانت و بک‌اند بایت‌به‌بایت یکی است', async () => {
  const args = {
    method: 'POST',
    path: '/api/auth/login',
    cookies: 'token=abc; ce_refresh=def',
    nonce: 'fixed-nonce',
    now: NOW,
    secret: SECRET,
  };
  const frontHeaders = await frontSign(args);
  const backHeaders = backend.buildBffHeaders(args);
  assert.deepEqual(frontHeaders, backHeaders, 'هدرهای تولیدی باید یکسان باشند');
});

test('BFF: امضای فرانت توسط بک‌اند پذیرفته می‌شود (حتی از IP راه‌دور)', async () => {
  const prev = process.env.CE_BFF_SHARED_SECRET;
  process.env.CE_BFF_SHARED_SECRET = SECRET;
  try {
    const cookies = 'ce_refresh=xyz';
    const signed = await frontSign({ method: 'GET', path: '/api/auth/me', cookies, secret: SECRET });
    const verdict = backend.isBffBridgeRequest(
      {
        headers: { ...signed, cookie: cookies },
        socket: { remoteAddress: '203.0.113.9' },
        method: 'GET',
        url: '/api/auth/me',
      },
      { cookies },
    );
    assert.equal(verdict.ok, true, 'امضای معتبر باید از راه دور هم پذیرفته شود');
  } finally {
    if (prev === undefined) delete process.env.CE_BFF_SHARED_SECRET;
    else process.env.CE_BFF_SHARED_SECRET = prev;
  }
});

test('BFF: امضا به مسیر، متد و کوکی گره خورده است (قابل جابه‌جایی نیست)', async () => {
  // ⚠️ زمان باید «اکنون» باشد، وگرنه stale_timestamp می‌خورد
  const headers = await frontSign({
    method: 'POST',
    path: '/api/auth/login',
    cookies: 'ce_refresh=victim',
    secret: SECRET,
  });

  const prev = process.env.CE_BFF_SHARED_SECRET;
  process.env.CE_BFF_SHARED_SECRET = SECRET;
  try {
    const probe = (over) =>
      backend.isBffBridgeRequest(
        {
          headers: { ...headers, cookie: over.cookies },
          socket: { remoteAddress: '203.0.113.9' },
          method: over.method,
          url: over.path,
        },
        { cookies: over.cookies },
      ).ok;

    assert.equal(probe({ method: 'POST', path: '/api/auth/login', cookies: 'ce_refresh=victim' }), true, 'پایه سالم است');
    assert.equal(probe({ method: 'POST', path: '/api/auth/logout', cookies: 'ce_refresh=victim' }), false, 'تغییر مسیر');
    assert.equal(probe({ method: 'GET', path: '/api/auth/login', cookies: 'ce_refresh=victim' }), false, 'تغییر متد');
    assert.equal(probe({ method: 'POST', path: '/api/auth/login', cookies: 'ce_refresh=attacker' }), false, 'تغییر کوکی');
  } finally {
    if (prev === undefined) delete process.env.CE_BFF_SHARED_SECRET;
    else process.env.CE_BFF_SHARED_SECRET = prev;
  }
});

test('BFF: امضای قدیمی (بیش از skew) رد می‌شود', async () => {
  const prev = process.env.CE_BFF_SHARED_SECRET;
  process.env.CE_BFF_SHARED_SECRET = SECRET;
  try {
    const stale = await frontSign({ method: 'GET', path: '/x', cookies: '', secret: SECRET, now: NOW });
    const verdict = backend.isBffBridgeRequest(
      { headers: stale, socket: { remoteAddress: '203.0.113.9' }, method: 'GET', url: '/x' },
      { cookies: '' },
    );
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'stale_timestamp');
  } finally {
    if (prev === undefined) delete process.env.CE_BFF_SHARED_SECRET;
    else process.env.CE_BFF_SHARED_SECRET = prev;
  }
});

test('BFF: بدون کلید، هدر امضاشده ساخته نمی‌شود (حالت سازگاری)', async () => {
  assert.deepEqual(await frontSign({ method: 'GET', path: '/x', cookies: '', secret: '' }), {});
  assert.deepEqual(await frontSign({ method: 'GET', path: '/x', cookies: '', secret: 'short' }), {});
});

test('BFF: بدون کلید فقط loopback مجاز است؛ شبکهٔ خصوصی هم کلید می‌خواهد', () => {
  const prev = process.env.CE_BFF_SHARED_SECRET;
  delete process.env.CE_BFF_SHARED_SECRET;
  const build = (ip) => ({
    headers: { 'x-ce-bff': '1', cookie: 'a=b' },
    socket: { remoteAddress: ip },
    method: 'POST',
    url: '/api/auth/login',
  });
  try {
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      assert.equal(backend.isBffBridgeRequest(build(ip)).ok, true, `${ip} loopback باید پذیرفته شود`);
    }
    for (const ip of [
      '10.0.0.5', '192.168.1.10', '172.16.5.4', '100.64.3.3',
      '169.254.1.1', 'fc00::1', 'fe80::1', '203.0.113.9', '8.8.8.8',
    ]) {
      const denied = backend.isBffBridgeRequest(build(ip));
      assert.equal(denied.ok, false, `${ip} نباید بدون امضا کوکی بگیرد`);
      assert.equal(denied.statusCode, 403);
      assert.equal(denied.reason, 'unsigned_non_loopback_bridge');
    }
  } finally {
    if (prev === undefined) delete process.env.CE_BFF_SHARED_SECRET;
    else process.env.CE_BFF_SHARED_SECRET = prev;
  }
});

test('BFF: تنظیم کلید هیچ fallback خامی حتی روی loopback مجاز نمی‌کند', () => {
  const prev = process.env.CE_BFF_SHARED_SECRET;
  process.env.CE_BFF_SHARED_SECRET = SECRET;
  const raw = {
    headers: { 'x-ce-bff': '1', cookie: 'ce_refresh=secret-token' },
    socket: { remoteAddress: '127.0.0.1' },
    method: 'POST',
    url: '/api/auth/login',
  };
  try {
    const denied = backend.isBffBridgeRequest(raw, { cookies: 'ce_refresh=secret-token' });
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'missing_signature');
  } finally {
    if (prev === undefined) delete process.env.CE_BFF_SHARED_SECRET;
    else process.env.CE_BFF_SHARED_SECRET = prev;
  }
});

test('BFF: nonce تکراری (replay) رد می‌شود', async () => {
  const prev = process.env.CE_BFF_SHARED_SECRET;
  process.env.CE_BFF_SHARED_SECRET = SECRET;
  try {
    const now = Date.now();
    const cookies = 'ce_refresh=abc';
    const headers = await frontSign({
      method: 'POST',
      path: '/api/auth/refresh',
      cookies,
      secret: SECRET,
      nonce: `replay-${now}-${Math.random()}`,
      now,
    });
    const req = {
      headers: { ...headers, cookie: cookies },
      socket: { remoteAddress: '203.0.113.9' },
      method: 'POST',
      url: '/api/auth/refresh',
    };
    assert.equal(backend.isBffBridgeRequest(req, { cookies }).ok, true, 'بار اول پذیرفته می‌شود');
    const second = backend.isBffBridgeRequest(req, { cookies });
    assert.equal(second.ok, false, 'بار دوم باید رد شود');
    assert.equal(second.reason, 'replayed_nonce');
  } finally {
    if (prev === undefined) delete process.env.CE_BFF_SHARED_SECRET;
    else process.env.CE_BFF_SHARED_SECRET = prev;
  }
});
