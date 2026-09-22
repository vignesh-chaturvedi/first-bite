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
    <header className="page-width pt-5 sm:pt-7"><div className="glass-panel flex min-h-20 flex-wrap items-center justify-between gap-x-5 gap-y-1 rounded-3xl px-5 py-3 sm:rounded-full sm:px-7">
      <Link href="/" aria-label="First Bite home" className="flex min-h-11 items-center"><BrandMark /></Link>
      <nav aria-label="Main navigation" className="flex items-center gap-5 text-sm sm:gap-7">
        <Link href="/#how-it-works" className="nav-link flex min-h-11 items-center">How it works</Link>
        <Link href="/preview" className="nav-link flex min-h-11 items-center">Walkthrough</Link>
        <span className="hidden items-center gap-2 rounded-full bg-secondary px-3 py-2 text-xs font-medium text-muted-foreground sm:inline-flex"><span className="size-1.5 rounded-full bg-cookie-ink" aria-hidden="true" />By invitation</span>
      </nav>
    </div></header>
    {children}
    <footer className="page-width mt-16 py-8 text-xs text-muted-foreground"><div className="flex flex-wrap items-center justify-between gap-6 border-t border-border pt-8">
      <Link href="/" aria-label="First Bite home" className="flex min-h-11 items-center text-foreground"><BrandMark /></Link><p>A little welcome. A name of your own.</p><Link href="/preview" className="nav-link inline-flex min-h-11 items-center">Explore the walkthrough ↗</Link>
    </div>
    </footer>
  </body></html>;
}
