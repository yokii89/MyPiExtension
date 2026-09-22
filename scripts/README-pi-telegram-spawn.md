# pi-telegram-spawn

Local operator helper: open a **visible** Pi in a working directory and auto-connect Telegram.

This creates a **new Pi instance + new Telegram thread** (Threaded Mode follower).  
It is **not** same-thread session `/new`.

## Usage (Windows)

```powershell
# From any directory; defaults to current location
./scripts/pi-telegram-spawn.ps1

# Explicit project cwd
./scripts/pi-telegram-spawn.ps1 -Cwd D:\Code\foo

# Open Pi only; connect manually
./scripts/pi-telegram-spawn.ps1 -NoAutoConnect
```

## Usage (Git Bash / macOS / Linux)

```bash
./scripts/pi-telegram-spawn.sh
./scripts/pi-telegram-spawn.sh --cwd /path/to/project
./scripts/pi-telegram-spawn.sh --no-auto-connect
```

## How auto-connect works

The script launches Pi with:

```text
PI_TELEGRAM_AUTO_CONNECT=1
```

`pi-telegram` reads that env on `session_start`. When this process does not already own or resume transport, it runs the same connect path as `/telegram-connect`:

- no live leader → become leader
- live leader present → register as follower (new thread)
- classic live-owner conflict → **does not** force takeover; reports failure

## After spawn

1. A new terminal window/tab opens running `pi`.
2. On success, Telegram gets a new thread for the new instance.
3. Keep or close the old thread manually (`/telegram-disconnect` or close that Pi).

State stamp:

```text
~/.pi/agent/tmp/telegram/last-spawn.json
```

## Requirements

- Threaded Mode available on the bot (for a second window)
- Leader already connected (for follower registration)
- After changing `pi-telegram` sources, **reload/restart the leader** so transport-side fixes load
