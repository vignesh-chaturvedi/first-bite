# First Bite visual direction

Status: updated with the user's selected bite logo and visual refresh.

Warm paper, readable forest-green text, sage passes and toasted-caramel accents.
The product is a small invitation to Cookie, with a tangible pass as the central
visual. Use generous spacing, frosted surfaces and a clear reading order.

- Logo: the approved bitten circle and detached sage crumb. Use the shared
  `BiteSymbol`/`BrandMark` components rather than a generic cookie icon. Standalone
  exports and prompts are documented in [brand assets](docs/brand-assets.md).
- Light: paper #f8f4eb, surface #fffdf7, ink #243e32, muted ink #5d695e,
  green #315b44, secondary surface #eee9dd, border #dcdacf,
  cookie accent #eed2a4 with readable accent ink #855121.
- Dark: paper #171e19, surface #222e25, ink #e9eee7, muted ink #bdc9bb,
  green #adcfae, secondary surface #303b2f, border #465143,
  cookie accent #654b2b with readable accent ink #e7bd84.
- Display: Georgia or its local serif fallback. Body: system sans. Labels and
  amounts: local monospace only where it aids reading. No external font requests.
- Voice: plain, welcoming and specific. Explain what the user gets, what is
  covered and when an action is available. Never imply a preview performed a
  wallet action or issued a real pass.
- Layout: desktop split hero with a layered invitation pass; compact single
  column on mobile. Frosted panels have an opaque fallback. Buttons are pill
  shaped; panels use consistent generous radii. Buttons and links use visible
  focus outlines and at least 44px targets.
- Motion: 150ms general button feedback, a 360ms sliding invitation arrow and a
  400ms decorative pass entrance. The pass floats once, ending at 4.6 seconds,
  then responds to hover with a lift, layered tilt and passing highlight.
  Content and actions are available immediately. Hover movement is limited to
  hover-capable devices; all nonessential motion respects reduced motion.
  See [motion notes](docs/hero-motion.md) for reference and timing decisions.
- Welcome seal: a caramel cookie with a transparent scalloped bite and subtle
  chips. Keep the wording clear of the missing edge. This decorative seal uses
  its own SVG silhouette; the approved First Bite logo remains the brand mark.

The website, onboarding journey, favicon and README share the same bite symbol.
This refresh changes presentation, not transaction or worker behavior.
