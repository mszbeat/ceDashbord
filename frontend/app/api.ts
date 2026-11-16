import { authFetch, extractPartErrorMessage, unwrapPartPayload } from '@/lib/auth-client';

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const response = await authFetch(`/api${path}`, {
    ...init,
    cache: 'no-store',
  });
  const text = await response.text().catch(() => '');
  let parsed: any = null;
  try {
    parsed = text ? unwrapPartPayload(JSON.parse(text)) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    throw new Error(extractPartErrorMessage(parsed, response.status));
  }
  return parsed as T;
}

export function qs(params: Record<string, string | number | undefined | null>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}
