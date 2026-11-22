// F4 — تست open redirect روی همان تابعی که در محصول استفاده می‌شود (lib/next-path.mjs)
import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeNextPath as sanitize } from '../lib/next-path.mjs';

const ORIGIN = 'https://dash.example.ir';

test('F4: مسیرهای امن حفظ می‌شوند', () => {
  assert.equal(sanitize('/', '/', ORIGIN), '/');
  assert.equal(sanitize('/admin?tab=1', '/', ORIGIN), '/admin?tab=1');
  assert.equal(sanitize('/?bank=tavan_mellat&from=1405-08-01', '/', ORIGIN),
    '/?bank=tavan_mellat&from=1405-08-01');
  assert.equal(sanitize('/admin#jobs', '/', ORIGIN), '/admin#jobs');
});

test('F4: دورهای open redirect رد می‌شوند', () => {
  const attacks = [
    '//evil.com',
    '//evil.com/path',
    'https://evil.com',
    'http://evil.com/x',
    '/%2f%2fevil.com',
    '/%2F%2Fevil.com',
    '/\\evil.com',
    '\\\\evil.com',
    '/\tevil',
    '/%09/evil.com',
    'javascript:alert(1)',
    ' JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    '///evil.com',
    '/login',
    '/login?next=/admin',
    'https://user:pass@evil.com/',
  ];
  for (const attack of attacks) {
    assert.equal(sanitize(attack, '/', ORIGIN), '/', `حمله رد نشد: ${JSON.stringify(attack)}`);
  }
});

test('F4: مقدار خالی/نامعتبر → fallback', () => {
  assert.equal(sanitize(null, '/', ORIGIN), '/');
  assert.equal(sanitize('', '/', ORIGIN), '/');
  assert.equal(sanitize(undefined, '/admin', ORIGIN), '/admin');
  assert.equal(sanitize('   ', '/admin', ORIGIN), '/admin');
});

test('F4: مقصد بازگشت هرگز هاست را عوض نمی‌کند (خاصیت کلی)', () => {
  const samples = ['/a', '//b', '///c', '/%2e%2e/d', '/..', '/./x', '/a?b=https://evil.com'];
  for (const sample of samples) {
    const out = sanitize(sample, '/', ORIGIN);
    const resolved = new URL(out, ORIGIN);
    assert.equal(resolved.origin, ORIGIN, `origin عوض شد برای ${sample}`);
  }
});
