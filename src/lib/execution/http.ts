import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ConfigError } from '../../config/schema';
import { logger, type Logger } from '../../server/logger';
import type { CampaignStore } from '../campaigns/store';
import { CampaignError, type RateBucket } from '../campaigns/types';
import { assertSameOriginMutation, parseSessionCookie, readJsonBody, trustedClientIp } from '../security/http';
import { hashToken, SecurityError } from '../security/tokens';
import type { ExecutionStatusView } from './store';
import { ExecutionError } from './types';

/** Public progress only. Signed transaction payloads remain inside the service. */
export type { ExecutionStatusView } from './store';
export interface ExecutionHttpDependencies {
  enabled: boolean;
  appOrigin: string;
  trustedIpHeader: 'none' | 'x-real-ip' | 'cf-connecting-ip';
  getCampaignStore(): Pick<CampaignStore, 'getAttempt' | 'takeRateLimit'>;
  getService(): {
    submit(token: string, id: string, userSignedBase64: string): Promise<ExecutionStatusView>;
    retry(token: string, id: string): Promise<ExecutionStatusView>;
  };
  log?: Logger;
}

const HEADERS = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', Vary: 'Cookie' };
const idSchema = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const submitSchema = z.object({ userSignedTransactionBase64: z.string().min(4).max(1644) }).strict();
const retrySchema = z.object({}).strict();
const nativeSchema = z.string().regex(/^(0|[1-9][0-9]{0,23})$/);
const publicStatusSchema = z.object({
  attemptId: idSchema,
  status: z.enum(['prepared', 'signing', 'signed', 'submitted', 'broadcast_unknown', 'confirmed', 'finalized', 'complete', 'failed', 'expired', 'manual_review']),
  signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/).nullable(),
  verifiedSlot: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  actualCostNative: nativeSchema,
  residualNative: nativeSchema.nullable(),
});

const ERRORS = {
  EXECUTION_DISABLED: [503, 'Transaction execution is not enabled.', false, 'Ask the operator to complete the live wallet verification.'],
  INVALID_REQUEST: [400, 'The request could not be accepted.', false, 'Review the request and try again.'],
  SIGNATURE_INVALID: [400, 'The wallet signature could not be verified.', false, 'Sign the prepared transaction with your invitation wallet.'],
  SESSION_REQUIRED: [401, 'An invitation session is required.', false, 'Enter your invitation again.'],
  REQUEST_FORBIDDEN: [403, 'This request is not permitted.', false, 'Open First Bite directly and try again.'],
  INVITE_UNAVAILABLE: [403, 'This invitation is unavailable.', false, 'Contact the campaign organizer.'],
  ATTEMPT_NOT_FOUND: [404, 'This attempt is unavailable.', false, 'Use the invitation that prepared this attempt.'],
  CAMPAIGN_UNAVAILABLE: [409, 'This campaign cannot authorize a new transaction.', true, 'Check campaign status before trying again.'],
  QUOTE_EXPIRED: [409, 'This unsigned preparation has expired.', false, 'Prepare a fresh quote.'],
  POLICY_CHANGED: [409, 'The transaction no longer matches the reviewed policy.', false, 'Contact the campaign organizer.'],
  ATTEMPT_UNRESOLVED: [409, 'This attempt cannot accept that request.', false, 'Check the current attempt status.'],
  BUDGET_EXHAUSTED: [409, 'The campaign has no available sponsorship budget.', false, 'Contact the campaign organizer.'],
  RATE_LIMITED: [429, 'Too many requests. Please wait before trying again.', true, 'Wait one minute before trying again.'],
  PAYLOAD_TOO_LARGE: [413, 'The request body is too large.', false, 'Submit only the requested fields.'],
  REQUEST_TIMEOUT: [408, 'The request body did not arrive in time.', true, 'Check your connection and try again.'],
  SERVICE_UNAVAILABLE: [503, 'The execution service is temporarily unavailable.', true, 'Check the current attempt status before trying again.'],
  INTERNAL_ERROR: [500, 'The request could not be completed.', true, 'Check the current attempt status before trying again.'],
} as const;
type HttpCode = keyof typeof ERRORS;
class HttpError extends Error { constructor(readonly code: HttpCode) { super(code); } }

function errorCode(error: unknown): HttpCode {
  if (error instanceof HttpError) return error.code;
  if (error instanceof ExecutionError) {
    const codes = { disabled: 'EXECUTION_DISABLED', unauthorized: 'SESSION_REQUIRED', invalid_input: 'INVALID_REQUEST',
      signature_invalid: 'SIGNATURE_INVALID', policy_changed: 'POLICY_CHANGED', quote_expired: 'QUOTE_EXPIRED',
      unavailable: 'SERVICE_UNAVAILABLE', conflict: 'ATTEMPT_UNRESOLVED', budget_exhausted: 'BUDGET_EXHAUSTED',
      storage_unavailable: 'SERVICE_UNAVAILABLE', evidence_invalid: 'SERVICE_UNAVAILABLE' } as const;
    return codes[error.code] ?? 'INTERNAL_ERROR';
  }
  if (error instanceof CampaignError) {
    const codes = { invalid_input: 'INVALID_REQUEST', unauthorized: 'SESSION_REQUIRED', campaign_unavailable: 'CAMPAIGN_UNAVAILABLE',
      invite_unavailable: 'INVITE_UNAVAILABLE', quote_unavailable: 'QUOTE_EXPIRED', attempt_unavailable: 'ATTEMPT_NOT_FOUND',
      budget_exhausted: 'BUDGET_EXHAUSTED', capacity_exhausted: 'BUDGET_EXHAUSTED', conflict: 'ATTEMPT_UNRESOLVED',
      rate_limited: 'RATE_LIMITED', storage_unavailable: 'SERVICE_UNAVAILABLE' } as const;
    return codes[error.code] ?? 'INTERNAL_ERROR';
  }
  if (error instanceof SecurityError) {
    if (error.code === 'request_forbidden') return 'REQUEST_FORBIDDEN';
    if (error.code === 'body_too_large') return 'PAYLOAD_TOO_LARGE';
    if (error.code === 'body_timeout') return 'REQUEST_TIMEOUT';
    if (['origin_invalid', 'attempt_key_invalid', 'client_ip_invalid'].includes(error.code)) return 'SERVICE_UNAVAILABLE';
    return 'INVALID_REQUEST';
  }
  if (error instanceof ConfigError) return 'SERVICE_UNAVAILABLE';
  return 'INTERNAL_ERROR';
}

export function executionErrorResponse(error: unknown, log: Logger = logger): Response {
  const code = errorCode(error);
  const [status, message, retryable, nextAction] = ERRORS[code];
  const requestId = randomUUID();
  log(status >= 500 ? 'error' : 'warn', 'runtime.request_failed', {
    requestId, statusCode: status, failure: status >= 500 ? 'service_unavailable' : 'invalid_request',
  });
  return Response.json({ error: { code, message, retryable, nextAction, requestId } }, {
    status, headers: { ...HEADERS, 'X-Request-Id': requestId, ...(status === 429 ? { 'Retry-After': '60' } : {}) },
  });
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError('INVALID_REQUEST');
  return result.data;
}
function bucket(scope: string, identity: string, limit: number): RateBucket {
  return { scope, identity, limit, windowMs: 60_000 };
}
function checkedPayload(value: string): string {
  const bytes = Buffer.from(value, 'base64');
  try {
    if (bytes.length === 0 || bytes.length > 1232 || bytes.toString('base64') !== value) throw new HttpError('INVALID_REQUEST');
    return value;
  } finally { bytes.fill(0); }
}
function publicResponse(value: ExecutionStatusView, id: string): Response {
  // This projection strips unexpected private fields even if a service returns
  // an internal operation object accidentally. Validate before serializing.
  const parsed = publicStatusSchema.safeParse(value);
  if (!parsed.success || parsed.data.attemptId !== id) throw new HttpError('SERVICE_UNAVAILABLE');
  return Response.json({ attempt: parsed.data }, { headers: HEADERS });
}

export function createExecutionHandlers(deps: ExecutionHttpDependencies) {
  async function boundary(work: () => Promise<Response>): Promise<Response> {
    try { return await work(); } catch (error) { return executionErrorResponse(error, deps.log); }
  }
  function mutation(request: Request, id: string): { id: string; token: string } {
    if (!deps.enabled) throw new HttpError('EXECUTION_DISABLED');
    assertSameOriginMutation(request, deps.appOrigin);
    const validId = parse(idSchema, id);
    const token = parseSessionCookie(request);
    if (!token) throw new HttpError('SESSION_REQUIRED');
    return { id: validId, token };
  }
  async function rates(request: Request, id: string, token: string): Promise<void> {
    const store = deps.getCampaignStore();
    // Both endpoints share limits. Global denial precedes attacker-controlled
    // buckets, bounding the number of new database rate rows per window.
    await store.takeRateLimit([bucket('execution:global', 'all', 30)]);
    await store.takeRateLimit([bucket('execution:ip', trustedClientIp(request, deps.trustedIpHeader), 10)]);
    await store.takeRateLimit([bucket('execution:session', hashToken(token, 'session'), 10)]);
    // Status authentication remains valid during a pause, unlike getSession's
    // preparation gate. The service decides whether a new signature is allowed.
    const attempt = await store.getAttempt(token, id);
    if (attempt.id !== id) throw new HttpError('ATTEMPT_NOT_FOUND');
    await store.takeRateLimit([bucket('execution:wallet', attempt.wallet, 10), bucket('execution:attempt', attempt.id, 10)]);
  }
  return {
    submit: (request: Request, id: string) => boundary(async () => {
      const auth = mutation(request, id);
      const input = parse(submitSchema, await readJsonBody(request));
      const payload = checkedPayload(input.userSignedTransactionBase64);
      await rates(request, auth.id, auth.token);
      return publicResponse(await deps.getService().submit(auth.token, auth.id, payload), auth.id);
    }),
    retry: (request: Request, id: string) => boundary(async () => {
      const auth = mutation(request, id);
      parse(retrySchema, await readJsonBody(request));
      await rates(request, auth.id, auth.token);
      return publicResponse(await deps.getService().retry(auth.token, auth.id), auth.id);
    }),
  };
}
export type ExecutionHandlers = ReturnType<typeof createExecutionHandlers>;
