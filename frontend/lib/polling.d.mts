/** F5/F7 — نوع‌های ماژول نظرسنجی (پیاده‌سازی در `polling.mjs` است تا در تست Node اجرا شود) */
export interface BackoffOptions { baseMs: number; maxMs: number; factor: number }
export declare function nextDelay(failures: number, options?: BackoffOptions): number;
export interface PollerTaskContext { signal: AbortSignal }
export interface PollerOptions {
  task: (ctx: PollerTaskContext) => unknown | Promise<unknown>;
  intervalMs?: number;
  backoff?: BackoffOptions;
  documentRef?: { visibilityState: string; addEventListener?: Function; removeEventListener?: Function } | null;
  onError?: (error: unknown, failures: number) => void;
  immediate?: boolean;
}
export interface Poller {
  start(): void;
  stop(): void;
  runNow(): Promise<void>;
  readonly failures: number;
  readonly active: boolean;
}
export declare function createPoller(options: PollerOptions): Poller;
