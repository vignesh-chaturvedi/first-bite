import { Sparkles } from 'lucide-react';

export function CookieWelcomeSeal() {
  return <span className="welcome-seal pointer-events-none isolate flex size-24 flex-col items-center justify-center text-center text-xs leading-4 sm:size-28" aria-hidden="true">
    <svg className="absolute inset-0 size-full" viewBox="0 0 120 120" fill="none" aria-hidden="true" focusable="false">
      {/* The three inward curves are the bite itself, leaving the edge transparent. */}
      <path
        d="M76 7C63 3 48 4 36 9C18 17 7 33 5 51C2 69 8 85 21 98C34 111 50 117 68 114C87 111 103 99 111 82C117 69 118 54 113 43C109 54 95 56 87 44C77 49 67 38 73 28C61 24 64 11 76 7Z"
        fill="var(--cookie)"
        stroke="var(--cookie-ink)"
        strokeOpacity=".32"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      <g fill="var(--cookie-ink)" opacity=".5">
        <path d="M27 25C29 23 34 25 35 28L32 34C29 36 24 33 24 30Z" />
        <path d="M16 60C18 57 23 59 24 62L22 68C18 70 14 66 16 60Z" />
        <path d="M39 94C42 90 46 92 48 96L45 102C40 103 37 99 39 94Z" />
        <path d="M96 74C100 73 103 77 101 81L96 85C92 84 91 79 96 74Z" />
      </g>
      <g fill="var(--cookie-ink)" opacity=".2">
        <circle cx="49" cy="18" r="1.4" />
        <circle cx="17" cy="43" r="1.2" />
        <circle cx="76" cy="99" r="1.5" />
      </g>
    </svg>
    <span className="relative flex -translate-x-1 translate-y-1 flex-col items-center">
      <Sparkles className="mb-1 size-4" strokeWidth={1.5} />
      <span>A little<br /><strong>welcome.</strong></span>
    </span>
  </span>;
}
