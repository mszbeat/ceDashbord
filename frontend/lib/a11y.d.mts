/** F9 — نوع‌های ماژول دسترس‌پذیری (پیاده‌سازی در `a11y.mjs` است تا در تست Node اجرا شود) */
export declare function safeText(value: unknown): string;
export declare function looksLikeHtml(value: unknown): boolean;
export declare function toastA11y(kind?: string | null): {
  role: 'status' | 'alert';
  'aria-live': 'polite' | 'assertive';
  'aria-atomic': boolean;
};
export declare function pagerA11y(page: number, totalPages: number): {
  'aria-label': string;
  role: 'navigation';
};
