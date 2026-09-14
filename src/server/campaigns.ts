import 'server-only';
import { getServerConfig } from '../config/server';
import { CampaignStore } from '../lib/campaigns/store';
import { campaignErrorResponse, createCampaignHandlers, type CampaignHandlers } from '../lib/campaigns/http';
import { getServerDatabase } from './database';
import { getServerRegistry } from './registry';
import { logger } from './logger';

let handlers: CampaignHandlers | undefined;
let store: CampaignStore | undefined;

function getHandlers(): CampaignHandlers {
  if (handlers) return handlers;
  const config = getServerConfig();
  handlers = createCampaignHandlers({
    preparationEnabled: config.preparationEnabled, appOrigin: config.appOrigin,
    attemptEncryptionKey: config.attemptEncryptionKey, trustedIpHeader: config.trustedIpHeader,
    getStore: () => { store ??= new CampaignStore(getServerDatabase().pool); return store; },
    getRegistry: getServerRegistry, log: logger,
  });
  return handlers;
}

export async function campaignRequest(work: (handlers: CampaignHandlers) => Promise<Response>): Promise<Response> {
  try { return await work(getHandlers()); }
  catch (error) { return campaignErrorResponse(error, logger); }
}
