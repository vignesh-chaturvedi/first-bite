import type { Metadata } from 'next';
import { OnboardingJourney } from '@/components/onboarding/journey';
export const metadata: Metadata = { title: 'Onboarding walkthrough' };
export default function PreviewPage() { return <OnboardingJourney demo />; }
