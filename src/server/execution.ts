import 'server-only';
import { getServerConfig } from '../config/server';
import { createExecutionHandlers, executionErrorResponse, type ExecutionHandlers } from '../lib/execution/http';
import { createSubmissionRuntime } from '../lib/execution/runtime';
import { getServerDatabase } from './database';
import { logger } from './logger';

let handlers: ExecutionHandlers | undefined;
let application: ReturnType<typeof createSubmissionRuntime> | undefined;

export function getApplicationRuntime() {
  application ??= createSubmissionRuntime(getServerDatabase().pool, getServerConfig());
  return application;
}

function getHandlers(): ExecutionHandlers {
  if (handlers) return handlers;
  const config = getServerConfig();
  handlers = createExecutionHandlers({
    enabled: config.relayEnabled, appOrigin: config.appOrigin, trustedIpHeader: config.trustedIpHeader,
    getCampaignStore: () => getApplicationRuntime().campaigns,
    getService: () => getApplicationRuntime().service,
    log: logger,
  });
  return handlers;
}

export async function executionRequest(work: (handlers: ExecutionHandlers) => Promise<Response>): Promise<Response> {
  try { return await work(getHandlers()); }
  catch (error) { return executionErrorResponse(error, logger); }
}
