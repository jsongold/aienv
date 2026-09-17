#!/usr/bin/env zsh
# Install aienv and its shims into $AIENV_HOME (default $HOME/.aienv).
# Idempotent. Never edits ~/.zshrc; it only prints the line to add.

emulate -L zsh
setopt err_exit no_unset pipe_fail

src=${0:A:h}
home=${AIENV_HOME:-$HOME/.aienv}

mkdir -p -- "$home/bin" "$home/.store"

cp -f -- "$src/aienv" "$home/bin/aienv"
chmod 0755 "$home/bin/aienv"

for app in claude codex opencode; do
  cp -f -- "$src/shim" "$home/bin/$app"
  chmod 0755 "$home/bin/$app"
done

disp="$home/bin"
if [[ $home == "$HOME/.aienv" ]]; then disp='$HOME/.aienv/bin'; fi

print -r -- "installed: $home/bin/{aienv,claude,codex,opencode}"
print -r -- ""
print -r -- "Add this to your ~/.zshrc (this installer does not edit it):"
print -r -- ""
print -r -- "  export PATH=\"$disp:\$PATH\""
print -r -- ""
print -r -- "Then: exec zsh && aienv add claude"
