'use client';

import { Button } from '@/components/ui/button';

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main id="main" className="page-width min-h-96 py-20"><h1 className="font-serif text-4xl">We couldn&apos;t load this page.</h1><p className="mt-5 max-w-md leading-7 text-muted-foreground">Try loading it again. If the issue continues, come back in a moment.</p><Button onClick={reset} className="mt-7">Try again</Button></main>;
}
