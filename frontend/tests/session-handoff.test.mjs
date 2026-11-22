// F2 — هدر نشستِ امضاشده: فقط با کلید درست و بدون دست‌کاری پذیرفته می‌شود.
import assert from 'node:assert/strict';
import test from 'node:test';
import { signSession, readSession, SESSION_HEADER } from '../lib/session-handoff.mjs';

const SECRET = 'test-secret-32-bytes-long-abcdefgh';
const session = { authenticated: true, username: 'ali', roles: ['admin'], canRefresh: true };

test('F2: نشست امضاشده خوانده می‌شود', async () => {
  const header = await signSession(session, SECRET);
  const parsed = await readSession(header, SECRET);
  assert.equal(parsed.username, 'ali');
  assert.deepEqual(parsed.roles, ['admin']);
  assert.equal(parsed.exp, undefined, 'فیلد انقضا به بیرون نمی‌رود');
});

test('F2: بدون کلید هیچ امضایی ساخته نمی‌شود (بازگشت به رفتار قبلی)', async () => {
  assert.equal(await signSession(session, ''), null);
  assert.equal(await readSession('x.y', ''), null);
});

test('F2: جعل هدر بدون امضا یا با امضای غلط رد می‌شود', async () => {
  const forged = Buffer.from(JSON.stringify({ ...session, exp: Date.now() + 60000 })).toString('base64url');
  assert.equal(await readSession(`${forged}.AAAA`, SECRET), null);
  assert.equal(await readSession(forged, SECRET), null);
  assert.equal(await readSession(null, SECRET), null);
  // امضای یک نشست دیگر روی payload عوض‌شده جواب نمی‌دهد
  const real = await signSession({ authenticated: true, username: 'guest', roles: ['visitor'] }, SECRET);
  const [, signature] = real.split('.');
  assert.equal(await readSession(`${forged}.${signature}`, SECRET), null);
});

test('F2: کلید دیگر امضا را معتبر نمی‌داند', async () => {
  const header = await signSession(session, SECRET);
  assert.equal(await readSession(header, 'another-secret-32-bytes-long-zzzzzz'), null);
});

test('F2: نشست منقضی پذیرفته نمی‌شود', async () => {
  const old = Date.now() - 10 * 60_000;
  const header = await signSession(session, SECRET, old);
  assert.equal(await readSession(header, SECRET), null);
});

test('F2: نشستِ احراز نشده هرگز امضا نمی‌شود', async () => {
  const header = await signSession({ authenticated: false, roles: ['visitor'] }, SECRET);
  assert.equal(await readSession(header, SECRET), null);
});

test('F2: نام هدر ثابت است (middleware و صفحه یکی باشند)', () => {
  assert.equal(SESSION_HEADER, 'x-ce-session');
});
