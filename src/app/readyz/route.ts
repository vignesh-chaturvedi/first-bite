import { getServerConfig } from '../../config/server';
import { probeDatabase } from '../../server/database';
import { logger } from '../../server/logger';
import { evaluateReadiness } from '../../server/readiness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    const result = await evaluateReadiness(getServerConfig(), probeDatabase);
    if (!result.ready) logger('warn', 'health.not_ready', { failure: result.reason });
    return Response.json({ status: result.ready ? 'ready' : 'not_ready', scope: 'foundation', relayEnabled: false, sponsorship: 'disabled' }, {
      status: result.ready ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    logger('error', 'runtime.config_invalid', { failure: 'configuration' });
    return Response.json({ status: 'not_ready', scope: 'foundation', relayEnabled: false, sponsorship: 'disabled' }, {
      status: 503, headers: { 'Cache-Control': 'no-store' },
    });
  }
}
