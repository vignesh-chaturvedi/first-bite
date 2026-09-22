# First Bite brand assets

The user selected logo concept 3: the dark forest-green bitten circle with a
detached sage crumb. The isolated symbol retains the curved bite and crumb of
that selection. Use the icon with the text wordmark in the website header; keep
the original logo for standalone presentations.

## Files

| Asset | Dimensions | Use |
| --- | --- | --- |
| `public/brand/first-bite-logo.png` | 1254 × 1254 | Original selected concept, symbol and wordmark; transparent PNG |
| `public/brand/first-bite-readme.png` | 512 × 512 | Selected logo and wordmark on cream for legibility in both GitHub themes |
| `public/brand/first-bite-symbol.png` | 512 × 512 | Isolated symbol; transparent PNG |
| `src/app/favicon.ico` | 16, 32 and 48 px | Browser favicon, with a cream background for contrast on browser tabs |
| `src/app/icon.png` | 32 × 32 | PNG browser icon, with a cream background |
| `src/app/apple-icon.png` | 180 × 180 | Apple touch icon, with an opaque cream background |

Next.js discovers the three files in `src/app` and emits their metadata links
automatically. The selected original and isolated symbol both have an actual
alpha channel. The icon background is `#f7f5ef`.

## Provenance and editing

Both the original concept and the isolated production symbol were created with
the built-in image-generation tool. No fallback API was used. The selected
original is copied without modification; the production symbol is resized from
the isolated output. Sharp performs only technical resizing and PNG conversion,
plus flattening against cream for the README, browser and Apple icons. The README
asset preserves the original square composition without cropping. The ICO container
includes the three resized PNG representations. No programmatic tracing or
redrawing was used.

### Original selected concept prompt

> Use case: logo-brand. Create one polished original logo concept for "first
> bite", a sponsored onboarding app on Cookie Chain that gives a newcomer their
> first .cook identity. This is a brand-logo design exploration, not a website
> mockup. Square 1024x1024 presentation. Flat clean vector-style shapes, sharp
> edges, exceptionally simple memorable silhouette, generous negative space.
> Existing brand palette: forest green #243e32 and warm cream #f7f5ef with sage
> #dbe5ce only if useful. Solid cream background. A single large standalone
> symbol centered in the upper-middle area, with the exact lowercase wordmark
> "first bite" underneath in refined, carefully spaced typography. The icon
> must have the simplicity and thickness to remain recognizable as a 16px
> favicon. No other text, no tagline, no watermark, no numbered labels, no
> shadow, no gradient, no texture, no 3D, no device mockups, no stock crypto
> hexagons, chain links or currency symbols. Do not use a cookie outline with
> scattered chocolate dots like a generic icon library.
>
> Direction THREE: A bold, almost circular solid forest-green disc with one
> large artfully shaped bite removed from the upper right. The bite's negative
> space should subtly form a forward-pointing notch, hinting at a first step.
> Add just ONE small separated sage crumb above and to the right, precisely
> aligned, like the beginning of motion. No chocolate dots or outline drawing.
> The shape must feel like an ownable editorial symbol, balancing boldness with
> friendliness, exceptionally clean strong favicon silhouette. The wordmark
> below is a compact custom-feeling soft geometric lowercase sans-serif. This
> is an abstract bite emblem, clearly different from a letter monogram and a
> rectangular pass.

The delivered concept has a transparent background and a 1254 × 1254 canvas;
the table describes the delivered files rather than the requested dimensions.

### Production symbol edit prompt

> Use case: background-extraction. Asset type: transparent production website
> logo and favicon symbol. Input image 1 is the exact selected First Bite logo;
> edit target. Keep ONLY its existing green bitten-circle symbol and its one
> detached light sage circular crumb, preserving the exact curved swooping bite
> cutout, original outline geometry, same crumb position relative to the disc,
> original colors (#243e32 forest green and light sage), and visual identity.
> Remove the entire 'first bite' wordmark below it, leaving no text or lettering.
> Put this original icon alone centered on a genuinely transparent alpha
> background, square canvas 1024 x 1024, enlarge proportionally so the symbol
> plus crumb fits within the center 88% of the square with balanced modest
> transparent padding. Do not redesign, do not add shapes, do not draw a
> different bite, do not add dots, outline, shadows, texture, highlights,
> gradients, 3D, mockup, checkerboard, solid background or border. Flat crisp
> vector-style edges. Preserve the actual transparent alpha channel.

The isolated output is 1254 × 1254 before resizing. It preserves the selected
concept's lightly shaded fill; these are raster assets, not editable vectors.
