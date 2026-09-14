import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { createContentSecurityPolicy } from '../src/lib/security/headers';
import { config, proxy } from '../src/proxy';
import nextConfig from '../next.config';

afterEach(() => vi.unstubAllEnvs());

function directive(policy: string, name: string): string {
  return policy.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name} `)) ?? '';
}

describe('browser content security policy', () => {
  it('uses fresh 192-bit cryptographic nonces with restrictive production sources', () => {
    const first = createContentSecurityPolicy();
    const second = createContentSecurityPolicy();
    expect(first.nonce).toMatch(/^[A-Za-z0-9+/]{32}$/);
    expect(Buffer.from(first.nonce, 'base64')).toHaveLength(24);
    expect(second.nonce).not.toBe(first.nonce);
    expect(directive(first.policy, 'script-src')).toBe(`script-src 'self' 'nonce-${first.nonce}' 'strict-dynamic'`);
    expect(directive(first.policy, 'style-src')).toBe(`style-src 'self' 'nonce-${first.nonce}'`);
    expect(first.policy).not.toMatch(/unsafe-inline|unsafe-eval|https:|ws:|wss:|\*/);
    expect(directive(first.policy, 'connect-src')).toBe("connect-src 'self'");
  });

  it('blocks inline event handlers, frames, plugins, workers and base-tag redirection', () => {
    const { policy } = createContentSecurityPolicy();
    for (const name of ['script-src-attr', 'frame-src', 'frame-ancestors', 'object-src', 'worker-src', 'base-uri']) {
      expect(directive(policy, name)).toBe(`${name} 'none'`);
    }
    expect(directive(policy, 'form-action')).toBe("form-action 'self'");
  });

  it('limits development relaxations to style injection, debugging eval and HMR connections', () => {
    const { nonce, policy } = createContentSecurityPolicy(true);
    expect(directive(policy, 'script-src')).toBe(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval'`);
    expect(directive(policy, 'style-src')).toBe("style-src 'self' 'unsafe-inline'");
    expect(directive(policy, 'connect-src')).toBe("connect-src 'self' ws: wss:");
    expect(directive(policy, 'script-src-attr')).toBe("script-src-attr 'none'");
  });

  it('replaces attacker-controlled nonce and CSP before Next renders and disables response caching', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const request = new NextRequest('https://first-bite.example/start', { headers: {
      'x-nonce': 'attacker-nonce', 'Content-Security-Policy': "script-src 'nonce-attacker-nonce' 'unsafe-inline'",
      cookie: 'first_bite_session=example',
    } });
    const response = proxy(request);
    const nonce = response.headers.get('x-middleware-request-x-nonce');
    const policy = response.headers.get('content-security-policy');
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{32}$/);
    expect(policy).toContain(`'nonce-${nonce}'`);
    expect(policy).not.toMatch(/attacker|unsafe-inline|unsafe-eval/);
    expect(response.headers.get('x-middleware-request-content-security-policy')).toBe(policy);
    expect(response.headers.get('x-middleware-request-cookie')).toBe('first_bite_session=example');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.has('x-nonce')).toBe(false);
  });

  it.each(['/', '/start', '/preview', '/api/session', '/api/attempts', '/healthz', '/readyz', '/unknown', '/_next/static-fake', '/favicon.ico/fake'])('covers %s', (url) => {
    expect(unstable_doesMiddlewareMatch({ config, nextConfig, url })).toBe(true);
  });

  it('does not trust user-supplied prefetch headers to bypass the document policy', () => {
    expect(unstable_doesMiddlewareMatch({ config, nextConfig, url: '/start', headers: {
      'next-router-prefetch': '1', purpose: 'prefetch', rsc: '1',
    } })).toBe(true);
  });

  it.each(['/_next/static/chunks/app.js', '/_next/image?url=test', '/favicon.ico'])('does not nonce immutable assets: %s', (url) => {
    expect(unstable_doesMiddlewareMatch({ config, nextConfig, url })).toBe(false);
  });

  it('retains global anti-sniffing, referrer, framing and sensitive capability headers', async () => {
    const rules = await nextConfig.headers!();
    const headers = Object.fromEntries(rules[0]!.headers.map(({ key, value }) => [key.toLowerCase(), value]));
    expect(headers).toMatchObject({
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    });
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});
