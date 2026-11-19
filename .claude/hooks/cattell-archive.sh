#!/bin/bash
# Sends this Claude Code session to James Cattell's private archive (admin.cattell.com).
# A copy of scripts/sessions/for-other-repos/cattell-archive.sh in jacattell/cattell.com.
#
# It does nothing unless CATTELL_ARCHIVE=1 is set (only in James's own cloud environments)
# or James's archive key is saved on this computer. Nobody else's sessions are sent.
#
# It downloads the upload scripts from one fixed commit of the public cattell.com
# repository, and runs them only if every file matches the fingerprint (SHA-256) below.
# If anything doesn't match, it sends nothing. Changing the scripts on main has no effect
# here until this file is updated: run `node scripts/sessions/pin-hook.mjs` in cattell.com,
# then copy this file into each repository again.
[ "$CATTELL_ARCHIVE" = "1" ] || [ -f "$HOME/.config/cattell-archive/key" ] || exit 0
command -v node >/dev/null && command -v curl >/dev/null || exit 0

# --- pinned by scripts/sessions/pin-hook.mjs ---
commit="453ba8bb29f14b78db4761bf9a5664a85ea751b3"
files=(
  "lib/session-formats.js 2bf143a5ca77b3345f9209cedb1de0d087b64b79278a9e90c5d97d771c502ad4"
  "scripts/sessions/common.js fad588a2e13926063a32310b978175004d93f184b3c06ed42c0f5b24d6ef5001"
  "scripts/sessions/upload-claude-code.js 012598acac07c2944ed2df0bab196175e24be4c036122305929e0500c57229ee"
)
# --- end of pinned part ---

input=$(cat)
base="https://raw.githubusercontent.com/jacattell/cattell.com/$commit"
dir="${XDG_CACHE_HOME:-$HOME/.cache}/cattell-archive/$commit"

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# True only if every file is there and matches its fingerprint.
verified() {
  local entry path hash
  for entry in "${files[@]}"; do
    path=${entry% *}; hash=${entry#* }
    [ -f "$1/$path" ] && [ "$(sha256 "$1/$path")" = "$hash" ] || return 1
  done
}

if ! verified "$dir"; then
  # Download everything into a new folder, check it, and only then put it in place,
  # so a failed or partial download is never run.
  mkdir -p "$(dirname "$dir")" || exit 0
  tmp=$(mktemp -d "$(dirname "$dir")/download.XXXXXX") || exit 0
  for entry in "${files[@]}"; do
    path=${entry% *}
    mkdir -p "$tmp/$(dirname "$path")" && curl -fsS --max-time 20 "$base/$path" -o "$tmp/$path" || { rm -rf "$tmp"; exit 0; }
  done
  if ! verified "$tmp"; then
    echo "cattell-archive: downloaded files don't match their fingerprints; nothing sent" >&2
    rm -rf "$tmp"; exit 0
  fi
  echo '{"type":"module"}' > "$tmp/package.json"
  rm -rf "$dir" && mv "$tmp" "$dir" || { rm -rf "$tmp"; exit 0; }
fi

# Check again just before running.
verified "$dir" || exit 0
printf '%s' "$input" | node "$dir/scripts/sessions/upload-claude-code.js" --hook
exit 0
