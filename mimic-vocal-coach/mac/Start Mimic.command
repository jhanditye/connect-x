#!/bin/bash
# Start Mimic: double-click this file. If macOS refuses, see README.txt (one line in Terminal always works).
#
# It starts Mimic's small web server on this Mac (the microphone needs a "localhost" address) and opens it in your browser.
# Nothing is installed, nothing is written outside this folder, and nothing leaves your Mac: the server answers this computer only.
# Written for the bash 3.2 and BSD tools that ship with every Mac.
#
# Advanced: MIMIC_BROWSER="Google Chrome" opens that browser instead of the default one.
#           MIMIC_PORT=47400 uses another port (browser storage belongs to the address, so clips saved on 47321 will not show up there).

PORT="${MIMIC_PORT:-47321}"
URL="http://localhost:$PORT/"
PROBE="http://127.0.0.1:$PORT/manifest.webmanifest"

# The server needs no locale, and a language setting the Mac has no data for makes perl print a long warning in this window.
LC_ALL=C
export LC_ALL

POLLER=""
stop_poller() {
  if [ -n "$POLLER" ]; then
    kill "$POLLER" 2>/dev/null
    POLLER=""
  fi
  return 0
}

# Show a message and keep the window readable (a window that vanishes at once hides what went wrong).
fail() {
  stop_poller
  printf '\n%s\n\n' "$1"
  if [ -t 0 ]; then
    printf 'Press Return to close this window. '
    read -r _dummy
  fi
  exit 1
}

case "$PORT" in
  '' | *[!0-9]*) fail "MIMIC_PORT must be a number, for example 47321." ;;
esac

# Work from this file's own folder, wherever it was put.
HERE="$(cd "$(dirname "$0")" 2>/dev/null && pwd -P)" || fail "Mimic could not find the folder this file is in. Move the whole Mimic-for-Mac folder to your home folder and try again."
cd "$HERE" || fail "Mimic could not open its own folder ($HERE).
If it is in Documents, Desktop or Downloads, macOS may have stopped Terminal from opening it: see \"IF SOMETHING GOES WRONG\" in README.txt, or move the whole folder to your home folder."

if [ ! -f "$HERE/server.pl" ] || [ ! -f "$HERE/app/index.html" ]; then
  fail "Mimic cannot find its files next to this launcher.
It needs the folder \"app\" and the file \"server.pl\" beside \"Start Mimic.command\".
If you moved only this file, move it back into the Mimic-for-Mac folder, or unzip Mimic-for-Mac.zip again.
If the folder is in Documents, Desktop or Downloads, macOS may be keeping Terminal out of it: move the
whole Mimic-for-Mac folder to your home folder and try again."
fi

# Make the next double-click work if the download dropped the "executable" flag (only touches this file).
[ -x "$0" ] || chmod u+x "$0" 2>/dev/null

# Every Mac has /usr/bin/perl; nothing else is needed.
PERL=""
if [ -x /usr/bin/perl ]; then
  PERL=/usr/bin/perl
else
  PERL="$(command -v perl 2>/dev/null)"
fi
[ -n "$PERL" ] || fail "This Mac has no \"perl\", which Mimic's small server needs. It normally comes with macOS.
If macOS opens a window offering to install the \"command line developer tools\", click Install, wait until it
has finished, and double-click this file again. If not, Mimic cannot run on this Mac: tell whoever gave it to you."
"$PERL" -MIO::Socket::INET -MSocket -MPOSIX -MCwd -MFindBin -e 1 2>/dev/null || fail "The \"perl\" on this Mac ($PERL) is missing a standard part, so Mimic's server cannot run.
Tell whoever gave you Mimic that this Mac's perl is incomplete."

open_browser() {
  if [ -n "${MIMIC_BROWSER:-}" ] && open -a "$MIMIC_BROWSER" "$URL" 2>/dev/null; then
    return 0
  fi
  open "$URL" 2>/dev/null
}

banner() {
  cat <<EOF

  ==========================================================
    Mimic Vocal Coach is running
  ==========================================================

    Open it here:   $URL
    (Your browser should open on its own in a moment.)

    * Keep this window open while you use Mimic.
      To stop Mimic, press Control-C here, or close this window.
    * Your recordings and clips are saved in your browser, for the
      address above. Always start Mimic from this file and use the
      same browser, or your clips will not be there.
    * Safari (16.4 or newer) and Chrome both work. To use another one,
      copy the address above into it (each browser keeps its own clips).
    * Nothing leaves your Mac: Mimic only answers to this computer.

EOF
}

# Prints the page the server at $PROBE sends, headers first (empty and a failure status when nothing answers).
probe() {
  curl -s -i --max-time 2 "$PROBE" 2>/dev/null
}

# Is it Mimic that answers on our port? And is it the Mimic that lives in THIS folder?
open_the_running_one() {
  # $1 = what curl printed. Only call this when it holds "Mimic Vocal Coach".
  theirs="$(printf '%s\n' "$1" | sed -n 's/^X-Mimic-Folder: *//p' | tr -d '\r' | head -n 1)"
  mine="$HERE/app"
  printf '\nMimic is already running (in another Terminal window), so I am just opening it for you:\n  %s\n\n' "$URL"
  if [ -n "$theirs" ]; then
    a="$(printf '%s' "$theirs" | tr '[:upper:]' '[:lower:]')"
    b="$(printf '%s' "$mine" | tr '[:upper:]' '[:lower:]')"
    if [ "$a" != "$b" ]; then
      printf 'Note: the Mimic that is already running was started from another folder:\n  %s\n' "$theirs"
      printf 'If you just updated Mimic, close that Terminal window (Control-C), or restart your Mac if you\n'
      printf 'cannot find it, and double-click this file again to get the new version.\n\n'
    fi
  fi
  open_browser
  printf 'Leave that other window open while you use Mimic. You can close this one.\n\n'
}

# Is something already answering on our port?
HAVE_CURL=0
command -v curl >/dev/null 2>&1 && HAVE_CURL=1
if [ "$HAVE_CURL" = 1 ]; then
  BODY="$(probe)"
  RC=$?
  if [ "$RC" -eq 0 ]; then
    case "$BODY" in
      *"Mimic Vocal Coach"*)
        open_the_running_one "$BODY"
        exit 0
        ;;
    esac
  fi
  if [ "$RC" -ne 7 ]; then
    # 7 = nothing is listening, which is what we want. Anything else means another program holds the port.
    fail "Something other than Mimic is already using port $PORT on this Mac, so Mimic cannot start.
To see which program it is, open Terminal and type:
    lsof -nP -iTCP:$PORT -sTCP:LISTEN
Quit that program and start Mimic again. (You can also start Mimic on a different port with
    MIMIC_PORT=47400 bash \"Start Mimic.command\"
but your saved recordings belong to the port, so clips saved here would not appear there.)"
  fi
fi

trap stop_poller EXIT

if [ "$HAVE_CURL" = 1 ]; then
  printf '\nStarting Mimic...\n'
  # Wait (up to about 40 seconds: a first start on a busy Mac can be slow) until the server answers, then show the banner and open
  # the browser. The first look comes after a short pause, so that a second copy of this launcher whose own server could not start
  # (port taken by the first) has already been stopped and does not announce the first one's server as its own.
  (
    sleep 0.5 2>/dev/null || sleep 1
    told=0
    deadline=$((SECONDS + 40))
    while [ "$SECONDS" -lt "$deadline" ]; do
      if curl -sf -o /dev/null --max-time 1 "$PROBE" 2>/dev/null; then
        banner
        open_browser
        exit 0
      fi
      if [ "$told" = 0 ] && [ "$SECONDS" -ge $((deadline - 32)) ]; then
        told=1
        printf '  (Still starting. This can take a little longer the first time.)\n'
      fi
      sleep 0.2 2>/dev/null || sleep 1
    done
    printf '\nMimic is taking much longer than usual to start. If this window shows an error above, see README.txt.\n'
    printf 'Otherwise, in a minute, open this address in your browser:\n  %s\n\n' "$URL"
  ) &
  POLLER=$!
else
  banner
  echo "    (Open the address above in your browser.)"
  echo
fi

PORT="$PORT" "$PERL" "$HERE/server.pl" "$HERE/app"
STATUS=$?
stop_poller

case "$STATUS" in
  0 | 130 | 143)
    printf '\nMimic has stopped. You can close this window.\n\n'
    ;;
  *)
    # Two double-clicks in a row: the second server cannot start, but the first one is Mimic. That is not an error.
    if [ "$HAVE_CURL" = 1 ]; then
      BODY="$(probe)"
      case "$BODY" in
        *"Mimic Vocal Coach"*)
          open_the_running_one "$BODY"
          exit 0
          ;;
      esac
    fi
    fail "Mimic's server did not start (see the line above).
If it says the port is already in use, something else on this Mac is using it: close that program, or see README.txt."
    ;;
esac
