import { isIP } from 'node:net';
import { assertToken, SecurityError } from './tokens';

export const SESSION_COOKIE_NAME = 'first_bite_session';
export const MAX_JSON_BODY_BYTES = 4_096;
export const MAX_JSON_BODY_READ_MS = 5_000;

async function readBeforeDeadline(reader: ReadableStreamDefaultReader<Uint8Array>, deadline: number) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new SecurityError('body_timeout');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SecurityError('body_timeout')), remaining); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

function checkedOrigin(origin: string): URL {
  try {
    const url = new URL(origin);
    if (url.origin !== origin || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error();
    return url;
  } catch { throw new SecurityError('origin_invalid'); }
}

export function assertSameOriginMutation(request: Request, origin: string): void {
  checkedOrigin(origin);
  const site = request.headers.get('sec-fetch-site');
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) || request.headers.get('origin') !== origin
    || (site !== null && site !== 'same-origin' && site !== 'none')) throw new SecurityError('request_forbidden');
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(request.headers.get('content-type') ?? '')) {
    throw new SecurityError('content_type_invalid');
  }
}

/** Count actual streamed bytes, including when Content-Length is absent or false. */
export async function readJsonBody(request: Request): Promise<unknown> {
  const length = request.headers.get('content-length');
  if (length !== null) {
    if (!/^\d{1,10}$/.test(length)) throw new SecurityError('body_invalid');
    if (Number(length) > MAX_JSON_BODY_BYTES) throw new SecurityError('body_too_large');
  }
  if (!request.body || request.bodyUsed) throw new SecurityError('body_invalid');
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const chunks: Buffer[] = [];
  let bytes: Buffer | undefined;
  let size = 0;
  const deadline = Date.now() + MAX_JSON_BODY_READ_MS;
  try {
    reader = request.body.getReader();
    for (;;) {
      const chunk = await readBeforeDeadline(reader, deadline);
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) throw new SecurityError('body_invalid');
      size += chunk.value.byteLength;
      if (size > MAX_JSON_BODY_BYTES) throw new SecurityError('body_too_large');
      if (chunk.value.byteLength > 0) chunks.push(Buffer.from(chunk.value));
    }
    bytes = Buffer.concat(chunks, size);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch (error) {
    // A broken or malicious stream must not delay the safe error response.
    if (reader) void reader.cancel().catch(() => undefined);
    if (error instanceof SecurityError) throw error;
    throw new SecurityError('body_invalid');
  } finally {
    reader?.releaseLock();
    for (const chunk of chunks) chunk.fill(0);
    bytes?.fill(0);
  }
}

export function sessionCookie(token: string, expiresAt: Date, origin: string): string {
  assertToken(token);
  const url = checkedOrigin(origin);
  if (!(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime())) throw new SecurityError('cookie_invalid');
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; Expires=${expiresAt.toUTCString()}; HttpOnly; SameSite=Strict${url.protocol === 'https:' ? '; Secure' : ''}`;
}

/** Duplicate capability cookies are ambiguous and therefore never authenticated. */
export function parseSessionCookie(request: Request): string | null {
  const cookie = request.headers.get('cookie');
  if (cookie === null || cookie.length > 8_192) return null;
  const candidates = cookie.split(';').map((part) => part.trim()).filter((part) => part.split('=', 1)[0]?.trim() === SESSION_COOKIE_NAME);
  if (candidates.length !== 1) return null;
  const candidate = candidates[0]!;
  const separator = candidate.indexOf('=');
  if (separator < 0) return null;
  const token = candidate.slice(separator + 1);
  try { assertToken(token); return token; }
  catch { return null; }
}

/** Configure this only when an ingress overwrites the selected header. */
export function trustedClientIp(request: Request, header: 'none' | 'x-real-ip' | 'cf-connecting-ip'): string {
  if (header === 'none') return 'local';
  if (header !== 'x-real-ip' && header !== 'cf-connecting-ip') throw new SecurityError('client_ip_invalid');
  const value = request.headers.get(header);
  if (value === null || value.includes('%')) throw new SecurityError('client_ip_invalid');
  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6) throw new SecurityError('client_ip_invalid');
  const canonical = new URL(`http://[${value}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(canonical);
  if (mapped) {
    const high = Number.parseInt(mapped[1]!, 16);
    const low = Number.parseInt(mapped[2]!, 16);
    return [high >>> 8, high & 255, low >>> 8, low & 255].join('.');
  }
  return canonical;
}
