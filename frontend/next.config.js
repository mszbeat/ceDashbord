/** @type {import('next').NextConfig} */
const path = require('node:path');
const backendUrl = process.env.BACKEND_URL || 'http://127.0.0.1:3000';

const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: path.join(__dirname),
  /**
   * سخت‌گیری‌های Next:
   *  * نسخهٔ نصب‌شده روی شاخهٔ 15.5 از پچ 15.5.29 است (آستانهٔ رفع موارد گزارش‌شده در audit).
   *  * `images` عمداً تعریف نشده و هیچ‌جا از `next/image` استفاده نمی‌شود؛ بهینه‌ساز تصویر
   *    و مسیرهای ورودی آن در این برنامه لازم نیست.
   *  * `rewrites` فقط مقصد داخلی ثابت دارد و هیچ مقدار کاربر در مقصد تزریق نمی‌شود.
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
