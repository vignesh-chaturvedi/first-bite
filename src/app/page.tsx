import { ArrowDown, ArrowUpRight, Check, KeyRound, Sparkles, Ticket } from 'lucide-react';
import { connection } from 'next/server';
import { BiteSymbol } from '@/components/brand-mark';
import { Button } from '@/components/ui/button';
import { getServerConfig } from '@/config/server';

const steps = [
  { number: '01', title: 'A little invitation.', description: 'Your pass connects you to a sponsor covering your first steps on Cookie.', icon: Ticket },
  { number: '02', title: 'A name that feels like you.', description: 'Choose an available .cook name, then review it with your Nightly wallet.', icon: Sparkles },
  { number: '03', title: 'A place to call your own.', description: 'Once confirmed, your name belongs to your wallet and becomes your primary name.', icon: KeyRound },
];

export default async function Home() {
  await connection();
  const { relayEnabled } = getServerConfig();
  return <main id="main" className="page-width">
    <section aria-labelledby="welcome-title" className="grid items-center gap-8 pt-14 pb-12 sm:pt-20 lg:grid-cols-[1.1fr_1fr] lg:gap-14 lg:pt-24 lg:pb-20">
      <div>
        <p className="mb-7 inline-flex items-center gap-2.5 rounded-full border border-border bg-card/70 px-3.5 py-2 text-xs font-medium text-muted-foreground"><span aria-hidden="true" className="size-1.5 rounded-full bg-cookie-ink" />A warm welcome to Cookie</p>
        <h1 id="welcome-title" className="hero-title max-w-xl font-serif">A name to call<br /><em>your own.</em></h1>
        <p className="mt-7 max-w-md text-base leading-7 text-muted-foreground sm:text-lg sm:leading-8">Your first <span className="font-semibold text-foreground">.cook</span> name, with a little help getting started. One invitation. Your name and network fees covered by a sponsor.</p>
        <div className="mt-8 flex flex-wrap items-center gap-4">
          <Button asChild><a href="/start">Open your invitation <ArrowUpRight aria-hidden="true" /></a></Button>
          <a href="#how-it-works" className="nav-link inline-flex min-h-12 items-center gap-2 px-1 text-sm font-medium">How it works <ArrowDown className="size-4" aria-hidden="true" /></a>
        </div>
        <p className="mt-5 max-w-md text-xs leading-6 text-muted-foreground">{relayEnabled ? 'Available with an active invitation.' : 'Wallet approvals are currently paused.'} <a href="/preview" className="inline-flex min-h-11 items-center underline underline-offset-4">Try the walkthrough ↗</a></p>
        <div className="mt-7 flex flex-wrap gap-x-5 gap-y-3 border-t border-border pt-5 text-xs text-muted-foreground">{['Your wallet stays yours', 'Your first step, sponsored'].map((text) => <span key={text} className="inline-flex items-center gap-2"><Check className="size-3.5 text-primary" aria-hidden="true" />{text}</span>)}</div>
      </div>

      <figure className="mx-auto w-full max-w-md lg:mr-0" aria-label="An example of a First Bite invitation pass">
        <div className="hero-art">
          <div className="pass-back" aria-hidden="true" />
          <span className="welcome-seal flex size-24 flex-col items-center justify-center rounded-full text-center text-xs leading-4 sm:size-28" aria-hidden="true"><Sparkles className="mb-1 size-4" /><span>A little<br /><strong>welcome.</strong></span></span>
          <div className="invitation-pass overflow-hidden rounded-3xl border border-border bg-pass text-pass-foreground">
            <div className="pass-grain pointer-events-none absolute inset-0" aria-hidden="true" />
            <div className="relative p-7 sm:p-8">
              <div className="flex items-center gap-2.5"><BiteSymbol className="size-8" /><span className="text-lg font-semibold tracking-tight">first bite.</span></div>
              <div className="mt-12 mb-8"><p className="mb-3 font-mono text-xs uppercase tracking-widest">This is your beginning</p><p className="break-all font-serif text-4xl tracking-tight sm:text-5xl">yourname<span className="text-primary">.cook</span></p><p className="mt-3 text-sm text-pass-foreground/80">Made for your wallet. Ready for your story.</p></div>
              <div className="flex flex-wrap items-center gap-2 text-xs"><span className="rounded-full border border-current/25 px-3 py-1.5">Name + network fees covered</span><span className="rounded-full bg-card/70 px-3 py-1.5 text-foreground">Example pass</span></div>
            </div>
            <div className="pass-seam flex items-center justify-between gap-4 bg-card/30 px-7 py-6 sm:px-8">
              <div><p className="font-mono text-xs tracking-wider uppercase">One invitation. All yours.</p><p className="mt-1.5 text-sm">A first bite of Cookie.</p></div>
              <ArrowUpRight className="size-7" strokeWidth={1.5} aria-hidden="true" />
            </div>
          </div>
        </div>
        <figcaption className="mt-5 text-center text-xs text-muted-foreground">A preview of your pass. A real name comes after confirmation.</figcaption>
      </figure>
    </section>

    <section id="how-it-works" aria-labelledby="steps-title" className="py-12 md:py-16">
      <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="mb-3 font-mono text-xs tracking-widest uppercase text-cookie-ink">From hello to home</p><h2 id="steps-title" className="font-serif text-3xl tracking-tight sm:text-4xl">Small steps. Sweet beginnings.</h2></div><p className="max-w-56 text-sm leading-6 text-muted-foreground">A simpler way to find your feet on Cookie.</p></div>
      <ol className="mt-9 grid gap-8 md:grid-cols-3 md:gap-8">
        {steps.map(({ number, title, description, icon: Icon }) => <li key={number} className="step-card pt-6">
          <div className="mb-6 flex items-center justify-between gap-3"><span className="font-mono text-xs text-muted-foreground">{number} /</span><span className="flex size-11 items-center justify-center rounded-2xl bg-secondary"><Icon className="size-5 text-primary" strokeWidth={1.5} aria-hidden="true" /></span></div>
          <h3 className="text-base font-semibold">{title}</h3><p className="mt-3 max-w-sm text-sm leading-6 text-muted-foreground">{description}</p>
        </li>)}
      </ol>
    </section>

    <section id="your-invitation" aria-labelledby="invitation-title" className="glass-panel mb-4 grid gap-8 overflow-hidden rounded-3xl p-7 sm:p-10 md:grid-cols-2 md:gap-12">
      <div><p className="mb-3 font-mono text-xs tracking-widest uppercase text-cookie-ink">A little help goes a long way</p><h2 id="invitation-title" className="font-serif text-3xl tracking-tight sm:text-4xl">Good things start small.</h2><p className="mt-4 max-w-md text-sm leading-7 text-muted-foreground">An eligible pass covers your first name without needing COOK in your wallet beforehand. Your organizer assigns the pass to your wallet and sets its sponsorship limit.</p>{relayEnabled ? <Button asChild className="mt-6"><a href="/start">Open your invitation <ArrowUpRight aria-hidden="true" /></a></Button> : <Button disabled className="mt-6" aria-describedby="availability-note">Wallet approvals paused</Button>}<p id="availability-note" className="mt-4 text-xs leading-6 text-muted-foreground">{relayEnabled ? 'Your pass must be active and have available sponsorship.' : 'You can check saved progress or try the example walkthrough.'}</p></div>
      <div className="coverage-stamp rounded-2xl p-6 sm:p-8"><div className="flex items-center justify-between gap-4"><h3 className="font-semibold">The first round is covered.</h3><BiteSymbol className="size-8" /></div><ul className="mt-6 space-y-5 text-sm">{['An available .cook name, 4–32 characters', 'Registration and network fees', 'Setup as your wallet’s primary name'].map((item) => <li key={item} className="flex items-start gap-3"><Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" /><span>{item}</span></li>)}</ul><p className="mt-6 border-t border-border pt-5 text-xs leading-6 text-muted-foreground">You&apos;ll review the name and coverage before approving anything in Nightly. Your wallet stays yours.</p></div>
    </section>
  </main>;
}
