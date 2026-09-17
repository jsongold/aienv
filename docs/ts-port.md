# TypeScript port of the aienv CLI

Goal: replace the zsh `aienv` CLI with TypeScript, behavior-identical. The zsh file
`aienv` at the repo root is the **behavioral spec**: same commands, same stdout/stderr
text, same exit codes, same on-disk formats. `tests/run.zsh` (black-box, 88 checks,
goes through `install.sh`) is the acceptance suite and must pass unchanged except for
the install step.

Out of scope: `shim` stays zsh (hot path on every agent launch; must be instant and
dependency-free). On-disk layout is unchanged so existing installs keep working:

    $AIENV_HOME/bindings              TSV: app<TAB>dir<TAB>id   ('*' dir = global)
    $AIENV_HOME/.store/<id>/          one config dir per account
    $AIENV_HOME/.store/<id>/.aienv-meta   lines: app=… / org=… / email=…
    $AIENV_HOME/<app>/<org>/<email>   display symlink -> ../../.store/<id>
    $AIENV_HOME/.lock                 mkdir lock, stale after 10s

## Plan

- [x] Decide runtime: Node >= 24, native type stripping, run `.ts` directly, no build
      step, zero runtime dependencies. Erasable syntax only (no `enum`, no parameter
      properties, no `namespace`). ESM, relative imports with explicit `.ts` extension.
- [x] Module contract (below)
- [ ] Q1 `src/store.ts` + `tests/unit/store.test.ts`
- [ ] Q2 `src/bindings.ts` + `tests/unit/bindings.test.ts`
- [ ] Q3 `src/agents.ts` + `tests/unit/agents.test.ts`
- [ ] Q4 `src/commands.ts`, `src/cli.ts`
- [ ] Integrate: `install.sh` installs `src/` to `$AIENV_HOME/lib/aienv/` and writes a
      launcher `$AIENV_HOME/bin/aienv` that execs an absolute node path
- [ ] Acceptance: `zsh tests/run.zsh` PASS against the TS CLI; `node --test tests/unit/`
- [ ] `tsc --noEmit` clean; README updated; zsh `aienv` moved to `legacy/aienv.zsh`

## Hard rules (every module)

- Never read, write, copy or print tokens, credential files (`auth.json`,
  `.credentials.json`) or Keychain entries. Identity comes only from asking the agent
  CLI (`claude auth status --json`, codex app-server `account/read`).
- No runtime dependencies. Only `node:*` builtins.
- No module-level mutable state; everything takes a `Ctx`.
- User-facing strings must match the zsh spec byte for byte (tests grep them).
- Errors the user should see: `throw new AienvError(message, exitCode)`; `cli.ts`
  prints `aienv: <message>` to stderr and exits. Usage errors use exit code 2 and also
  print usage to stderr.

## Contract

### `src/types.ts` (written by the lead; do not change without telling the lead)

See the file. Key types: `App`, `Ctx`, `Account`, `Resolution`, `Identity`,
`AienvError`.

### `src/store.ts` (Q1)

```ts
export function sanitize(value: string): string;               // spec: sanitize()
export function genId(ctx: Ctx): string;                        // 8 hex chars, unused
export function metaRead(file: string): { app: string; org: string; email: string };
export function metaWrite(store: string, app: App, org: string, email: string): void;
export function accountsLoad(ctx: Ctx, app: App): Account[];    // sorted by id (glob order)
export function accountLabel(ctx: Ctx, app: App, id: string): string; // 'org/email' or id
/** Precedence: exact id > exact org/email > exact email > unique case-insensitive
 *  substring of 'org/email'. 0 or >1 hits: throw AienvError whose message is the full
 *  multi-line candidates text of the spec (first line WITHOUT the 'aienv: ' prefix). */
export function selectAccount(ctx: Ctx, app: App, match: string): Account;
/** Creates $AIENV_HOME/<app>/<sanitized org>/ and returns the link path; throws if the
 *  result would escape $AIENV_HOME/<app>. */
export function displayLinkPath(ctx: Ctx, app: App, org: string, email: string): string;
export function linkClaudeShared(ctx: Ctx, store: string): void; // spec: link_claude_shared
/** false on conflict (another account already has org/newEmail, or a non-symlink is in
 *  the way). Rewrites meta, creates new link, removes old link. */
export function renameAccount(ctx: Ctx, acc: Account, newEmail: string): boolean;
export const CLAUDE_SHARED: readonly string[];
```

### `src/bindings.ts` (Q2)

```ts
export type Binding = { app: string; dir: string; id: string };
export function readBindings(ctx: Ctx): Binding[];   // tolerate CRLF, blank/short lines,
                                                     // and a final line without '\n'
export function withLock<T>(ctx: Ctx, fn: () => T): T; // mkdir lock, 20 tries x 100ms,
                                                       // stale > 10s is removed; always released
export function bindingSet(ctx: Ctx, app: App, dir: string, id: string): void;
export function bindingUnset(ctx: Ctx, app: App, dir: string): void;
export function bindingsRemoveId(ctx: Ctx, id: string): void;
/** Nearest ancestor wins; a '/' binding matches everything; '*' is the fallback; first
 *  line wins among duplicates. `dir` is already absolute+resolved. */
export function resolveStore(ctx: Ctx, app: App, dir: string): Resolution;
```

Rewrites are atomic: write `$AIENV_HOME/.bindings.<pid>` then rename.

### `src/agents.ts` (Q3)

```ts
export function envVarFor(app: App): string;          // CLAUDE_CONFIG_DIR | CODEX_HOME | XDG_DATA_HOME
export function keyVarsFor(app: App): string[];       // spec: app_key_vars
export const ALL_KEY_VARS: readonly string[];
export function loginArgs(app: App): string[];        // spec: app_cmd login
export function logoutArgs(app: App): string[];
/** First executable `app` in PATH that is not inside $AIENV_HOME/bin (realpath compare)
 *  and whose 2nd line is not '# aienv-shim'. Empty PATH entry = cwd. null if none. */
export function findRealBin(ctx: Ctx, app: App): string | null;
/** Directory of the first executable `app` in PATH (realpath), shim included. */
export function firstInPath(ctx: Ctx, app: App): string | null;
/** Run the real binary with the config env var = store and key vars removed.
 *  stdio inherited. Returns exit code (127 when no real binary). */
export function runApp(ctx: Ctx, app: App, store: string, args: string[]): number;
/** Same env, stdout captured, stderr discarded. null when it cannot run / exit != 0. */
export function captureApp(ctx: Ctx, app: App, store: string | null, args: string[]): string | null;
/** codex app-server JSON-RPC 'account/read' over stdio. store null = codex default
 *  home. '' when unavailable. Must never hang: 10s overall timeout, kill the child,
 *  survive the child exiting immediately (EPIPE). Strip control chars. */
export function codexEmail(ctx: Ctx, store: string | null): Promise<string>;
/** Identity of the login inside `store`. 'logged-out' | Identity | 'unknown'
 *  ('unknown' = logged in or undeterminable, but no email: caller prompts). */
export function detectIdentity(ctx: Ctx, app: App, store: string): Promise<Identity | 'logged-out' | 'unknown'>;
/** Identity of the agent's own default login (no aienv store). null when unknown. */
export function defaultIdentity(ctx: Ctx, app: App): Promise<Identity | null>;
export type Status = { text: string; detectedEmail?: string };
/** spec: account_status. text is '?', 'logged-in', 'logged-out', 'logged-in MISMATCH',
 *  'logged-out/unknown'. For codex with stored email 'unknown' and a detected email,
 *  return text 'logged-in' and detectedEmail (the caller renames + decorates). */
export function accountStatus(ctx: Ctx, acc: Account): Promise<Status>;
```

JSON from `claude auth status --json` is parsed with `JSON.parse`; keys `loggedIn`,
`email`, `orgName`. There is no jq/sed fallback in the port (the "jq not found"
warning in `show` is dropped; the acceptance test for it, if any, is adjusted by the
lead).

### `src/commands.ts`, `src/cli.ts` (Q4)

```ts
// commands.ts
export function cmdAdd(ctx: Ctx, args: string[]): Promise<number>;
export function cmdSwitch(ctx: Ctx, args: string[]): Promise<number>;
export function cmdShow(ctx: Ctx, args: string[]): Promise<number>;
export function cmdRemove(ctx: Ctx, args: string[]): Promise<number>;
export function cmdResolve(ctx: Ctx, args: string[]): Promise<number>;
export function usage(ctx: Ctx): string;
// cli.ts: builds Ctx (spec: AIENV_HOME derivation from script location
// $AIENV_HOME/lib/aienv/cli.ts -> home is two levels up when ../../.store exists),
// dispatches, maps AienvError -> stderr + exit code, cleans up on SIGINT(130)/SIGTERM(143).
```

Prompts read one line **synchronously from fd 0** (`fs.readSync`, byte at a time until
`\n`), prompt text written to stderr exactly like zsh `read "v?prompt"` (zsh prints the
prompt to stderr only when stdin is a TTY; when stdin is not a TTY print nothing). EOF
before any byte = "no selection"/blank per spec.

`cmdAdd` must remove the half-created store on any failure or signal until meta is
written (spec: `ADD_STORE` + cleanup trap).
