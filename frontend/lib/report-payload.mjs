/**
 * تشخیص و بازکردن «پوشش JSON» پاسخ گزارش (رفع باگ «استایل‌ها لود نشدند»).
 *
 * 🐞 چه اتفاقی می‌افتاد:
 *   ترنسپورت partFramework یک رشتهٔ ساده را در `{ "data": "<html>" }` می‌پیچد.
 *   پروکسی گزارش (`app/route.ts`) برای بارگذاری، فقط وقتی `Content-Type` شامل
 *   `application/json` بود بدنه را باز می‌کرد. اگر هدر HTML باقی می‌ماند
 *   (`sendHtml` هدر را روی پاسخ اعمال نمی‌کرد)، بدنهٔ JSON با نوع `text/html`
 *   به مرورگر می‌رفت و مرورگر آن را «به‌عنوان HTML» تجزیه می‌کرد:
 *
 *     {"data":"<!doctype html>…<div class=\"page\">…"}
 *
 *   در HTML، `\"` یک بک‌اسلشِ متنی + پایانِ مقدار صفت است، پس نام کلاس‌ها
 *   `\"page\"` می‌شد (با کوتیشن‌های داخل نام) و هیچ سلکتور CSS جواب نمی‌داد؛
 *   بلوک `<style>` هم به همین دلیل عملاً بی‌اثر بود و صفحه بدون استایل (اما با
 *   متن فارسی و اسکریپت‌ها) دیده می‌شد — همان اسکرین‌شات کاربر.
 *
 * ✅ راه‌حل: به هدر اعتماد نکنیم؛ به **محتوا** نگاه کنیم. اگر بدنه با `{` یا `[`
 *   شروع شد، پوشش را باز می‌کنیم و HTML درونی را برمی‌گردانیم.
 */

const HTML_START = /^<(!doctype\s+html|html|head|style|body)\b/i;

/** آیا این رشته یک سند HTML است؟ */
export function isHtmlDocument(value) {
  return typeof value === 'string' && HTML_START.test(value.replace(/^\uFEFF/, '').trimStart());
}

/**
 * HTML را از داخل پوشش(های) JSON بیرون می‌کشد.
 * پوشش‌های رایج: `{data}`, `{result}`, `{body}`, `{html}`, `{payload}`, آرایهٔ `[{data}]`
 * و ترکیب تودرتوی آن‌ها (تا ۴ سطح).
 * @returns {string|null} HTML یا null اگر پوشش قابل بازکردن نبود
 */
export function extractHtmlDocument(rawBody, depth = 0) {
  if (depth > 4 || typeof rawBody !== 'string') return null;
  const trimmed = rawBody.replace(/^\uFEFF/, '').trimStart();
  if (isHtmlDocument(trimmed)) return rawBody;

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null; // JSON نامعتبر
    }
    return digForHtml(parsed, depth);
  }
  return null;
}

function digForHtml(value, depth) {
  if (depth > 4) return null;
  if (typeof value === 'string') return extractHtmlDocument(value, depth + 1);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = digForHtml(item, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    // کلیدهایت شناخته‌شده اول، بعد بقیهٔ کلیدها (پوشش ممکن است نامش فرق کند)
    const preferred = ['data', 'result', 'body', 'html', 'payload', 'content'];
    const keys = [...preferred.filter((k) => k in value), ...Object.keys(value).filter((k) => !preferred.includes(k))];
    for (const key of keys) {
      const found = digForHtml(value[key], depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * آیا بدنه «شبیه پوشش JSON» است؟ (نگاه به اولین بایت‌های معنی‌دار، نه به هدر)
 * BOM و فاصله/خط جدید ابتدای بدنه نادیده گرفته می‌شود.
 */
export function looksLikeJsonEnvelope(head) {
  if (typeof head !== 'string') return false;
  const trimmed = head.replace(/^\uFEFF/, '').trimStart();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

/**
 * تمام بایت‌های یک استریم را می‌خواند (به‌همراه بایت‌های پیش‌خوانده‌شده).
 * ⚠️ چرا از خودِ استریم بازسازی‌شده می‌خوانیم و نه `response.text()`؟
 *   چون `peekStream` بدنه را مصرف می‌کند و پاسخ دیگر قابل خواندن نیست
 *   («Body is unusable: Body has already been read»). این خطا در تست سرتاسری
 *   با بک‌اندی که پوشش JSON می‌فرستاد کشف شد.
 */
export async function readText(stream) {
  // نکته: استریمِ برگشتی `peekStream` بایت‌های پیش‌خوانده‌شده را هم دوباره می‌فرستد،
  // پس اینجا نباید پیشوند را جداگانه اضافه کرد (وگرنه بدنه دو بار تکرار می‌شود).
  const chunks = [];
  if (stream && typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.byteLength) chunks.push(value);
    }
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder('utf-8').decode(all), bytes: all };
}

/**
 * اولین چند بایت بدنه را می‌خواند و استریم را «دست‌نخورده» برمی‌گرداند.
 * چرا؟ تا قواعد F1 نقض نشود: HTML سالمِ چند مگابایتی نباید کامل در حافظه بافر شود.
 * @returns {Promise<{head: string, headBytes: Uint8Array, stream: ReadableStream<Uint8Array>|null}>}
 */
export async function peekStream(body, limit = 64) {
  if (!body || typeof body.getReader !== 'function') {
    return { head: '', headBytes: new Uint8Array(0), stream: body ?? null };
  }

  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < limit) {
      // eslint-disable-next-line no-await-in-loop
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      chunks.push(value);
      size += value.byteLength;
    }
  } catch {
    // خواندن ناموفق: بدنهٔ خالی برگردان تا مسیر خطای بالادست فعال شود
  }

  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const head = new TextDecoder('utf-8').decode(all.subarray(0, limit));

  // استریم بازسازی‌شده: ابتدا بایت‌های خوانده‌شده، سپس ادامهٔ بدنه بدون بافر
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
    },
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) controller.close();
        else if (value) controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  return { head, headBytes: all, stream };
}
