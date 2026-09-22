# Invitation motion and cookie seal

The homepage pass now has a short entrance and one gentle float. Hovering lifts
and straightens the front card, opens the angle of the backing card, turns the
cookie seal slightly and sweeps a soft highlight completely off the card.
The illustration is decorative and does not acquire keyboard focus or imply
that it can be clicked to register a name.

The invitation CTA retains a real link to `/start`. Its stable label sits beside
a recessed capsule containing an arrow. Hover or keyboard focus slides that
arrow to the other end, warms its background to caramel, and rotates the arrow
toward the destination. Pointer exit/focus loss reverses the transition from its
current position. Press feedback remains on the outer button. There is no toggle
state, delayed navigation, additional client JavaScript or animation dependency.

The welcome seal uses a single SVG cookie outline with three concave bite curves,
so the removed area is truly transparent over the card and page. Chips sit near
the perimeter. The wording and decorative sparkle stay clear of the bite.

## Reference and deliberate adaptation

Source: Abron Studio's [Toggle Button Micro-interaction](https://dribbble.com/shots/23784648-Toggle-Button-Micro-interaction).
The publicly served clip was inspected locally: 1600 × 1200, 60 fps, 161 frames,
2.683333 seconds. A 6 fps contact sheet and a 20 fps crop of the opening transition
show a circular puck traveling inside a recessed pill. Its core warms as it
slides, then the surroundings transition from dark to light; later it reverses.
The shape of the track stays stable while the puck moves. It is a demonstration
of a toggle; the clip does not establish actual pointer hover behavior.

First Bite adapts the sliding, inset depth and warming-color idea. It uses sage,
cream and caramel rather than metallic materials or a full-page theme change.
The 360ms duration and settling curve below are chosen for a compact hover CTA;
they are not claimed to reconstruct the source's exact easing.

| Element | Motion | Timing |
| --- | --- | --- |
| Button body | 2px hover lift, 1px press and 0.98 scale | 150ms ease-out |
| Arrow capsule | 26px slide, 45° arrow turn, caramel color | 360ms; cubic-bezier(.22, 1, .36, 1) for transforms |
| Pass entrance | 12px rise with a small rotation and opacity | 400ms ease-out |
| Pass float | 9px rise and return, one cycle | 4200ms ease-in-out, after entrance |
| Hovered pass | 8px lift; front 3° → 0°, backing −7° → −10° | 400ms settling curve |
| Cookie seal | 3px right / 6px up; 10° → −6° | 400ms settling curve |
| Pass highlight | Crosses the card and exits fully | 650ms settling curve |

All transforms, animations and transitions are inside
`prefers-reduced-motion: no-preference`. The remaining focus outline is static.
The automatic entrance/float finishes at 4.6 seconds; nothing loops forever.
Hover-specific movement is restricted to hover-capable devices. Disabled wallet
approval controls retain their existing appearance and behavior.

## Reproducing the reference inspection

The clip and frame sheets are temporary research files, not shipped assets.

```sh
curl -L --fail 'https://cdn.dribbble.com/userupload/13461395/file/original-aa614ff6abc6c31779413728a30f7699.mp4' -o /tmp/first-bite-motion-reference/toggle.mp4
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate,duration,nb_frames -of default=nw=1 /tmp/first-bite-motion-reference/toggle.mp4
ffmpeg -i /tmp/first-bite-motion-reference/toggle.mp4 -vf 'fps=6,scale=400:300,tile=4x4' -frames:v 1 /tmp/first-bite-motion-reference/overview.png
ffmpeg -i /tmp/first-bite-motion-reference/toggle.mp4 -vf "crop=880:600:380:280,select='between(n,0,42)*not(mod(n,3))',scale=352:240,tile=3x5" -frames:v 1 -fps_mode passthrough /tmp/first-bite-motion-reference/transition.png
```

The crop is derived from the overview's quarter-scale track bounds
(x 95–315, y 70–220). This ffmpeg version uses `-fps_mode passthrough` instead of
the removed `-vsync 0` option.
