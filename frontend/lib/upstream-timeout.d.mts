export declare const DEFAULT_HEADERS_TIMEOUT_MS: number;
export declare const DEFAULT_SESSION_TIMEOUT_MS: number;
export declare function fetchWithHeadersTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init?: RequestInit,
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<Response>;
export declare function startIdleWatchdog(onStall: () => void, idleMs?: number): { touch: () => void; stop: () => void };
export declare function isTimeoutError(error: unknown): boolean;
