import Image from 'next/image';
import { cn } from '@/lib/utils';

export function BiteSymbol({ className }: { className?: string }) {
  return <Image src="/brand/first-bite-symbol.png" alt="" width={128} height={128} className={cn('bite-symbol size-9 shrink-0', className)} />;
}

export function BrandMark() {
  return <span className="inline-flex items-center gap-2.5 text-2xl font-semibold tracking-tight"><BiteSymbol />first bite<span className="-ml-2 text-cookie-ink">.</span></span>;
}
