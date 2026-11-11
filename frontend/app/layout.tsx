import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'داشبورد کنترل کیفیت اعتبارسنجی | نسخه سروری',
  description: 'گزارشهای اعتبارسنجی بانکها از دیتابیس جانبی، بدون نگهداری داده خام',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fa" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
