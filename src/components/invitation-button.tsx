import { ArrowUpRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function InvitationButton({ className }: { className?: string }) {
  return <Button asChild className={cn('invitation-cta', className)}>
    <a href="/start">
      <span className="relative">Open your invitation</span>
      {/* A sliding detail, not a switch: this control still opens the invitation. */}
      <span className="invitation-cta-track" aria-hidden="true">
        <span className="invitation-cta-thumb"><ArrowUpRight /></span>
      </span>
    </a>
  </Button>;
}
