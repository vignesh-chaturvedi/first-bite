import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export type SecurityErrorCode = 'token_invalid' | 'attempt_key_invalid' | 'origin_invalid'
  | 'request_forbidden' | 'content_type_invalid' | 'body_too_large' | 'body_invalid' | 'body_timeout'
  | 'cookie_invalid' | 'client_ip_invalid';

/** Only fixed codes may reach logs or public error mapping; never attach a cause. */
export class SecurityError extends Error {
  constructor(readonly code: SecurityErrorCode) {
    super(`Security check failed: ${code}`);
    this.name = 'SecurityError';
  }
}

export function assertToken(token: string): void {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new SecurityError('token_invalid');
  }
  const bytes = Buffer.from(token, 'base64url');
  try {
    if (bytes.length !== 32 || bytes.toString('base64url') !== token) throw new SecurityError('token_invalid');
  } finally { bytes.fill(0); }
}

export function generateToken(): string {
  const bytes = randomBytes(32);
  try { return bytes.toString('base64url'); }
  finally { bytes.fill(0); }
}

/** Invitations and sessions cannot share a database lookup even for identical bytes. */
export function hashToken(token: string, purpose: 'invite' | 'session'): string {
  assertToken(token);
  if (purpose !== 'invite' && purpose !== 'session') throw new SecurityError('token_invalid');
  const bytes = Buffer.from(token, 'base64url');
  try {
    return createHash('sha256').update(`first-bite:token:v1:${purpose}\0`, 'utf8').update(bytes).digest('hex');
  } finally { bytes.fill(0); }
}

export function equalTokenHashes(left: string, right: string): boolean {
  if (typeof left !== 'string' || typeof right !== 'string' || !/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
