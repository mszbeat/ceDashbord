/** @type {import('next').NextConfig} */
const backendUrl = process.env.BACKEND_URL || 'http://127.0.0.1:3000';

const nextConfig = {
  reactStrictMode: true,
  /**
   * F10 — سخت‌گیری امنیتی روی نگه‌داری نسخهٔ ۱۴٫۲ با پچِ آخر (14.2.35).
   *
   * `npm audit` برای Next 14.x چند مورد DoS/Smuggling گزارش می‌کند که در ۱۵/۱۶ رفع شده‌اند.
   * مهاجرت به Next 16 تغییر ناسازگار است و در این فاز مجاز نیست؛ پس سطح تماس را می‌بندیم:
   *  * `images` عمداً تعریف نشده و هیچ‌جا از `next/image` استفاده نمی‌شود ⇒
   *    بهینه‌ساز تصویر (که مسیر DoS با `remotePatterns` بود) عملاً در دسترس نیست.
   *  * `rewrites` فقط مقصد داخلی ثابت دارد (الگوی ثابت، بدون مقدار کاربر).
   * تصمیم نهایی مهاجرت به Next 15/16 در گزارش به‌عنوان «ریسک باز» ثبت شده است.
   */
  poweredByHeader: false,
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${backendUrl}/api/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
