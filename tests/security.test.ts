import { randomBytes, randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { equalTokenHashes, generateToken, hashToken, SecurityError } from '../src/lib/security/tokens';
import { openAttemptKey, sealAttemptKey } from '../src/lib/security/attempt-key';
import {
  assertSameOriginMutation, MAX_JSON_BODY_BYTES, MAX_JSON_BODY_READ_MS, parseSessionCookie, readJsonBody,
  SESSION_COOKIE_NAME, sessionCookie, trustedClientIp,
} from '../src/lib/security/http';

const origin = 'https://first-bite.example';
const token = Buffer.alloc(32, 7).toString('base64url');

function request(headers: HeadersInit = {}, body = '{}'): Request {
  return new Request(`${origin}/api/invites/exchange`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body,
  });
}

function streamedRequest(chunks: Uint8Array[], headers: HeadersInit = {}): Request {
  return new Request(`${origin}/api/invites/exchange`, {
    method: 'POST', headers, duplex: 'half',
    body: new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }),
  } as RequestInit);
}

describe('opaque capabilities', () => {
  it('generates distinct canonical 256-bit tokens', () => {
    const tokens = Array.from({ length: 256 }, generateToken);
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const value of tokens) {
      expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(value, 'base64url')).toHaveLength(32);
      expect(Buffer.from(value, 'base64url').toString('base64url')).toBe(value);
    }
  });

  it('hashes deterministically and separates invite and session capabilities', () => {
    const invitation = hashToken(token, 'invite');
    const session = hashToken(token, 'session');
    expect(invitation).toMatch(/^[a-f0-9]{64}$/);
    expect(hashToken(token, 'invite')).toBe(invitation);
    expect(session).not.toBe(invitation);
    expect(hashToken(generateToken(), 'invite')).not.toBe(invitation);
    expect(equalTokenHashes(invitation, invitation)).toBe(true);
    expect(equalTokenHashes(invitation, session)).toBe(false);
    expect(equalTokenHashes(invitation, 'bad')).toBe(false);
    expect(equalTokenHashes('A'.repeat(64), 'A'.repeat(64))).toBe(false);
  });

  it.each(['', 'secret', token + '=', token.slice(1), ' '.repeat(43), '/'.repeat(43), 'A'.repeat(42) + 'B'])('rejects noncanonical token %j without including it in errors', (value) => {
    expect(() => hashToken(value, 'invite')).toThrow(new SecurityError('token_invalid'));
  });
});

describe('encrypted attempt payer', () => {
  const payer = Keypair.generate();
  const secret = payer.secretKey;
  const publicKey = payer.publicKey.toBase58();
  const wrappingKey = randomBytes(32).toString('base64');
  const preparationId = randomUUID();

  it('round trips a validated Solana secret and generates a fresh authenticated nonce', () => {
    const snapshot = new Uint8Array(secret);
    const first = sealAttemptKey(secret, wrappingKey, preparationId, publicKey);
    const second = sealAttemptKey(secret, wrappingKey, preparationId, publicKey);
    expect(first).toMatch(/^fbak1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{86}\.[A-Za-z0-9_-]{22}$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain(Buffer.from(secret).toString('base64url'));
    const opened = openAttemptKey(first, wrappingKey, preparationId, publicKey);
    expect(opened).toEqual(secret);
    expect(Keypair.fromSecretKey(opened).publicKey.toBase58()).toBe(publicKey);
    opened.fill(0);
    expect(secret).toEqual(snapshot);
    expect(openAttemptKey(first, wrappingKey, preparationId, publicKey)).toEqual(secret);
  });

  it('binds both preparation ID and payer identity as authenticated context', () => {
    const envelope = sealAttemptKey(secret, wrappingKey, preparationId, publicKey);
    expect(() => openAttemptKey(envelope, wrappingKey, randomUUID(), publicKey)).toThrow(new SecurityError('attempt_key_invalid'));
    expect(() => openAttemptKey(envelope, wrappingKey, preparationId, Keypair.generate().publicKey.toBase58())).toThrow(new SecurityError('attempt_key_invalid'));
    expect(() => openAttemptKey(envelope, randomBytes(32).toString('base64'), preparationId, publicKey)).toThrow(new SecurityError('attempt_key_invalid'));
  });

  it.each([1, 2, 3])('rejects modifications to encrypted envelope component %i', (index) => {
    const parts = sealAttemptKey(secret, wrappingKey, preparationId, publicKey).split('.');
    const changed = Buffer.from(parts[index]!, 'base64url');
    changed[0] = changed[0]! ^ 1;
    parts[index] = changed.toString('base64url');
    expect(() => openAttemptKey(parts.join('.'), wrappingKey, preparationId, publicKey)).toThrow(new SecurityError('attempt_key_invalid'));
  });

  it.each(['', 'secret', 'v2.a.b.c', 'fbak1.' + 'A'.repeat(10_000)])('rejects unknown or malformed envelopes', (value) => {
    expect(() => openAttemptKey(value, wrappingKey, preparationId, publicKey)).toThrow(new SecurityError('attempt_key_invalid'));
  });

  it.each(['', randomBytes(31).toString('base64'), randomBytes(33).toString('base64'), 'A'.repeat(42) + 'B=', wrappingKey.slice(0, -1), wrappingKey + '\n'])('rejects noncanonical wrapping keys', (key) => {
    expect(() => sealAttemptKey(secret, key, preparationId, publicKey)).toThrow(new SecurityError('attempt_key_invalid'));
  });

  it('rejects mismatched, corrupted, and wrong-size secrets without mutating input', () => {
    const corrupt = new Uint8Array(secret);
    corrupt[0] = corrupt[0]! ^ 1;
    for (const candidate of [corrupt, secret.slice(0, 32), new Uint8Array(64)]) {
      const snapshot = new Uint8Array(candidate);
      expect(() => sealAttemptKey(candidate, wrappingKey, preparationId, publicKey)).toThrow(new SecurityError('attempt_key_invalid'));
      expect(candidate).toEqual(snapshot);
    }
    expect(() => sealAttemptKey(secret, wrappingKey, preparationId, Keypair.generate().publicKey.toBase58())).toThrow(new SecurityError('attempt_key_invalid'));
    expect(() => sealAttemptKey(secret, wrappingKey, 'secret-preparation-id', publicKey)).toThrow(new SecurityError('attempt_key_invalid'));
  });
});

describe('same-origin mutation boundary', () => {
  it('accepts exact same-origin JSON mutation requests', () => {
    expect(() => assertSameOriginMutation(request({ 'sec-fetch-site': 'same-origin' }), origin)).not.toThrow();
    expect(() => assertSameOriginMutation(request({ 'content-type': 'application/json; charset=utf-8' }), origin)).not.toThrow();
  });

  it.each(['https://evil.example', 'null', 'https://first-bite.example/', 'https://first-bite.example:443', 'https://first-bite.example.evil.example'])('rejects a different or noncanonical Origin: %s', (value) => {
    expect(() => assertSameOriginMutation(request({ origin: value }), origin)).toThrow(new SecurityError('request_forbidden'));
  });

  it('rejects absent Origin and read methods', () => {
    const missing = request();
    missing.headers.delete('origin');
    expect(() => assertSameOriginMutation(missing, origin)).toThrow(new SecurityError('request_forbidden'));
    expect(() => assertSameOriginMutation(new Request(origin, { headers: { origin, 'content-type': 'application/json' } }), origin)).toThrow(new SecurityError('request_forbidden'));
  });

  it.each(['cross-site', 'same-site', 'same-origin, cross-site', 'unexpected'])('rejects hostile fetch metadata %s', (site) => {
    expect(() => assertSameOriginMutation(request({ 'sec-fetch-site': site }), origin)).toThrow(new SecurityError('request_forbidden'));
  });

  it.each(['text/plain', 'application/x-www-form-urlencoded', 'application/jsonp', 'application/json; charset=utf-16', ''])('rejects non-JSON or unsupported content types %j', (type) => {
    expect(() => assertSameOriginMutation(request({ 'content-type': type }), origin)).toThrow(new SecurityError('content_type_invalid'));
  });

  it.each(['https://user:secret@first-bite.example', origin + '/', origin + '/path', origin + '?x=secret', origin + '#secret', 'http://first-bite.example'])('rejects an unsafe configured origin', (value) => {
    expect(() => assertSameOriginMutation(request(), value)).toThrow(new SecurityError('origin_invalid'));
  });
});

describe('bounded JSON body', () => {
  it.each([false, true])('cancels stalled bodies under one total read deadline (partial=%s)', async (partial) => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel });
      const source = new Request(origin, { method: 'POST', body, duplex: 'half' } as RequestInit);
      const result = expect(readJsonBody(source)).rejects.toThrow(new SecurityError('body_timeout'));
      await vi.advanceTimersByTimeAsync(MAX_JSON_BODY_READ_MS - 1_000);
      if (partial) controller!.enqueue(Buffer.from('{"value":'));
      await vi.advanceTimersByTimeAsync(1_000);
      await result;
      expect(cancel).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('accepts streaming JSON up to exactly 4 KiB, counting bytes across chunks', async () => {
    const body = Buffer.from(JSON.stringify({ value: 'x'.repeat(MAX_JSON_BODY_BYTES - 12) }));
    expect(body).toHaveLength(MAX_JSON_BODY_BYTES);
    const result = await readJsonBody(streamedRequest([body.subarray(0, 17), body.subarray(17)]));
    expect(result).toEqual({ value: 'x'.repeat(MAX_JSON_BODY_BYTES - 12) });
  });

  it('rejects large advertised bodies before reading them', async () => {
    await expect(readJsonBody(request({ 'content-length': '4097' }))).rejects.toThrow(new SecurityError('body_too_large'));
    await expect(readJsonBody(request({ 'content-length': 'not-a-size' }))).rejects.toThrow(new SecurityError('body_invalid'));
  });

  it('does not trust a small Content-Length or omit limits on multibyte input', async () => {
    await expect(readJsonBody(streamedRequest([Buffer.from('x'.repeat(4097))], { 'content-length': '2' }))).rejects.toThrow(new SecurityError('body_too_large'));
    await expect(readJsonBody(request({}, JSON.stringify({ value: '🍪'.repeat(1100) })))).rejects.toThrow(new SecurityError('body_too_large'));
  });

  it('cancels an oversized stream and discards unsafe stream errors', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ start(controller) { controller.enqueue(Buffer.alloc(4097)); }, cancel });
    const source = new Request(origin, { method: 'POST', body, duplex: 'half' } as RequestInit);
    await expect(readJsonBody(source)).rejects.toThrow(new SecurityError('body_too_large'));
    expect(cancel).toHaveBeenCalledOnce();
    const broken = new ReadableStream({ start(controller) { controller.error(new Error('sensitive input')); } });
    await expect(readJsonBody(new Request(origin, { method: 'POST', body: broken, duplex: 'half' } as RequestInit))).rejects.toThrow(new SecurityError('body_invalid'));
  });

  it('rejects malformed JSON, malformed UTF-8, empty and already-used bodies', async () => {
    await expect(readJsonBody(request({}, '{secret'))).rejects.toThrow(new SecurityError('body_invalid'));
    await expect(readJsonBody(streamedRequest([Buffer.from([34, 0xc0, 0xaf, 34])]))).rejects.toThrow(new SecurityError('body_invalid'));
    await expect(readJsonBody(new Request(origin, { method: 'POST' }))).rejects.toThrow(new SecurityError('body_invalid'));
    const used = request();
    await used.text();
    await expect(readJsonBody(used)).rejects.toThrow(new SecurityError('body_invalid'));
  });
});

describe('capability cookies', () => {
  const expires = new Date('2030-01-01T00:00:00Z');

  it('uses a host-only secure cookie with HttpOnly and strict SameSite', () => {
    const value = sessionCookie(token, expires, origin);
    expect(value).toBe(`${SESSION_COOKIE_NAME}=${token}; Path=/; Expires=Tue, 01 Jan 2030 00:00:00 GMT; HttpOnly; SameSite=Strict; Secure`);
    expect(value).not.toContain('Domain=');
    expect(parseSessionCookie(request({ cookie: `unrelated=1; ${SESSION_COOKIE_NAME}=${token}` }))).toBe(token);
  });

  it('permits HTTP only for loopback development and rejects invalid expiration', () => {
    expect(sessionCookie(token, expires, 'http://127.0.0.1:3000')).not.toContain('; Secure');
    expect(() => sessionCookie(token, expires, 'http://first-bite.example')).toThrow(new SecurityError('origin_invalid'));
    expect(() => sessionCookie(token, new Date(NaN), origin)).toThrow(new SecurityError('cookie_invalid'));
  });

  it.each([
    `${SESSION_COOKIE_NAME}=${token}; ${SESSION_COOKIE_NAME}=${token}`,
    `${SESSION_COOKIE_NAME}=bad; ${SESSION_COOKIE_NAME}=${token}`,
    `${SESSION_COOKIE_NAME}=${token}; ${SESSION_COOKIE_NAME} =${token}`,
    `${SESSION_COOKIE_NAME}=bad`, `${SESSION_COOKIE_NAME}="${token}"`,
    SESSION_COOKIE_NAME, `unrelated=${token}`, `${SESSION_COOKIE_NAME}=${'a'.repeat(8192)}`,
  ])('rejects ambiguous or invalid cookies', (cookie) => {
    expect(parseSessionCookie(request({ cookie }))).toBeNull();
  });
});

describe('trusted ingress IP identity', () => {
  it('ignores all spoofable forwarding values when no trusted header is configured', () => {
    expect(trustedClientIp(request({ 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '5.6.7.8', 'cf-connecting-ip': '9.10.11.12' }), 'none')).toBe('local');
  });

  it('reads only the explicitly configured header and canonicalizes IPv6 and mapped IPv4', () => {
    const source = request({ 'x-real-ip': '192.0.2.1', 'x-forwarded-for': '1.2.3.4', 'cf-connecting-ip': '2001:0DB8:0:0:0:0:0:1' });
    expect(trustedClientIp(source, 'x-real-ip')).toBe('192.0.2.1');
    expect(trustedClientIp(source, 'cf-connecting-ip')).toBe('2001:db8::1');
    expect(trustedClientIp(request({ 'x-real-ip': '::ffff:192.0.2.1' }), 'x-real-ip')).toBe('192.0.2.1');
    expect(trustedClientIp(request({ 'x-real-ip': '::ffff:c000:0201' }), 'x-real-ip')).toBe('192.0.2.1');
  });

  it.each(['', 'unknown', '1.2.3.4, 5.6.7.8', '192.168.001.1', '[::1]', '::1%lo0', '1.2.3.4:443', 'for=1.2.3.4'])('rejects missing, ambiguous, or malformed trusted IPs', (ip) => {
    expect(() => trustedClientIp(request({ 'x-real-ip': ip }), 'x-real-ip')).toThrow(new SecurityError('client_ip_invalid'));
  });

  it('fails closed instead of falling back to X-Forwarded-For', () => {
    expect(() => trustedClientIp(request({ 'x-forwarded-for': '1.2.3.4' }), 'x-real-ip')).toThrow(new SecurityError('client_ip_invalid'));
  });
});
