import { attemptSchema, JourneyError, quoteSchema, sessionSchema, type JourneyApi } from './model';

/** Fixed same-origin paths, HttpOnly capability cookie, no client credential storage. */
export function createJourneyApi(fetcher: typeof fetch = fetch): JourneyApi {
  async function request(path: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetcher(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
        cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal,
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
      const reader = response.body?.getReader();
      if (!reader) throw new JourneyError('SERVICE_UNAVAILABLE');
      const decoder = new TextDecoder(); let text = ''; let size = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength;
          if (size > 65_536) throw new JourneyError('SERVICE_UNAVAILABLE');
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      const value: unknown = JSON.parse(text);
      if (!response.ok) {
        const code = value && typeof value === 'object' && 'error' in value && value.error && typeof value.error === 'object' && 'code' in value.error ? value.error.code : '';
        throw new JourneyError(typeof code === 'string' && /^[A-Z_]{1,50}$/.test(code) ? code : 'SERVICE_UNAVAILABLE');
      }
      return value;
    } catch (error) {
      if (error instanceof JourneyError) throw error;
      throw new JourneyError('SERVICE_UNAVAILABLE');
    } finally { clearTimeout(timer); }
  }
  function attempt(value: unknown) {
    const parsed = attemptSchema.safeParse(value && typeof value === 'object' && 'attempt' in value ? value.attempt : null);
    if (!parsed.success) throw new JourneyError('SERVICE_UNAVAILABLE');
    return parsed.data;
  }
  return {
    async session() { const result = sessionSchema.safeParse(await request('/api/session')); if (!result.success) throw new JourneyError('SERVICE_UNAVAILABLE'); return result.data; },
    async exchange(token) { await request('/api/invites/exchange', { token }); },
    async quote(name, wallet) { const result = quoteSchema.safeParse(await request('/api/quotes', { name, wallet })); if (!result.success) throw new JourneyError('SERVICE_UNAVAILABLE'); return result.data; },
    async reserve(quoteId, idempotencyKey) { return attempt(await request('/api/attempts', { quoteId, idempotencyKey })); },
    async attempt(id) { return attempt(await request(`/api/attempts/${encodeURIComponent(id)}`)); },
    async submit(id, userSignedTransactionBase64) { await request(`/api/attempts/${encodeURIComponent(id)}/submit`, { userSignedTransactionBase64 }); },
    async retry(id) { await request(`/api/attempts/${encodeURIComponent(id)}/retry`, {}); },
  };
}
