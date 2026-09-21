'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { ArrowRight, Check, CheckCircle2, Cookie, Copy, ExternalLink, ShieldCheck, Ticket, Wallet, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DEMO_TOKEN } from '@/lib/onboarding/demo';
import { COOKIE_GENESIS, formatCook, normalizeLabel, STATUS_COPY, verifiedResult, type JourneyAttempt } from '@/lib/onboarding/model';
import { createOnboardingRuntime } from '@/lib/onboarding/runtime';

const inputClass = 'mt-2 min-h-12 w-full rounded-md border border-input bg-background px-4 py-3 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60';
const chapters = ['Invitation', 'Wallet', 'Name', 'Review', 'Welcome'];
function Address({ value, label = 'Wallet' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return <div className="min-w-0"><span className="text-xs text-muted-foreground">{label}</span><div className="flex min-w-0 items-center gap-2">
    <span className="font-mono text-sm" title={value}>{value.slice(0, 5)}…{value.slice(-5)}</span>
    <button type="button" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md hover:bg-secondary" aria-label={`Copy ${label.toLowerCase()} address`} onClick={async () => { try { await navigator.clipboard.writeText(value); setCopied(true); setFailed(false); } catch { setFailed(true); } }}><Copy className="size-4" aria-hidden="true" /></button>
    <span role="status" className="text-xs text-muted-foreground">{copied ? 'Copied' : ''}</span>
  </div><details className="text-xs text-muted-foreground"><summary className="flex min-h-11 cursor-pointer items-center">Show full address</summary><p className="break-all select-all font-mono leading-6">{value}</p></details>{failed && <p role="status" className="text-xs">Select the full address above to copy it.</p>}</div>;
}
function Result({ attempt, demo }: { attempt: JourneyAttempt; demo: boolean }) {
  const [copyStatus, setCopyStatus] = useState('');
  return <div className="mt-7 space-y-6">
    <div className="rounded-lg bg-secondary p-5"><div className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="size-5" aria-hidden="true" />{demo ? 'Example verification' : 'Verified on Cookie'}</div><dl className="mt-4 grid gap-3 text-sm"><div className="flex flex-wrap justify-between gap-2"><dt>Primary name</dt><dd className="break-all font-semibold">{attempt.name}.cook</dd></div><div className="flex flex-wrap justify-between gap-2"><dt>You paid</dt><dd className="font-mono">0 COOK</dd></div></dl></div>
    <Address value={attempt.wallet} label="Owner" />
    <div><Button variant="outline" onClick={async () => { try { await navigator.clipboard.writeText(`${attempt.name}.cook`); setCopyStatus('Name copied'); } catch { setCopyStatus('Select your name above to copy it.'); } }}><Copy aria-hidden="true" />Copy name</Button><p role="status" className="mt-2 text-xs text-muted-foreground">{copyStatus}</p></div>
    {!demo && attempt.signature && <a className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold underline underline-offset-4" href={`https://cookiescan.io/tx/${encodeURIComponent(attempt.signature)}`} target="_blank" rel="noreferrer">View transaction <ExternalLink className="size-4" aria-hidden="true" /></a>}
    <div className="border-t border-border pt-5"><h3 className="font-semibold">Take your name with you.</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">Open CookBook with the same wallet to find your name. It is a separate Cookie app; this link opens its home page.</p><Button variant="outline" className="mt-4" asChild><a href="https://book.cookoven.xyz" target="_blank" rel="noreferrer">Open CookBook <ExternalLink aria-hidden="true" /></a></Button></div>
  </div>;
}

export function OnboardingJourney({ demo = false, executionEnabled = false }: { demo?: boolean; executionEnabled?: boolean }) {
  const [{ controller, wallet }] = useState(() => createOnboardingRuntime({ demo, executionEnabled }));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [token, setToken] = useState('');
  const [now, setNow] = useState(0);
  const title = useRef<HTMLHeadingElement>(null);
  const previousStep = useRef(state.step);
  useEffect(() => {
    controller.refreshWallet(); void controller.restore();
    const update = () => { controller.setOffline(!navigator.onLine); controller.refreshWallet(); };
    update(); const stop = wallet.subscribe(update);
    window.addEventListener('online', update); window.addEventListener('offline', update); window.addEventListener('focus', update);
    const timer = setInterval(() => { setNow(Date.now()); controller.refreshWallet(); }, 1000);
    return () => { stop(); clearInterval(timer); window.removeEventListener('online', update); window.removeEventListener('offline', update); window.removeEventListener('focus', update); };
  }, [controller, wallet]);
  useEffect(() => {
    if (previousStep.current !== state.step) { title.current?.focus(); previousStep.current = state.step; }
  }, [state.step]);
  useEffect(() => {
    if (state.step !== 'name' || !normalizeLabel(state.name)) return;
    const timer = setTimeout(() => { void controller.checkName(); }, 650);
    return () => clearTimeout(timer);
  }, [state.name, state.step, controller]);
  useEffect(() => {
    if (state.step !== 'progress' || !state.attempt || ['complete', 'failed', 'expired', 'manual_review'].includes(state.attempt.status) || state.offline || state.error) return;
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void controller.refresh(); }, 5000);
    return () => clearInterval(timer);
  }, [state.step, state.attempt, state.offline, state.error, controller]);
  const busy = state.busy !== null || state.restoring;
  const matched = state.wallet.address === state.session?.wallet && state.wallet.genesisHash === COOKIE_GENESIS && state.wallet.canSign;
  const quoteFresh = !!state.quote && Date.parse(state.quote.expiresAt) > now;
  const attemptFresh = !!state.attempt && Date.parse(state.attempt.expiresAt) > now;
  const success = verifiedResult(state.attempt);
  const chapter = { invite: 0, wallet: 1, name: 2, review: 3, progress: 4 }[state.step];
  const heading = { invite: 'Your invitation starts here.', wallet: 'A wallet to call it yours.', name: 'What should we call you?', review: 'A name. Entirely yours.', progress: state.attempt ? STATUS_COPY[state.attempt.status].title : 'Checking your registration' }[state.step];
  const name = state.attempt?.name || normalizeLabel(state.name) || 'yourname';
  return <main id="main" className="page-width">
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border py-5 text-xs text-muted-foreground"><Link href="/" className="inline-flex min-h-11 items-center">← Back to First Bite</Link><span className="rounded-full border border-input px-3 py-2">{demo ? 'Walkthrough · no wallet or funds used' : controller.executionEnabled ? 'Sponsored registration · by invitation' : 'Wallet approvals are paused'}</span></div>
    <div className="grid gap-10 pb-10 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)] lg:gap-20">
      <section aria-labelledby="journey-title" className="min-w-0">
        <ol aria-label="Your onboarding progress" className="mb-10 flex flex-wrap gap-x-5 gap-y-3 text-xs">{chapters.map((label, i) => <li key={label} aria-current={chapter === i ? 'step' : undefined} className={chapter === i ? 'font-semibold text-foreground' : 'text-muted-foreground'}><span className="mr-1.5 font-mono">{i < chapter ? '✓' : `0${i + 1}`}</span>{label}</li>)}</ol>
        {state.restoring ? <div role="status" className="min-h-72"><p className="text-sm text-muted-foreground">Checking for your invitation…</p><div aria-hidden="true" className="mt-6 space-y-4"><div className="h-10 w-3/4 rounded bg-secondary" /><div className="h-5 w-full rounded bg-secondary" /><div className="h-12 rounded bg-secondary" /></div></div> : <>
          <h1 id="journey-title" ref={title} tabIndex={-1} className="font-serif text-4xl leading-tight tracking-tight focus:outline-none sm:text-5xl">{heading}</h1>
          {state.offline && <p role="status" className="mt-5 flex gap-2 rounded-md border border-input p-4 text-sm"><WifiOff className="size-5 shrink-0" aria-hidden="true" />You’re offline. Reconnect to continue; an approved registration may still be processing.</p>}
          {state.error && <div role="alert" className="mt-5 rounded-md border border-input bg-secondary p-4 text-sm leading-6"><p>{state.error}</p><div className="mt-2 flex flex-wrap gap-3"><button type="button" disabled={busy} className="min-h-11 font-semibold underline underline-offset-4" onClick={() => void controller.refresh()}>Check saved progress</button>{state.step !== 'invite' && <button type="button" disabled={busy} className="min-h-11 font-semibold underline underline-offset-4" onClick={() => controller.invitationStep()}>Enter invitation again</button>}</div></div>}
          {state.step === 'invite' && <form className="mt-6" onSubmit={(event) => { event.preventDefault(); const value = token; setToken(''); void controller.exchange(value); }}>
            <p className="mb-7 text-sm leading-7 text-muted-foreground">Your organizer’s pass covers one .cook name and its network fees. It is tied to the wallet you shared with them.</p>
            <label htmlFor="invite-code" className="text-sm font-semibold">Invitation code</label><input id="invite-code" type="password" autoComplete="off" spellCheck={false} autoCapitalize="none" maxLength={43} value={token} onChange={(event) => setToken(event.target.value)} className={inputClass} placeholder="Paste your private invitation" aria-describedby="invite-help" disabled={busy} required />
            <p id="invite-help" className="mt-3 text-xs leading-5 text-muted-foreground">Keep this code private. We never put it in a link or save it in browser storage.</p>
            <Button type="submit" className="mt-7 w-full sm:w-auto" disabled={busy || state.offline || token.trim().length !== 43}>Open my invitation <ArrowRight aria-hidden="true" /></Button>
            {demo ? <Button type="button" variant="outline" className="mt-4 w-full" disabled={busy} onClick={() => void controller.exchange(DEMO_TOKEN)}>Use an example invitation</Button> : <p className="mt-6 text-sm leading-6 text-muted-foreground">Waiting for your pass? <Link href="/preview" className="inline-flex min-h-11 items-center font-semibold text-foreground underline underline-offset-4">Explore the walkthrough</Link></p>}
          </form>}
          {state.step === 'wallet' && <div className="mt-6 space-y-6">
            <p className="text-sm leading-7 text-muted-foreground">Connect the wallet assigned to your invitation. Connecting shares your address; it does not approve a transaction.</p>
            {state.session && <div className="rounded-lg border border-border p-5"><p className="mb-4 text-sm font-semibold">{state.session.campaign.name}</p><Address value={state.session.wallet} label="Assigned wallet" /></div>}
            <div className="flex items-start gap-3"><Wallet className="mt-1 size-5 shrink-0" aria-hidden="true" /><div className="min-w-0"><p className="font-semibold">{state.wallet.address ? 'Nightly connected' : 'Nightly for desktop'}</p><p className="mt-2 text-sm leading-6 text-muted-foreground">{demo ? 'This walkthrough uses an example wallet. No extension is opened.' : 'Use the Nightly desktop extension with Cookie selected. Mobile signing has not been verified.'}</p></div></div>
            {state.wallet.address && <><Address value={state.wallet.address} label="Connected wallet" /><p className="text-sm">Network: <strong>{state.wallet.genesisHash === COOKIE_GENESIS ? 'Cookie' : 'Select Cookie in Nightly'}</strong></p>{state.wallet.address !== state.session?.wallet && <p role="status" className="text-sm leading-6">This wallet does not match your pass. Select the assigned wallet in Nightly and reconnect.</p>}</>}
            <div className="flex flex-wrap gap-3"><Button disabled={busy || state.offline} onClick={() => void controller.connect()}>{state.wallet.address ? 'Reconnect Nightly' : demo ? 'Connect example wallet' : 'Connect Nightly'}</Button>{state.wallet.address && <Button variant="outline" disabled={busy} onClick={() => void controller.disconnect()}>Disconnect</Button>}</div>
            {!state.wallet.installed && !demo && <a href="https://nightly.app" target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold underline underline-offset-4">Get Nightly <ExternalLink className="size-4" aria-hidden="true" /></a>}
            {state.wallet.address && state.wallet.genesisHash !== COOKIE_GENESIS && <Button variant="outline" disabled={busy || state.offline} onClick={() => void controller.switchNetwork()}>Select Cookie network</Button>}
            <Button className="w-full" disabled={busy || !matched || state.uncertain} onClick={() => controller.continueFromWallet()}>Continue <ArrowRight aria-hidden="true" /></Button>
          </div>}
          {state.step === 'name' && <form className="mt-6" onSubmit={(event) => { event.preventDefault(); void controller.reserve(); }}>
            <p className="mb-7 text-sm leading-7 text-muted-foreground">A little identity for your wallet. Choose 4–32 letters, numbers or hyphens, with no hyphens at either end.</p>
            <label htmlFor="cook-name" className="text-sm font-semibold">Your name</label><div className="relative"><input id="cook-name" autoComplete="off" autoCapitalize="none" spellCheck={false} className={`${inputClass} pr-20`} value={state.name} maxLength={37} onChange={(event) => controller.editName(event.target.value)} placeholder="e.g. crumb" aria-describedby="name-help name-status" aria-invalid={state.name.length > 0 && !normalizeLabel(state.name)} disabled={busy || !matched} /><span className="pointer-events-none absolute top-6 right-4 font-serif text-lg text-muted-foreground">.cook</span></div>
            <p id="name-help" className="mt-3 text-xs leading-5 text-muted-foreground">Checking availability does not reserve a name on Cookie.</p>
            <div id="name-status" role="status" className="mt-4 min-h-12 text-sm leading-6">{state.checking ? 'Checking your name and sponsor coverage…' : state.quote && quoteFresh ? <span className="flex items-start gap-2"><Check className="mt-1 size-4 shrink-0" aria-hidden="true" />{state.quote.name}.cook is available. Your sponsor covers this quote.</span> : state.quote ? 'This quote expired. Check again for a fresh price.' : state.name && !normalizeLabel(state.name) ? 'Use 4–32 letters, numbers or internal hyphens.' : 'Your name check will appear here.'}</div>
            <div className="mt-5 flex flex-wrap gap-3"><Button type="submit" disabled={busy || state.offline || state.checking || !quoteFresh || !matched || state.uncertain}>Review my name <ArrowRight aria-hidden="true" /></Button><Button type="button" variant="outline" disabled={busy || state.offline || state.checking || !normalizeLabel(state.name)} onClick={() => void controller.checkName()}>Check again</Button></div>
            <button type="button" className="mt-5 min-h-11 text-sm underline underline-offset-4" onClick={() => controller.walletStep()}>Check connected wallet</button>
          </form>}
          {state.step === 'review' && state.attempt && <div className="mt-6 space-y-6">
            <p className="text-sm leading-7 text-muted-foreground">You’ll receive <strong className="break-all text-foreground">{state.attempt.name}.cook</strong> as your wallet’s primary name. Your sponsor pays for registration, setup and network fees.</p>
            <Address value={state.attempt.wallet} label="New owner" />
            <dl className="divide-y divide-border rounded-lg border border-border px-5 text-sm"><div className="flex flex-wrap justify-between gap-3 py-4"><dt>You pay</dt><dd className="font-mono font-semibold">0 COOK</dd></div><div className="flex flex-wrap justify-between gap-3 py-4"><dt>Sponsor covers up to</dt><dd className="font-mono">{formatCook(state.attempt.reservationNative)}</dd></div></dl>
            <details className="rounded-md border border-border px-4"><summary className="flex min-h-12 cursor-pointer items-center text-sm font-semibold">Coverage details</summary><dl className="space-y-3 pb-5 text-xs">{state.attempt.cost ? Object.entries({ 'Name registration': state.attempt.cost.registrationPrice, 'Name setup': (BigInt(state.attempt.cost.domainRent) + BigInt(state.attempt.cost.primaryRent)).toString(), 'Network fee': state.attempt.cost.transactionFee, 'Sponsor recovery allowance': state.attempt.cost.recoveryAllowance }).map(([label, value]) => <div key={label} className="flex flex-wrap justify-between gap-2"><dt>{label}</dt><dd className="font-mono">{formatCook(value)}</dd></div>) : <p>Refresh to load the stored coverage before approval.</p>}<div className="border-t border-border pt-3 leading-6"><dt>Network and program</dt><dd>Cookie · CookOven name registry</dd></div></dl></details>
            {!demo && <p className="rounded-md bg-secondary p-4 text-sm leading-6">{controller.executionEnabled ? 'Review this name and wallet before approving. Your approval lets the sponsor submit this registration on Cookie.' : 'Your preparation is saved. Wallet approvals are paused; you can still check saved progress.'}</p>}
            {!attemptFresh && <p role="status" className="text-sm">{demo ? 'This example quote expired. Restart the walkthrough for a fresh review.' : 'The preparation time has passed. Check saved progress to see whether it has been released before starting again.'}</p>}
            {!matched && <Button variant="outline" disabled={busy} onClick={() => controller.walletStep()}>Reconnect the assigned wallet</Button>}
            <Button className="w-full" disabled={busy || state.offline || !matched || !attemptFresh || !state.attempt.cost || !controller.executionEnabled || state.uncertain} onClick={() => void controller.approve()}>{demo ? 'Preview the approval' : 'Approve in Nightly'} <ArrowRight aria-hidden="true" /></Button>
            <p className="text-xs leading-5 text-muted-foreground">{demo ? 'The example continues without signing or sending a transaction.' : 'One explicit transaction approval. First Bite never asks for your recovery phrase.'}</p>
            {!demo && <Button variant="outline" disabled={busy || state.offline} onClick={() => void controller.refresh()}>Check saved progress</Button>}
          </div>}
          {state.step === 'progress' && state.attempt && <div className="mt-6">
            <p className="text-sm leading-7 text-muted-foreground">{demo ? 'Example status: ' : ''}{STATUS_COPY[state.attempt.status].detail}</p>
            {success ? <Result attempt={state.attempt} demo={demo} /> : <><ol className="my-7 space-y-5 text-sm">{['Approval received', 'Sent to Cookie', 'Confirmed by the network', 'Final ownership verified'].map((label, i) => { const reached = i === 0 ? !['prepared', 'expired'].includes(state.attempt!.status) : i === 1 ? ['submitted', 'confirmed'].includes(state.attempt!.status) : i === 2 ? state.attempt!.status === 'confirmed' : false; return <li key={label} className="flex items-center gap-3"><span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-input">{reached ? <Check className="size-4" aria-hidden="true" /> : <span className="size-1 rounded-full bg-muted-foreground" />}</span>{label}{reached && <span className="sr-only"> — reached</span>}</li>; })}</ol><div className="flex flex-wrap gap-3"><Button variant="outline" disabled={busy || state.offline} onClick={() => void controller.refresh()}>Check progress</Button>{['failed', 'expired'].includes(state.attempt.status) && <Button disabled={busy} onClick={() => controller.freshName()}>Choose a fresh name</Button>}{state.attempt.status === 'manual_review' && <Button variant="outline" disabled={busy || !controller.executionEnabled} onClick={() => void controller.retry()}>Request another check</Button>}</div></>}
            <details className="mt-7 border-t border-border pt-3 text-xs text-muted-foreground"><summary className="flex min-h-11 cursor-pointer items-center">Registration reference</summary><p className="break-all select-all font-mono leading-6">{state.attempt.id}</p><p className="mt-2">State: {state.attempt.status}{state.attempt.verifiedSlot !== null ? ` · Verified slot ${state.attempt.verifiedSlot}` : ''}</p></details>
          </div>}
          <p role="status" aria-live="polite" className="mt-5 min-h-6 text-sm text-muted-foreground">{state.busy ?? ''}</p>
          {demo && <p className="mt-5 text-xs text-muted-foreground">No name has been registered in this walkthrough. <a href="/preview" className="inline-flex min-h-11 items-center underline underline-offset-4">Start again</a></p>}
        </>}
      </section>
      <aside aria-label="Your First Bite pass" className="min-w-0 lg:pt-14"><div className="relative overflow-hidden rounded-2xl bg-pass text-pass-foreground"><div className="pass-grain pointer-events-none absolute inset-0" aria-hidden="true" /><div className="relative p-7 sm:p-9"><div className="flex items-center justify-between gap-3 text-xs uppercase tracking-widest"><span className="font-mono">First Bite</span><Cookie className="size-7" aria-hidden="true" /></div><p className="mt-12 text-xs uppercase tracking-widest">{success ? demo ? 'Example name' : 'Welcome to Cookie' : 'A place for your name'}</p><p className="mt-4 break-all font-serif text-4xl leading-tight">{name}.cook</p><p className="mt-10 text-sm">{state.session?.campaign.name ?? 'One invitation. A fresh start.'}</p></div><div className="relative flex items-center gap-3 border-t border-dashed border-current/40 p-7 text-sm sm:px-9">{success ? <CheckCircle2 className="size-5 shrink-0" aria-hidden="true" /> : <Ticket className="size-5 shrink-0" aria-hidden="true" />}<span>{demo ? 'Example pass · no registration' : success ? 'Ownership verified' : 'Sponsored name + network fees'}</span></div></div><p className="mt-5 text-xs leading-6 text-muted-foreground">Your wallet stays yours. The pass covers your first step.</p></aside>
    </div>
  </main>;
}
