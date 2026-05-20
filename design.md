# MyKey Design System

This document defines the visual direction for MyKey after the UI refresh inspired by
`consenlabs/token-ui`. Treat it as the local product design contract for future UI work.

Reference: `consenlabs/token-ui` uses a calm wallet interface language built around clean white
surfaces, soft neutral cards, Primary Blue, cyan brand moments, Inter/Noto Sans typography, pill
actions, and token-driven component styling. MyKey adopts that language for an AI asset vault:
trustworthy, local-first, dense enough for management work, and calm enough for security-sensitive
flows.

## Product Tone

MyKey is an AI asset vault for API keys, providers, app bindings, prompts, usage monitoring, voice
input history, and crypto wallets. The interface should feel like a secure wallet for AI operations,
not a marketing site.

Core principles:

- Clarity over decoration: data, actions, and security state must be easy to scan.
- Local control: copy, import, routing, wallet, and settings actions should feel deliberate.
- Wallet calm: use light surfaces, clear state chips, and restrained blue emphasis.
- Operational density: dashboards and manager views can be compact, but spacing must remain orderly.
- One primary action family: use Primary Blue for active navigation, CTAs, progress, links, and focus.

## Design Tokens

The canonical runtime tokens live in [src/index.css](/Users/thursday/go/play/mykey/src/index.css).
When changing colors, shadows, radius, or typography, update this document if the meaning changes.

### Brand

| Role | Token | Value | Use |
| --- | --- | --- | --- |
| Primary Blue | `--accent` | `#007fff` | CTAs, active nav, links, focus, primary progress |
| Primary Hover | `--accent-dark` | `#006cd9` | Hover and emphasized blue text |
| Primary Active | `--accent-active` | `#0052a5` | Pressed states and deep blue text |
| Secondary Cyan | `--brand-secondary` | `#0cc5ff` | Brand gradients, dashboard highlights, chart accents |
| Accent Surface | `--accent-soft` / `--surface-blue` | `#e7f1fc` | Selected surfaces, badges, soft callouts |

Do not introduce orange as a primary UI color. Warning states may use the warning token family, but
selected states should stay blue.

### Surfaces

| Role | Token | Value | Use |
| --- | --- | --- | --- |
| Page | `--bg` | `#ffffff` | App canvas |
| Card | `--panel` | `#f8f9fa` | Panels and cards |
| Input / Secondary | `--panel-alt` | `#f0f1f3` | Inputs, secondary buttons, low emphasis blocks |
| Border | `--border` | `#ecedf1` | Default structural border |
| Strong Border | `--border-strong` | `#cfd2db` | Dashed empty states and stronger separation |

Use white and cool gray as the base. Avoid warm beige, cream, and orange-heavy surfaces.

### Text

| Role | Token | Value | Use |
| --- | --- | --- | --- |
| Primary text | `--text` | `#111d4a` | Headings and core body copy |
| Muted text | `--muted` | `#99a1af` | Labels, descriptions, metadata |
| Strong muted | `--muted-strong` | `#475467` | Important secondary copy |

Typography stack:

```css
font-family: "Inter", "Noto Sans SC", ui-sans-serif, system-ui, -apple-system, sans-serif;
```

Use Inter for Latin text and Noto Sans SC for Chinese. Do not add a separate display font.

### Radius And Shadow

| Token | Value | Use |
| --- | --- | --- |
| `--radius-sm` | `8px` | Small controls |
| `--radius-md` | `12px` | Rows, chips, fields |
| `--radius-lg` | `16px` | Panels and modals |
| `--radius-xl` | `20px` | Auth and high-emphasis cards |
| `--radius-pill` | `999px` | Buttons, chips, segmented controls |
| `--shadow` | soft navy card shadow | Default cards |
| `--shadow-cta` | blue CTA shadow | Primary actions |

Cards may use 12-20px radius. Primary actions should be pill-shaped.

## Layout Rules

### App Shell

- Sidebar width is fixed and compact.
- Content area owns scroll. Avoid page-level scroll traps.
- Header uses a concise title, a one-line description, and right-aligned actions.
- Main views should use panels and grids, not landing-page sections.

### Dashboard

The dashboard should read like a wallet overview:

- Top summary uses a soft blue/cyan wash.
- KPI cards stay compact and scannable.
- Provider usage cards use a subtle colored left rule and clear quota/cost sections.
- Empty and error states should use dashed borders and muted blue or semantic feedback colors.

### Manager Views

Keys, providers, projects, apps, prompts, MCP, skills, and settings are operational tools:

- Use list/detail or grid/detail patterns.
- Rows should have stable height and clear selected states.
- Selected states use `--surface-blue` and `--accent`.
- Search, filter chips, tabs, and segmented controls must use visible focus states.
- Keep destructive actions visually separate and use the destructive token family.

### Crypto Wallet View

The crypto wallet view can stay closest to token-ui:

- Use Primary Blue for wallet CTAs.
- Use circular token avatars.
- Use soft card shadows and blue surface badges.
- Token lists should prioritize symbol, amount, fiat value, and chain/account context.

## Component Guidance

### Buttons

Primary:

- Background: `--accent`
- Text: white
- Radius: pill
- Minimum height: 40px
- Shadow: `--shadow-cta`

Secondary:

- Background: `--panel-alt`
- Text: `--text`
- Border: `--border`
- Radius: pill

Link:

- Text: `--accent`
- Underline is acceptable for inline links.

### Inputs

- Background should be `--panel-alt` or `--panel`.
- Focus ring: `0 0 0 3px rgba(0, 127, 255, 0.14)`.
- Avoid harsh black borders.
- Placeholder text should use muted color.

### Chips And Badges

- Use pill radius.
- Active/selected chips use `--surface-blue`, `--accent`, and a blue border.
- Success, warning, critical, and depleted states use the semantic status tokens.

### Panels And Cards

- Default panel: `--panel`, `--border`, `--shadow`, radius `--radius-lg`.
- Detail sections can use white translucent surfaces inside panels.
- Avoid nested decorative cards. Nested cards are allowed only when they represent real repeated
  items, sections, or modal content.

## Accessibility And Interaction

- All interactive controls need visible hover and focus states.
- Do not rely only on color for critical status. Include labels such as enabled, disabled, warning,
  depleted, copied, or failed.
- Text must fit its container at 768px and desktop widths.
- Avoid negative letter spacing in compact UI.
- Use icons only when they improve recognition. Text labels are acceptable for management actions.

## Alchemy Integration

- Use Alchemy as an optional RPC preset for EVM read/write operations, starting with Ethereum
  Mainnet and expanding through the documented network identifier format:
  `https://{networkIdentifier}.g.alchemy.com/v2/{apiKey}`.
- Do not hardcode real API keys in source, tests, docs, or screenshots. Store keys only in local
  runtime state or user-controlled secret storage.
- Link operators to the official Alchemy docs: `https://www.alchemy.com/docs`.
- Watch-only wallets should use Alchemy for read paths only:
  - Native ETH: `eth_getBalance`
  - ERC-20 discovery: `alchemy_getTokenBalances`
  - Token metadata: `alchemy_getTokenMetadata`
- Watch-only wallets must never expose Send/signing controls as available actions.
- Initial Alchemy presets should cover Ethereum, Base, Arbitrum, Optimism, and Polygon mainnets,
  plus their commonly used Sepolia/Amoy testnets where supported.

## OKLink Integration

- Use OKLink as an optional Explorer data source for watch-only wallets and portfolio enrichment.
- Do not hardcode OKLink API keys in source, tests, docs, or screenshots. Store keys only in local
  runtime state or user-controlled secret storage.
- Link operators to the official OKLink Explorer docs:
  `https://www.oklink.com/docs/zh/#explorer-introduction`.
- Explorer requests use the `Ok-Access-Key` request header.
- Initial read paths:
  - Native summary: `/api/v5/explorer/address/address-summary`
  - Token balances: `/api/v5/explorer/address/token-balance`
- Treat OKLink as best-effort. If Explorer API access is unavailable or suspended for a key, keep
  the wallet usable with Alchemy/RPC fallbacks.

## Implementation Checklist

Before completing a UI change:

- Check that new colors map to existing tokens in `src/index.css`.
- Confirm selected states are blue, not orange.
- Run `npm run build`.
- For frontend-visible changes, preview the app in the browser.
- If behavior changes, update user-facing docs under `docs` when relevant.

## Notes

The product spec path listed in `AGENTS.md` currently was not present in this checkout:
`/Users/thursday/go/play/mykey/Docs_code/Mykey 产品文档.md`. If that file is restored later and it
conflicts with this design system, prefer the product spec and update this document with the smallest
necessary adjustment.
