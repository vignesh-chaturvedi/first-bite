import { createJourneyApi } from './api';
import { JourneyController } from './controller';
import { createDemoJourney } from './demo';
import { createNightlyWallet } from './wallet';

/** Only a public availability flag crosses the server/client boundary. */
export function createOnboardingRuntime({ demo = false, executionEnabled = false }: {
  demo?: boolean;
  executionEnabled?: boolean;
} = {}) {
  // The walkthrough always uses isolated fixtures, even on an enabled deployment.
  const ports = demo ? createDemoJourney() : { api: createJourneyApi(), wallet: createNightlyWallet() };
  return { controller: new JourneyController(ports.api, ports.wallet, demo || executionEnabled), wallet: ports.wallet };
}
