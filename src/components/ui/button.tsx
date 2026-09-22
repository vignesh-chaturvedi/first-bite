import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// Small shadcn/Radix button composition, with First Bite's theme tokens and 48px targets.
const buttonVariants = cva(
  'bite-button inline-flex min-h-12 max-w-full items-center justify-center gap-2.5 rounded-full px-6 py-3 text-center text-sm font-semibold whitespace-normal focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-60 [&_svg]:size-4 [&_svg]:shrink-0',
  { variants: { variant: {
    default: 'button-primary bg-primary text-primary-foreground hover:bg-primary/90',
    secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
    outline: 'border border-input bg-card/60 text-foreground hover:bg-secondary',
  } }, defaultVariants: { variant: 'default' } },
);

type ButtonProps = React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean };

export function Button({ className, variant, asChild = false, ...props }: ButtonProps) {
  const Component = asChild ? Slot : 'button';
  return <Component data-slot="button" className={cn(buttonVariants({ variant, className }))} {...props} />;
}
