# R2

A behavior-aware desktop companion for macOS. Quietly watches what you do, builds a local memory of your work and interests, and occasionally surfaces something useful. Mostly silent. Fully local.

AI has context about you before you even start your conversation. 

---

## Install (2 minutes)

### 1. Download the latest release

Go to [Releases](https://github.com/abhiramkancharla/r2/releases/latest) and grab `R2-x.y.z-arm64.dmg` (Apple Silicon — M1/M2/M3/M4).

### 2. Install the app

Double-click the DMG → drag **R2.app** into **Applications** → eject the DMG.

### 3. Open it

Open **R2** from Applications or Spotlight. A small floating orb appears in the bottom-right of your screen.

> **First launch warning?** If macOS says "R2 cannot be opened because the developer cannot be verified," right-click the app in Applications → **Open** → **Open**. Only needed once.

### 4. Grant permissions

On first launch macOS will ask for two permissions. Both are required:

| Permission           | Why R2 needs it                                                   |
| -------------------- | ----------------------------------------------------------------- |
| **Accessibility**    | Read the focused text field so R2 can log sentences you submit    |
| **Screen Recording** | Read the active window title + app name (no images are stored)    |

Go to **System Settings → Privacy & Security** → toggle R2 ON in both lists. Restart R2 once after granting.

### 5. Install a local LLM

R2 reasons locally via [Ollama](https://ollama.com). One-time setup:

```bash
# Install Ollama
brew install ollama
ollama serve            # leave running in a terminal tab (or use Ollama.app)

# Pull the models R2 expects
ollama pull qwen2.5:14b   # main model
ollama pull qwen2.5:7b    # fallback (smaller, faster)
```

> Have less RAM? Use just `qwen2.5:7b` for both main and fallback.

### 6. Configure in R2

The orb starts **red** until R2 verifies an LLM works.

1. Hover the orb → click **Configure**.
2. Fill in:
   - **Main model**: `qwen2.5:14b` (or whichever you pulled)
   - **Fallback model**: `qwen2.5:7b`
   - **Ollama URL**: `11434` (port) or `http://127.0.0.1:11434`
3. Click **Save**. R2 sends a test request.
   - ✅ Orb turns **black** = ready
   - ❌ Stays red with an error = your message/port is wrong, or the model isn't pulled. Fix and save again.

That's it. R2 is now watching, quietly.

---

## What R2 actually does

- **Tracks your activity locally.** Active app, window title, idle vs. focused, app-switching patterns. Stored in a SQLite DB in your user folder. Never leaves your Mac.
- **Captures what you submit.** Press Enter in a chat box, search bar, comment — R2 logs the sentence. Filters out password managers, banking, 2FA pages, and redacts API keys / cards / SSNs before writing to disk.
- **Builds a markdown memory vault.** Daily diaries, weekly persona snapshots, conversation summaries, project notes — all human-readable markdown in `~/R2Vault` and `~/Downloads/R2Obsidian`. Editable. Portable. Yours.
- **Stays silent by default.** No notification spam. Maybe one intervention every few hours — only when context is strong enough to justify breaking your focus.
- **Cinematic, ambient UI.** Floating R2-D2-style eye. Reacts to cursor, blinks, glows blue while thinking, red when something is wrong. No dashboards. No panels.
- **Auto-updates.** New versions ship through GitHub Releases. R2 checks on launch and every 6h, downloads in the background, asks before relaunching.

---

## Where your data lives

Everything is local. Nothing syncs anywhere by default.

```
~/R2Vault/             markdown memory (sessions, conversations, diaries, persona)
~/Downloads/R2Obsidian/  Obsidian-friendly mirror (Daily, Projects, forms, etc.)
~/Library/Application Support/R2/
  ├── memory.db        SQLite activity + message index
  └── config.json      LLM endpoint + model names
```

Inspect, edit, back up, move anywhere. R2 reads from these — they're the source of truth.

If R2Vault or R2Obsidian already exist when you install, **R2 leaves them alone** and only fills in any missing subfolders.

---

## Updating

R2 auto-updates from GitHub Releases. When a new version is downloaded you'll see:

> **R2 Update Ready** — Install Now / Later

Click **Install Now** and the app relaunches into the new version. **Later** applies the update on next quit.

To check what version you have, look at `package.json` or the **About** menu (coming soon).

---

## Troubleshooting

**Orb stays red after Save.**
The Configure dialog shows the actual error. Common ones:

- `Model "qwen2.5:14b" is not pulled` → run `ollama pull qwen2.5:14b`
- `Could not reach Ollama at http://127.0.0.1:11434` → Ollama isn't running. `ollama serve` in a terminal, or open the Ollama.app.
- `Ollama HTTP 500` → restart Ollama; you may be out of RAM.

**Eye doesn't capture my typing.**
Accessibility permission isn't granted. System Settings → Privacy & Security → Accessibility → toggle R2 ON → quit and reopen R2.

**No window title or app name in sessions.**
Screen Recording permission isn't granted. Same place, different list.

**Orb is gone.**
It lives bottom-right. If hidden behind other windows it still receives events — quitting and reopening from Spotlight always brings it back.

**Want to nuke local memory?**
Quit R2, delete `~/Library/Application Support/R2/memory.db` and `~/R2Vault/` and `~/Downloads/R2Obsidian/`. Next launch starts fresh.

---

## System requirements

- **macOS 13 (Ventura) or later**
- **Apple Silicon (M1/M2/M3/M4)** — arm64 build only
- **8 GB RAM minimum** (16 GB+ recommended for `qwen2.5:14b`)
- **Ollama** for local LLM inference

---

## Privacy

- All capture, memory, and LLM inference happens on your Mac.
- No telemetry, no analytics, no cloud sync.
- Auto-update is the only network call R2 makes by itself — a GET to GitHub's release feed.
- Source code is in this repo. Audit anything.

---

## For developers

```bash
git clone https://github.com/abhiramkancharla/r2.git
cd r2/R2
npm install
npm run build:ax       # build the Swift AX sidecar (once)
npm run dev            # Next.js + Electron in dev mode
```

Build a signed-and-notarized DMG locally:

```bash
source ~/.r2-build.env  # GH_TOKEN, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
npm run dist            # local build, no upload
npm run dist:publish    # build + upload to GitHub Releases
npm run dist:sideload   # sign only, skip notarize (fallback when Apple notarytool is flaky)
```

---

## License

MIT
