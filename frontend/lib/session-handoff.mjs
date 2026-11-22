/**
 * F2 — تحویل نشستِ تأییدشده از middleware به صفحه.
 *
 * مشکل: برای هر بازدید از `/admin` دو فراخوانی `/api/auth/me` می‌شد:
 *   ۱) middleware برای محافظت مسیر،
 *   ۲) صفحهٔ سروری `app/admin/page.tsx` برای گرفتن نقش‌ها.
 * نتیجه: دو رفت‌وبرگشت به بک‌اند پیش از رندر شدن اولین بایت صفحه.
 *
 * راه‌حل: middleware نشست تأییدشده را در یک هدر **امضاشده** (HMAC) روی درخواست داخلی
 * می‌گذارد و صفحه آن را می‌خواند. امضا لازم است چون هدر درخواست می‌تواند از بیرون伪造
 * شود؛ بدون امضا، هر کسی می‌توانست نقش admin جعل کند.
 *
 * اگر کلید تنظیم نشده باشد (`CE_SESSION_HANDOFF_SECRET`)، امضا ساخته نمی‌شود و صفحه
 * به رفتار قبلی (probe مستقیم) برمی‌گردد — بدون توقف سرویس.
 */

const HEADER = 'x-ce-session';
const TTL_MS = 60_000;

const encoder = new TextEncoder();

const toBase64Url = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromBase64Url = (text) => {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

async function keyFrom(secret) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** ساخت مقدار هدر: `payload.signature` */
export async function signSession(session, secret, now = Date.now()) {
  if (!secret) return null;
  const payload = JSON.stringify({
    ...session,
    exp: now + TTL_MS,
  });
  const key = await keyFrom(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return `${toBase64Url(encoder.encode(payload))}.${toBase64Url(new Uint8Array(signature))}`;
}

/** خواندن و اعتبارسنجی؛ در هر خطایی `null` (به‌جای استثنا، تا صفحه به مسیر پیش‌فرض برود) */
export async function readSession(headerValue, secret, now = Date.now()) {
  if (!headerValue || !secret || typeof headerValue !== 'string') return null;
  const parts = headerValue.split('.');
  if (parts.length !== 2) return null;
  let payloadText;
  try {
    payloadText = new TextDecoder().decode(fromBase64Url(parts[0]));
  } catch {
    return null;
  }
  const key = await keyFrom(secret);
  let valid = false;
  try {
    valid = await crypto.subtle.verify('HMAC', key, fromBase64Url(parts[1]), encoder.encode(payloadText));
  } catch {
    return null;
  }
  if (!valid) return null;
  let session;
  try {
    session = JSON.parse(payloadText);
  } catch {
    return null;
  }
  if (!session?.exp || session.exp < now) return null;
  if (session.authenticated !== true) return null;
  const { exp, ...rest } = session;
  return rest;
}

export const SESSION_HEADER = HEADER;
