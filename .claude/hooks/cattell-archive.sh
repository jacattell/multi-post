#!/bin/bash
# Sends this Claude Code session to James Cattell's private archive on cattell.com.
# A copy of scripts/sessions/for-other-repos/cattell-archive.sh in jacattell/cattell.com.
#
# It does nothing unless CATTELL_ARCHIVE=1 is set (only in James's own cloud environments)
# or James's archive key is saved on this computer. Nobody else's sessions are sent.
# It fetches the upload script from the public cattell.com repository, at most once an hour.
[ "$CATTELL_ARCHIVE" = "1" ] || [ -f "$HOME/.config/cattell-archive/key" ] || exit 0
input=$(cat)
dir="${TMPDIR:-/tmp}/cattell-archive-code"
base="https://raw.githubusercontent.com/jacattell/cattell.com/main"
if [ ! -f "$dir/.fetched" ] || [ -n "$(find "$dir/.fetched" -mmin +60 2>/dev/null)" ]; then
  mkdir -p "$dir/lib" "$dir/scripts/sessions" || exit 0
  for f in lib/session-formats.js scripts/sessions/common.js scripts/sessions/upload-claude-code.js; do
    curl -fsS --max-time 20 "$base/$f" -o "$dir/$f.new" && mv "$dir/$f.new" "$dir/$f" || exit 0
  done
  echo '{"type":"module"}' > "$dir/package.json"
  touch "$dir/.fetched"
fi
printf '%s' "$input" | node "$dir/scripts/sessions/upload-claude-code.js" --hook
exit 0
