# aienv

Per-directory switching of the logged-in **subscription** account for coding-agent
CLIs (`claude`, `codex`, `opencode`). Pure zsh + macOS system tools, no third-party
dependencies.

aienv never reads, writes, copies or prints tokens, credential files or Keychain
entries. API keys are out of scope: they are only ever named in warnings, never used.

## Install

```sh
git clone <this repo> ~/src/aienv
zsh ~/src/aienv/install.sh
```

The installer creates `$AIENV_HOME` (default `~/.aienv`), installs `aienv` and the
shims, and prints the PATH line to add. It never edits `~/.zshrc`:

```sh
export PATH="$HOME/.aienv/bin:$PATH"
```

## Quickstart

```sh
aienv add claude                  # logs in, stores that account separately
aienv add claude                  # again, for the second account
cd ~/work/client-a && aienv switch claude    # pick the account for this dir
aienv show                        # who is bound where, plus warnings
claude                            # runs as the bound account
```

## How it works

Each account gets its own config directory under `$AIENV_HOME/.store/<id>/`. A shim
on your `PATH` (`$AIENV_HOME/bin/claude`, ...) looks up the account bound to `$PWD`
in `$AIENV_HOME/bindings`, exports the agent's config env var
(`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_DATA_HOME`) to point at that store, and
`exec`s the real binary. The nearest ancestor directory binding wins; a `*` binding
(`--global`) is the fallback. With no binding, the real binary runs untouched -- the
environment it sees is byte for byte the one it would have seen without aienv. The
shim exports no marker of its own, so an agent that launches another agent in a
different directory resolves that directory's account.

`aienv` resolves accounts by, in order: exact id, exact `org/email`, exact email,
then a unique case-insensitive substring of `org/email`.

`$AIENV_HOME/<app>/<org>/<email>` symlinks are for browsing only; the env var always
carries the stable `.store/<id>` path.

For `claude`, shared non-credential items (`CLAUDE.md`, `settings.json`, `skills`,
`agents`, `commands`, `hooks`, `rules`, `keybindings.json`, `projects`) are symlinked
from `~/.claude` into a store (the list is one array at the top of `aienv`).
Credentials, `.claude.json` and history are never linked or copied.

`projects` (conversation transcripts) is shared so a switch keeps the conversation:

    aienv switch claude <match>   # rebind this directory
    claude -c                     # relaunch; same conversation, new account

A running `claude` keeps the account it started with; the binding applies at launch.

## Limitations

- Already-running agent sessions are unaffected; the binding is read at launch.
- `cursor-agent` is unsupported: it keeps one global Keychain entry that cannot be
  relocated per directory. `aienv add cursor-agent` fails with that message.
- The macOS Keychain must be unlocked; each store path gets its own Keychain entry,
  so the first launch after a switch may prompt.
- Do not move or rename `.store/<id>` directories. The path is part of the Keychain
  entry key; moving it loses the login.
- `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`,
  `OPENAI_API_KEY` and `CODEX_ACCESS_TOKEN` outrank a subscription login. The shim
  unsets the relevant ones for a bound app; `aienv show` warns if any is set (names
  only, never values).
- `opencode` is relocated through `XDG_DATA_HOME`, which is a general-purpose
  variable: every tool `opencode` spawns inherits it and will look for its own data
  under the store directory. Bind `opencode` only where that is acceptable.
- `codex` and `opencode` expose no email/org, so `aienv add` asks for a label.
- If a binding points at an account whose store is gone, the shim refuses to launch
  the agent rather than silently using the default account. Re-run `aienv switch`.
- `aienv show` calls each agent's status command without a timeout, so a hung or
  very slow agent binary makes `show` hang. Use `aienv show --no-status`.

## Tests

```sh
zsh tests/run.zsh
```

Runs against a temp `AIENV_HOME` with fake agent binaries. No network, no real login.
