#!/usr/bin/env bash
# Local helper: open a visible Pi in a cwd and auto-connect Telegram.
# Operator tooling for Threaded Mode "new instance / new thread".
# Not same-thread session /new.
#
# Usage:
#   ./scripts/pi-telegram-spawn.sh
#   ./scripts/pi-telegram-spawn.sh --cwd /path/to/project
#   ./scripts/pi-telegram-spawn.sh --no-auto-connect

set -euo pipefail

CWD="$(pwd)"
PROFILE=""
AUTO_CONNECT=1
PI_COMMAND="${PI_COMMAND:-pi}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cwd)
      CWD="${2:-}"
      shift 2
      ;;
    --profile)
      PROFILE="${2:-}"
      shift 2
      ;;
    --no-auto-connect)
      AUTO_CONNECT=0
      shift
      ;;
    --pi)
      PI_COMMAND="${2:-}"
      shift 2
      ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ ! -d "$CWD" ]]; then
  echo "Working directory does not exist: $CWD" >&2
  exit 1
fi

CWD="$(cd "$CWD" && pwd)"
STATE_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/tmp/telegram"
mkdir -p "$STATE_DIR"
STATE_PATH="$STATE_DIR/last-spawn.json"
STAMP="$(date +%s)000"

cat >"$STATE_PATH" <<EOF
{
  "cwd": $(printf '%s' "$CWD" | python -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '"%s"' "${CWD//\"/\\\"}"),
  "profile": $(if [[ -n "$PROFILE" ]]; then printf '"%s"' "$PROFILE"; else echo null; fi),
  "autoConnect": $([[ "$AUTO_CONNECT" == "1" ]] && echo true || echo false),
  "createdAtMs": $STAMP,
  "platform": "unix-like"
}
EOF

export_env=()
if [[ "$AUTO_CONNECT" == "1" ]]; then
  export_env+=(PI_TELEGRAM_AUTO_CONNECT=1)
fi
if [[ -n "$PROFILE" ]]; then
  export_env+=(PI_TELEGRAM_AUTO_CONNECT_PROFILE="$PROFILE")
fi

echo "Spawning Pi in: $CWD"
echo "State written: $STATE_PATH"
if [[ "$AUTO_CONNECT" == "1" ]]; then
  echo "PI_TELEGRAM_AUTO_CONNECT=1 (connects on session start)"
else
  echo "Auto-connect disabled; run /telegram-connect manually in the new terminal."
fi

run_pi() {
  if [[ ${#export_env[@]} -gt 0 ]]; then
    env "${export_env[@]}" "$PI_COMMAND"
  else
    "$PI_COMMAND"
  fi
}

# Prefer Windows Terminal when available (Git Bash / MSYS).
if command -v wt.exe >/dev/null 2>&1; then
  if [[ "$AUTO_CONNECT" == "1" ]]; then
    wt.exe -w 0 new-tab --title pi-telegram-spawn -d "$CWD" cmd.exe /c "set PI_TELEGRAM_AUTO_CONNECT=1&& ${PI_COMMAND}"
  else
    wt.exe -w 0 new-tab --title pi-telegram-spawn -d "$CWD" "$PI_COMMAND"
  fi
  echo "Launched via Windows Terminal."
  exit 0
fi

if command -v osascript >/dev/null 2>&1; then
  ENV_PREFIX=""
  if [[ "$AUTO_CONNECT" == "1" ]]; then
    ENV_PREFIX="export PI_TELEGRAM_AUTO_CONNECT=1; "
  fi
  osascript -e "tell application \"Terminal\" to do script \"cd $(printf %q "$CWD"); ${ENV_PREFIX}${PI_COMMAND}\""
  echo "Launched via macOS Terminal."
  exit 0
fi

if command -v gnome-terminal >/dev/null 2>&1; then
  if [[ "$AUTO_CONNECT" == "1" ]]; then
    gnome-terminal --working-directory="$CWD" -- bash -lc 'export PI_TELEGRAM_AUTO_CONNECT=1; exec '"$PI_COMMAND"
  else
    gnome-terminal --working-directory="$CWD" -- bash -lc "exec $PI_COMMAND"
  fi
  echo "Launched via gnome-terminal."
  exit 0
fi

if command -v xdg-terminal-exec >/dev/null 2>&1; then
  if [[ "$AUTO_CONNECT" == "1" ]]; then
    (cd "$CWD" && env PI_TELEGRAM_AUTO_CONNECT=1 xdg-terminal-exec bash -lc "exec $PI_COMMAND")
  else
    (cd "$CWD" && xdg-terminal-exec bash -lc "exec $PI_COMMAND")
  fi
  echo "Launched via xdg-terminal-exec."
  exit 0
fi

echo "No known visible terminal launcher found; starting Pi in the current shell." >&2
cd "$CWD"
run_pi
