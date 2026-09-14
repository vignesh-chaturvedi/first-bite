import { randomUUID } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import { ConfigError } from '../../config/schema';
import { logger, type Logger } from '../../server/logger';
import type { RegistryClient } from '../chain/client';
import { sealAttemptKey } from '../security/attempt-key';
import { assertSameOriginMutation, parseSessionCookie, readJsonBody, sessionCookie, trustedClientIp } from '../security/http';
import { hashToken, SecurityError } from '../security/tokens';
import { prepareSponsoredQuote, QuoteError } from '../transactions/quote';
import type { CampaignStore } from './store';
import { CampaignError, type AttemptView, type RateBucket, type SessionContext } from './types';
import { assertWallet } from './validation';

type HttpStore = Pick<CampaignStore, 'publicCampaign' | 'getSession' | 'saveQuote' | 'reserveAttempt' | 'getAttempt' | 'takeRateLimit'> & {
  exchangeInvite(token: string): Promise<{ sessionToken: string; expiresAt: Date; context: SessionContext }>;
};
export interface CampaignHttpDependencies {
  preparationEnabled: boolean;
  appOrigin: string;
  attemptEncryptionKey?: string | undefined;
  trustedIpHeader: 'none' | 'x-real-ip' | 'cf-connecting-ip';
  getStore(): HttpStore;
  getRegistry(): RegistryClient;
  log?: Logger;
  now?: () => number;
}

const HEADERS = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', Vary: 'Cookie' };
const idSchema = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const exchangeSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const quoteSchema = z.object({ name: z.string().min(1).max(64), wallet: z.string().min(32).max(44) }).strict();
const attemptSchema = z.object({ quoteId: idSchema, idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/) }).strict();
const slugSchema = z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const ERRORS = {
  INVALID_REQUEST: [400, 'The request could not be accepted.', false, 'Review the request and try again.'],
  SESSION_REQUIRED: [401, 'An invitation session is required.', false, 'Enter your invitation again.'],
  REQUEST_FORBIDDEN: [403, 'This request is not permitted.', false, 'Open First Bite directly and try again.'],
  WALLET_MISMATCH: [403, 'This invitation belongs to a different wallet.', false, 'Connect the wallet assigned to your invitation.'],
  CAMPAIGN_UNAVAILABLE: [409, 'This campaign is not accepting preparations.', true, 'Check campaign status before trying again.'],
  INVITE_UNAVAILABLE: [403, 'This invitation is unavailable.', false, 'Contact the campaign organizer.'],
  QUOTE_CHANGED: [409, 'This quote is unavailable or has expired.', true, 'Prepare a fresh quote.'],
  ATTEMPT_NOT_FOUND: [404, 'This attempt is unavailable.', false, 'Use the invitation that prepared this attempt.'],
  BUDGET_EXHAUSTED: [409, 'The campaign has no available sponsorship budget.', false, 'Contact the campaign organizer.'],
  CAPACITY_EXHAUSTED: [409, 'All campaign passes are currently allocated.', false, 'Check campaign status later.'],
  ATTEMPT_UNRESOLVED: [409, 'An existing preparation conflicts with this request.', false, 'Continue the existing attempt.'],
  RATE_LIMITED: [429, 'Too many requests. Please wait before trying again.', true, 'Wait one minute before trying again.'],
  PAYLOAD_TOO_LARGE: [413, 'The request body is too large.', false, 'Submit only the requested fields.'],
  REQUEST_TIMEOUT: [408, 'The request body did not arrive in time.', true, 'Check your connection and try again.'],
  PREPARATION_DISABLED: [503, 'Local preparation is not enabled.', false, 'Ask the operator to complete the local setup.'],
  RPC_UNAVAILABLE: [503, 'The chain could not be checked safely.', true, 'Wait and prepare a fresh quote.'],
  SERVICE_UNAVAILABLE: [503, 'The service is temporarily unavailable.', true, 'Try again later.'],
  INTERNAL_ERROR: [500, 'The request could not be completed.', true, 'Try again later.'],
} as const;
type HttpCode = keyof typeof ERRORS;
class HttpError extends Error { constructor(readonly code: HttpCode) { super(code); } }

function errorCode(error: unknown): HttpCode {
  if (error instanceof HttpError) return error.code;
  if (error instanceof ConfigError) return 'SERVICE_UNAVAILABLE';
  if (error instanceof CampaignError) {
    const codes = { invalid_input: 'INVALID_REQUEST', unauthorized: 'SESSION_REQUIRED', campaign_unavailable: 'CAMPAIGN_UNAVAILABLE',
      invite_unavailable: 'INVITE_UNAVAILABLE', quote_unavailable: 'QUOTE_CHANGED', attempt_unavailable: 'ATTEMPT_NOT_FOUND',
      budget_exhausted: 'BUDGET_EXHAUSTED', capacity_exhausted: 'CAPACITY_EXHAUSTED', conflict: 'ATTEMPT_UNRESOLVED',
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
  if (error instanceof QuoteError) {
    if (error.code === 'invalid_name') return 'INVALID_REQUEST';
    if (error.code === 'quote_expired' || error.code === 'cost_limit') return 'QUOTE_CHANGED';
    return 'RPC_UNAVAILABLE';
  }
  return 'INTERNAL_ERROR';
}

/** Only fixed public text and redacted metadata leave the error boundary. */
export function campaignErrorResponse(error: unknown, log: Logger = logger): Response {
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

function response(data: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(data, { headers: { ...HEADERS, ...headers } });
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError('INVALID_REQUEST');
  return result.data;
}
function capability(request: Request): string {
  const token = parseSessionCookie(request);
  if (!token) throw new HttpError('SESSION_REQUIRED');
  return token;
}
function attemptView(value: AttemptView) {
  return { id: value.id, quoteId: value.quoteId, status: value.status, name: value.name, wallet: value.wallet,
    reservationNative: value.reservationNative, messageHash: value.messageHash,
    unsignedTransactionBase64: value.unsignedTransactionBase64, expiresAt: value.expiresAt };
}
function bucket(scope: string, identity: string, limit: number): RateBucket {
  return { scope, identity, limit, windowMs: 60_000 };
}

/** HTTP only orchestrates fixed preparation APIs. There is no signing or relay port. */
export function createCampaignHandlers(deps: CampaignHttpDependencies) {
  const log = deps.log ?? logger;
  async function boundary(work: () => Promise<Response>): Promise<Response> {
    try { return await work(); } catch (error) { return campaignErrorResponse(error, log); }
  }
  function mutation(request: Request): void {
    if (!deps.preparationEnabled) throw new HttpError('PREPARATION_DISABLED');
    if (!deps.attemptEncryptionKey) throw new HttpError('SERVICE_UNAVAILABLE');
    assertSameOriginMutation(request, deps.appOrigin);
  }
  async function takeBaseRates(store: HttpStore, request: Request, operation: string, globalLimit = 120, ipLimit = 30): Promise<void> {
    // Commit the fixed global bucket first. Once it denies, arbitrary IP/token
    // identities cannot create more rate rows during this operation's window.
    await store.takeRateLimit([bucket(`${operation}:global`, 'all', globalLimit)]);
    await store.takeRateLimit([bucket(`${operation}:ip`, trustedClientIp(request, deps.trustedIpHeader), ipLimit)]);
  }
  function contextRates(operation: string, session: SessionContext): RateBucket[] {
    return [bucket(`${operation}:session`, session.sessionId, 10), bucket(`${operation}:wallet`, session.wallet, 10), bucket(`${operation}:invite`, session.inviteId, 10)];
  }

  return {
    publicCampaign: (request: Request, slug: string) => boundary(async () => {
      const validSlug = parse(slugSchema, slug);
      const store = deps.getStore();
      await takeBaseRates(store, request, 'campaign-read', 600, 120);
      const c = await store.publicCampaign(validSlug);
      return response({ campaign: { name: c.name, slug: c.slug, status: c.status, startsAt: c.startsAt, endsAt: c.endsAt, nameRule: c.nameRule } });
    }),

    exchange: (request: Request) => boundary(async () => {
      mutation(request);
      const input = parse(exchangeSchema, await readJsonBody(request));
      const store = deps.getStore();
      await takeBaseRates(store, request, 'exchange');
      await store.takeRateLimit([bucket('exchange:invite', hashToken(input.token, 'invite'), 10)]);
      const result = await store.exchangeInvite(input.token);
      const c = result.context.campaign;
      return response({ wallet: result.context.wallet, expiresAt: result.expiresAt,
        campaign: { name: c.name, slug: c.slug, status: c.status } },
      { 'Set-Cookie': sessionCookie(result.sessionToken, result.expiresAt, deps.appOrigin) });
    }),

    quote: (request: Request) => boundary(async () => {
      mutation(request);
      const input = parse(quoteSchema, await readJsonBody(request));
      assertWallet(input.wallet);
      const token = capability(request);
      const store = deps.getStore();
      await takeBaseRates(store, request, 'quote', 60, 20);
      const session = await store.getSession(token);
      await store.takeRateLimit(contextRates('quote', session));
      if (input.wallet !== session.wallet) throw new HttpError('WALLET_MISMATCH');
      const id = randomUUID();
      const payer = Keypair.generate();
      // web3 returns a copy here. Erase the buffer we own after wrapping; web3
      // and the JS/crypto runtime may retain internal copies until collection.
      // This is best-effort erasure, not a locked-memory guarantee.
      const secret = payer.secretKey;
      try {
        const quote = await prepareSponsoredQuote({ name: input.name, sponsor: new PublicKey(session.campaign.sponsorPublicKey),
          user: new PublicKey(session.wallet), attemptPayer: payer.publicKey }, deps.getRegistry(), session.campaign.limits, deps.now);
        const encryptedPayerKey = sealAttemptKey(secret, deps.attemptEncryptionKey!, id, payer.publicKey.toBase58());
        await store.saveQuote(token, { id, quote, encryptedPayerKey });
        return response({ quoteId: id, name: quote.name, cost: quote.cost, expiresAt: new Date(quote.expiresAtMs), expected: quote.expected });
      } finally { secret.fill(0); }
    }),

    reserve: (request: Request) => boundary(async () => {
      mutation(request);
      const input = parse(attemptSchema, await readJsonBody(request));
      const token = capability(request);
      const store = deps.getStore();
      await takeBaseRates(store, request, 'reserve', 60, 20);
      const session = await store.getSession(token);
      await store.takeRateLimit(contextRates('reserve', session));
      return response({ attempt: attemptView(await store.reserveAttempt(token, input)) });
    }),

    attempt: (request: Request, id: string) => boundary(async () => {
      const validId = parse(idSchema, id);
      const token = capability(request);
      const store = deps.getStore();
      await takeBaseRates(store, request, 'attempt-read', 600, 120);
      await store.takeRateLimit([bucket('attempt-read:session', hashToken(token, 'session'), 60)]);
      // The store authenticates the session without requiring an active campaign.
      return response({ attempt: attemptView(await store.getAttempt(token, validId)) });
    }),
  };
}

export type CampaignHandlers = ReturnType<typeof createCampaignHandlers>;
