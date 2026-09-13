import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return <main id="main" className="page-width min-h-96 py-20"><p className="font-mono text-xs text-muted-foreground">PAGE NOT FOUND</p><h1 className="mt-4 font-serif text-4xl">This page isn&apos;t here.</h1><p className="mt-5 max-w-md leading-7 text-muted-foreground">The link may be incomplete or the page may have moved. Head back to First Bite to find your way.</p><Button asChild className="mt-7"><Link href="/">Back to First Bite</Link></Button></main>;
}
