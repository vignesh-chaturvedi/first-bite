export default function Loading() {
  return <main id="main" className="page-width grid min-h-96 gap-12 py-16 lg:grid-cols-2" aria-busy="true" aria-label="Loading First Bite"><div className="space-y-6 motion-safe:animate-pulse"><div className="h-4 w-40 rounded bg-muted" /><div className="h-28 max-w-md rounded bg-muted" /><div className="h-20 max-w-sm rounded bg-muted" /></div><div className="h-96 rounded-2xl bg-muted motion-safe:animate-pulse" /><span className="sr-only">Loading the page…</span></main>;
}
