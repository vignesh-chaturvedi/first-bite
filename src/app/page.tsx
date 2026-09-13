import { ArrowDown, ArrowUpRight, Check, Cookie, KeyRound, Sparkles, Ticket } from 'lucide-react';
import { Button } from '@/components/ui/button';

const steps = [
  { number: '01', title: 'Bring your invitation', description: 'Your pass connects you to a sponsor covering your first steps on Cookie.', icon: Ticket },
  { number: '02', title: 'Find a name that feels like you', description: 'Choose an available .cook name, then review it with your Nightly wallet.', icon: Sparkles },
  { number: '03', title: 'Make yourself at home', description: 'Once confirmed, your name belongs to your wallet and becomes your primary name.', icon: KeyRound },
];

export default function Home() {
  return <main id="main" className="page-width">
    <section aria-labelledby="welcome-title" className="grid items-center gap-12 border-t border-border pt-14 pb-16 md:gap-16 md:pt-20 md:pb-24 lg:grid-cols-2">
      <div>
        <p className="mb-6 flex items-center gap-2 font-mono text-xs tracking-widest uppercase text-muted-foreground"><span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />A warm welcome to Cookie</p>
        <h1 id="welcome-title" className="max-w-xl font-serif text-5xl leading-[1.06] tracking-tight sm:text-6xl lg:text-7xl">A name to call<br className="hidden sm:block" /> your own.</h1>
        <p className="mt-7 max-w-md text-base leading-7 text-muted-foreground sm:text-lg sm:leading-8">Your first <span className="font-medium text-foreground">.cook</span> name, with a little help getting started. One invitation. Your name and network fees covered by a sponsor.</p>
        <div className="mt-8 flex flex-wrap items-center gap-4">
          <Button asChild><a href="#your-invitation">About your invitation <ArrowUpRight aria-hidden="true" /></a></Button>
          <a href="#how-it-works" className="inline-flex min-h-11 items-center gap-2 px-1 text-sm font-medium hover:underline underline-offset-4">How it works <ArrowDown className="size-4" aria-hidden="true" /></a>
        </div>
        <p className="mt-5 text-xs text-muted-foreground">A small pilot is on the way. Invitations aren&apos;t open yet.</p>
      </div>

      <figure className="relative mx-auto w-full max-w-md lg:ml-auto lg:mr-0" aria-label="An example of a First Bite invitation pass">
        <div className="relative overflow-hidden rounded-2xl bg-pass text-pass-foreground">
          <div className="pass-grain pointer-events-none absolute inset-0" aria-hidden="true" />
          <div className="relative p-7 sm:p-9">
            <div className="flex items-center justify-between gap-4 font-mono text-xs tracking-widest uppercase"><span>Your first bite</span><Cookie className="size-7" strokeWidth={1.4} aria-hidden="true" /></div>
            <div className="mt-16 mb-12"><p className="mb-3 text-xs uppercase tracking-widest">A place for your name</p><p className="break-all font-serif text-4xl tracking-tight sm:text-5xl">yourname.cook</p></div>
            <div className="flex items-center justify-between gap-3 text-xs"><span>Made for your wallet.</span><span className="rounded-full border border-current/40 px-2.5 py-1">Example pass</span></div>
          </div>
          <div className="relative flex items-center justify-between gap-4 border-t border-dashed border-current/30 px-7 py-6 sm:px-9">
            <div><p className="font-mono text-xs tracking-wider uppercase">One invitation</p><p className="mt-1 text-sm">A beginning, on Cookie.</p></div>
            <ArrowUpRight className="size-6" strokeWidth={1.5} aria-hidden="true" />
          </div>
        </div>
        <figcaption className="mt-4 text-center text-xs text-muted-foreground">Your own name. A sponsor for the first step.</figcaption>
      </figure>
    </section>

    <section id="how-it-works" aria-labelledby="steps-title" className="border-t border-border py-12 md:py-16">
      <div className="flex flex-wrap items-end justify-between gap-4"><h2 id="steps-title" className="font-serif text-3xl tracking-tight sm:text-4xl">A few steps. A fresh start.</h2><p className="text-sm text-muted-foreground">Here&apos;s the journey we&apos;re building.</p></div>
      <ol className="mt-10 grid gap-9 md:grid-cols-3 md:gap-8">
        {steps.map(({ number, title, description, icon: Icon }) => <li key={number}>
          <div className="mb-5 flex items-center gap-3"><span className="font-mono text-xs text-muted-foreground">{number}</span><span className="h-px flex-1 bg-border" /><Icon className="size-5 text-primary" strokeWidth={1.5} aria-hidden="true" /></div>
          <h3 className="text-base font-semibold">{title}</h3><p className="mt-3 max-w-sm text-sm leading-6 text-muted-foreground">{description}</p>
        </li>)}
      </ol>
    </section>

    <section id="your-invitation" aria-labelledby="invitation-title" className="grid gap-8 rounded-xl border border-border bg-card p-7 sm:p-10 md:grid-cols-2 md:gap-14">
      <div><p className="mb-3 font-mono text-xs tracking-widest uppercase text-muted-foreground">The first round</p><h2 id="invitation-title" className="font-serif text-3xl tracking-tight">Good things start small.</h2><p className="mt-4 max-w-md text-sm leading-6 text-muted-foreground">We&apos;re preparing a limited invitation pilot. When it opens, an eligible pass will cover your first name without needing COOK in your wallet beforehand.</p><Button disabled className="mt-6" aria-describedby="pilot-note">Invitations open soon</Button><p id="pilot-note" className="mt-3 text-xs text-muted-foreground">This preview doesn&apos;t connect a wallet or issue passes.</p></div>
      <div className="border-t border-border pt-6 md:border-t-0 md:border-l md:pt-0 md:pl-10"><h3 className="text-sm font-semibold">What your sponsor will cover</h3><ul className="mt-5 space-y-4 text-sm">{['An available .cook name, 4–32 characters', 'Registration and network fees', 'Setup as your wallet’s primary name'].map((item) => <li key={item} className="flex items-start gap-3"><Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" /><span>{item}</span></li>)}</ul><p className="mt-6 text-xs leading-5 text-muted-foreground">You&apos;ll review the name and coverage before approving anything in Nightly. Your wallet stays yours.</p></div>
    </section>
  </main>;
}
