import type { Metadata } from 'next';
import { connection } from 'next/server';
import { OnboardingJourney } from '@/components/onboarding/journey';
import { getServerConfig } from '@/config/server';
export const metadata: Metadata = { title: 'Your invitation' };
export default async function StartPage() {
  await connection();
  const { relayEnabled } = getServerConfig();
  return <OnboardingJourney key={String(relayEnabled)} executionEnabled={relayEnabled} />;
}
