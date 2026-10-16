# Pairy design guide

How the app applies the Pairy brand system v0.1 (the brand book). If this file and the brand book disagree, the brand book wins.

## Feel

Editorial, calm, physical. Warm paper, deep ink, lots of space, one orange signal. It should read like a well-set city guide, not a crypto dashboard. Nothing glows, nothing has a gradient, nothing bounces.

## Colour

| Token | Hex | Use |
|---|---|---|
| `ink` | `#0E1116` | Text, primary buttons, reversed blocks |
| `deep` | `#1B2230` | Hover on ink, secondary dark surfaces |
| `slate` | `#5A6275` | Secondary text, labels |
| `mist` | `#9AA0AF` | Disabled text, faint rules, faded serif words |
| `line` | `#E6E3DC` | Hairlines and borders |
| `paper` | `#F5F1EA` | Page background (the only theme) |
| `sand` | `#EEE9E0` | Panels and cards on paper |
| `beacon` | `#FF4E2B` | **Sparingly.** It always means *a peer is near*: map pins, the one action that moves a trade forward, the live city word |
| `success` / `warning` / `danger` | `#1F8A5B` / `#D49F1F` / `#C7402D` | Status only |

Two deliberate exceptions on the landing page: the floating nav pill is white with a soft shadow, and the hero's city list fades out with a mask. Nowhere else.

Rules: one beacon element per view where possible. Never beacon for decoration, links or icons. No gradients, no glows, no coloured shadows. No off-palette colours (no blues, purples, greens beyond `success`).

## Type

- **Space Grotesk** (`font-sans`): 95% of the UI. Display 700, headings 600, body 400. Tight tracking on large display (`tracking-tight`).
- **Newsreader Italic** (`font-serif italic`): the editorial accent. Headlines, taglines, pull-quotes, one or two words inside a headline (`Trade <em>in person.</em>`). **Never in buttons, never in body copy, never below 24 px.**
- **JetBrains Mono** (`font-mono`): amounts, rates, addresses, hashes, timers, eyebrows (`.eyebrow` = 11 px uppercase, 0.18em tracking, slate).

Headlines end with a full stop. Sentence case everywhere except eyebrows.

## Shape and layout

- Buttons are pills (`rounded-full`). Primary = ink. Beacon only for the forward action of a trade step.
- Panels: `bg-sand`, `rounded-xl` at most, no shadow, or a `border-line` hairline on paper. Don't nest cards in cards.
- Prefer hairline dividers and whitespace over boxes. Generous vertical rhythm (`space-y-10`+ between sections on pages).
- No icon-in-a-coloured-circle tiles, no emoji, no badges sprinkled for decoration. Icons (lucide) only where they carry meaning, 16 px, stroke 1.5, ink or slate.
- Data rows: label in `.eyebrow`, value in mono, right-aligned numbers.
- **App icon (the default everywhere: favicon, home screen, PWA, avatars):** the ink Waypoint on a Line (`#E6E3DC`) rounded square, corner radius 22% (`assets/app-icon.svg`). The white and ink variants exist for places where Line clashes, but Line is the default. The favicon (`app/icon.svg`) uses a heavier ring and dot so it survives 16 px; the Apple touch icon is full-bleed because iOS rounds its own corners.
- The Waypoint (`components/brand/waypoint.tsx`) is the only logo. Don't redraw it, offset the dot, recolour it off-palette or put it on busy backgrounds.

## Voice: plain, local, never crypto jargon

Short sentences. Concrete numbers. Name the city. Sound like a friend giving directions.

| Say | Not |
|---|---|
| peer, buyer, seller | counterparty |
| meet, venue, the meeting point | rendezvous, coordinates |
| lock the XLM / it's locked for you | create a claimable balance / escrowed on-chain |
| claim it / take it back | execute claim / release funds |
| Settled. The XLM is in your wallet. | Transaction confirmed on-chain. Funds released from escrow. |
| receipt (with the stellar.expert link) | transaction hash |
| rate | price feed, liquidity |

Never: counterparty, liquidity, on-ramp, gas, Web3, DeFi, degen, moon.

### Where precision still wins

These are SOW evidence and must stay explicit, just in plain words:

- **The lock screen states the bound:** once the seller locks, the buyer can claim at any moment in the next 72 hours whether or not the cash has changed hands; lock only when you are both at the meeting point.
- **Honesty about status:** testnet only, no real money, Pairy holds no key and cannot move the funds. Never imply live users, cities "served", volumes or a product in use.
- **Proof is always one tap away:** every lock / claim / reclaim shows a receipt link to stellar.expert, set in mono. Technical terms (claimable balance, `BEFORE_RELATIVE_TIME`, CAP-23) may appear only inside a collapsed "How this is enforced" / proof section, never in headlines or buttons.
