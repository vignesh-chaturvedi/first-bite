import { randomUUID } from 'node:crypto';
import { logger, type Logger } from './logger';

const API_ERRORS = {
  invalid_request: { status: 400, message: 'The request could not be accepted.' },
  not_found: { status: 404, message: 'The requested resource was not found.' },
  conflict: { status: 409, message: 'The request conflicts with the current state.' },
  service_unavailable: { status: 503, message: 'The service is temporarily unavailable.' },
  internal_error: { status: 500, message: 'The request could not be completed.' },
} as const;
export type ApiErrorCode = keyof typeof API_ERRORS;

export class ApiError extends Error {
  constructor(readonly code: ApiErrorCode) {
    super(API_ERRORS[code].message);
    this.name = 'ApiError';
  }
}

export function apiErrorResponse(error: unknown, log: Logger = logger): Response {
  const code = error instanceof ApiError && Object.hasOwn(API_ERRORS, error.code) ? error.code : 'internal_error';
  const { status, message } = API_ERRORS[code];
  const requestId = randomUUID();
  log('error', 'runtime.request_failed', { requestId, statusCode: status, failure: code });
  return Response.json({ error: { code, message, requestId } }, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Request-Id': requestId },
  });
}
