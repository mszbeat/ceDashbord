export async function api<T = any>(path: string): Promise<T> {
  const response = await fetch(`/api${path}`, { cache: 'no-store' });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`خطا در ارتباط با بکاند (${response.status}): ${text.slice(0, 200)}`);
  }
  return response.json();
}

export function qs(params: Record<string, string | number | undefined | null>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}
