import { NextRequest, NextResponse } from 'next/server';
import { createContentSecurityPolicy } from './lib/security/headers';

export function proxy(request: NextRequest) {
  const { nonce, policy } = createContentSecurityPolicy(process.env.NODE_ENV === 'development');
  const headers = new Headers(request.headers);
  // Next reads the request CSP while rendering its own scripts and styles.
  // Overwrite both fields so a client cannot choose the trusted nonce.
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', policy);
  // A cached HTML response would reuse its nonce. API routes also stay private.
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}

export const config = {
  // Include APIs, 404s and prefetch/RSC requests; only immutable assets bypass.
  matcher: ['/((?!_next/static(?:/|$)|_next/image(?:/|$)|favicon\\.ico$).*)'],
};
