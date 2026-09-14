import { randomBytes } from 'node:crypto';

/** Never accept a request-provided nonce or a caller-provided script origin. */
export function createContentSecurityPolicy(development = false): { nonce: string; policy: string } {
  const nonce = randomBytes(24).toString('base64');
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ''}`,
    "script-src-attr 'none'",
    `style-src 'self' ${development ? "'unsafe-inline'" : `'nonce-${nonce}'`}`,
    `connect-src 'self'${development ? ' ws: wss:' : ''}`,
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
  ];
  return { nonce, policy: `${directives.join('; ')};` };
}
