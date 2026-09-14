import type { Metadata } from 'next';
import { OnboardingJourney } from '@/components/onboarding/journey';
export const metadata: Metadata = { title: 'Your invitation' };
export default function StartPage() { return <OnboardingJourney />; }
