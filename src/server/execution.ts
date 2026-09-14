import 'server-only';
import { getServerConfig } from '../config/server';
import { createExecutionHandlers, executionErrorResponse, type ExecutionHandlers } from '../lib/execution/http';
import { ExecutionError } from '../lib/execution/types';
import { logger } from './logger';

let handlers: ExecutionHandlers | undefined;

function getHandlers(): ExecutionHandlers {
  if (handlers) return handlers;
  const config = getServerConfig();
  handlers = createExecutionHandlers({
    // Phase 0's funded Nightly verification and pilot approval remain open.
    // Local execution tests inject their own service. Production wiring and
    // sponsor custody must be reviewed before this boundary can be enabled.
    enabled: false, appOrigin: config.appOrigin, trustedIpHeader: config.trustedIpHeader,
    getCampaignStore: () => { throw new ExecutionError('disabled'); },
    getService: () => { throw new ExecutionError('disabled'); },
    log: logger,
  });
  return handlers;
}

export async function executionRequest(work: (handlers: ExecutionHandlers) => Promise<Response>): Promise<Response> {
  try { return await work(getHandlers()); }
  catch (error) { return executionErrorResponse(error, logger); }
}
