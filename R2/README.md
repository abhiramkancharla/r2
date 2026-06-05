# R2

Ambient AI desktop companion. Behavior-aware, local-first, mostly silent.

See [CLAUDE.md](CLAUDE.md) for product principles.

## Stack

- Electron (main process) + Next.js Pages Router (renderer) + React + TypeScript
- `better-sqlite3` for local activity index, markdown vault for portable memory
- `active-win` for app/window tracking, Electron `powerMonitor` for idle
- Tailwind + Framer Motion for the floating orb UI

## Dev

```bash
npm install
npm run build:ax   # build Swift AX helper (once; rebuild on changes)
npm run dev        # runs Next + Electron together
```

First Electron launch on macOS will prompt for:

- **Screen Recording** — needed by `active-win` to read window titles
- **Accessibility** — needed for active window detection **and** AX message capture

Without Accessibility, the AX capture helper exits and no messages are logged.
Without Screen Recording, the activity tracker runs but `app`/`title` fields stay null.

## Capture (Feature 2)

R2 captures **user-typed messages only** on submit (Enter without modifiers + the
focused text field clears within 150ms). Source: a Swift sidecar
(`native/ax-helper`) reading the macOS Accessibility API.

- **Allowed:** any app/site **except** the blocklist
- **Blocked bundle IDs:** password managers (1Password, LastPass, Bitwarden,
  Dashlane), system Keychain, Wallet, Passwords, Mint, QuickBooks
- **Blocked window-title patterns:** banking/finance, login/2FA pages,
  brokerage/crypto, health portals, browser private-window markers
- **Redaction before disk write:** OpenAI/Anthropic/GitHub/AWS/Google keys,
  JWTs, PEM private keys, SSN, Luhn-valid credit cards
- **Visual indicator:** eye pupil tints amber for ~1.6s after each capture

Captured messages live in `userData/memory.db` (`messages` table + FTS5
index) and append to `~/R2Vault/messages/YYYY-MM-DD.md`.

## Layout

```
electron/        main process — tracker, memory, intervention engine
renderer/        Next.js Pages Router — floating orb UI
~/R2Vault/       user-owned markdown memory (created on first run, gitignored)
```

## Build

```bash
npm run build    # next build (static export) + tsc electron
npm start        # run packaged main
```
