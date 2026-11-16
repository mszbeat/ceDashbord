import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'ورود به سامانه | داشبورد نَما',
  description: 'احراز هویت و مدیریت نشست کاربران داشبورد کنترل کیفیت اعتبارسنجی',
};

export default function LoginLayout({ children }: { children: ReactNode }) {
  return children;
}
