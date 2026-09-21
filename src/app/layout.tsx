import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { BrandMark } from '@/components/brand-mark';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'First Bite — Your first .cook name', template: '%s · First Bite' },
  description: 'An invitation to Cookie, with your first .cook name and network fees covered by a sponsor.',
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Nonces exist only for an incoming request, never in a prerendered shell.
  await connection();
  return <html lang="en"><body className="font-sans antialiased">
    <a href="#main" className="sr-only z-50 focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:rounded-md focus:bg-primary focus:px-5 focus:py-3 focus:text-primary-foreground">Skip to content</a>
    <header className="page-width flex min-h-24 flex-wrap items-center justify-between gap-4 py-5">
      <Link href="/" aria-label="First Bite home" className="flex min-h-11 items-center"><BrandMark /></Link>
      <nav aria-label="Main navigation" className="flex items-center gap-5 text-sm sm:gap-8">
        <Link href="/#how-it-works" className="flex min-h-11 items-center hover:underline underline-offset-4">How it works</Link>
        <span className="rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground">By invitation</span>
      </nav>
    </header>
    {children}
    <footer className="page-width mt-16 flex flex-wrap items-center justify-between gap-3 border-t border-border py-7 text-xs text-muted-foreground">
      <p>A little welcome to Cookie.</p><p>First Bite · Invitation-based onboarding</p>
    </footer>
  </body></html>;
}
