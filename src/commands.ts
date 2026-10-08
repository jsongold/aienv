// Command layer of the aienv CLI. The zsh `aienv` at the repo root is the behavioral
// spec: every user-facing string, stream and exit code here mirrors it.
// aienv never reads, writes, copies or prints tokens or credential files.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as tty from 'node:tty';

import { APPS, AienvError, isApp, usageError } from './types.ts';
import type { Account, App, Ctx, Identity } from './types.ts';
import {
  accountLabel,
  accountsLoad,
  displayLinkPath,
  genId,
  linkClaudeShared,
  metaWrite,
  renameAccount,
  selectAccount,
} from './store.ts';
import { bindingSet, bindingUnset, bindingsRemoveId, resolveStore } from './bindings.ts';
import {
  ALL_KEY_VARS,
  accountStatus,
  captureApp,
  defaultIdentity,
  detectIdentity,
  envVarFor,
  firstInPath,
  loginArgs,
  logoutArgs,
  runApp,
} from './agents.ts';
import type { Status } from './agents.ts';

// --- output ---------------------------------------------------------------------

function out(line: string): void {
  process.stdout.write(line + '\n');
}

function err(line: string): void {
  process.stderr.write(line + '\n');
}

function warn(msg: string): void {
  err(`aienv: warning: ${msg}`);
}

function die(msg: string): never {
  throw new AienvError(msg, 1);
}

export function usage(ctx: Ctx): string {
  return [
    'usage: aienv <command>',
    '',
    '  add <app>                       log a new account in and store it separately',
    '  switch [app] [match]            bind an account to the current directory',
    '  switch [app] [match] --global   bind as the fallback for every directory',
    '  switch <app> --none             drop the binding for this directory',
    '  show [--no-status]              accounts, bindings and warnings',
    '  remove <app> <match>            log out and delete an account store',
    '  resolve <app> [dir]             print the store bound for dir (plumbing)',
    '  help',
    '',
    'match: an id, an exact org/email, an exact email, or a unique substring.',
    `apps: ${APPS.join(' ')}   home: ${ctx.home}`,
    '',
  ].join('\n');
}

function requireApp(app: string): App {
  if (app === 'cursor-agent') {
    die(
      'cursor-agent is unsupported: it keeps one global Keychain entry, so its account cannot be relocated per directory',
    );
  }
  if (!isApp(app)) throw usageError(`unknown app: ${app} (supported: ${APPS.join(' ')})`);
  return app;
}

// --- paths ----------------------------------------------------------------------

/** zsh `${p:A}`: absolute, symlinks resolved when the path exists. */
function resolveA(ctx: Ctx, p: string): string {
  const abs = path.resolve(ctx.cwd, p);
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

function here(ctx: Ctx): string {
  return resolveA(ctx, ctx.cwd);
}

/** spec: "${AIENV_HOME:A}/bin" */
function shimDir(ctx: Ctx): string {
  return `${resolveA(ctx, ctx.home)}/bin`;
}

// --- prompts --------------------------------------------------------------------

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** One line from fd 0, synchronously. null = EOF before any byte. The prompt goes to
 *  stderr only when stdin is a TTY (zsh `read "v?prompt"`). Leading/trailing blanks are
 *  stripped like zsh `read -r` with the default IFS. */
function readLine(prompt: string): string | null {
  if (tty.isatty(0)) process.stderr.write(prompt);
  const bytes: number[] = [];
  const buf = Buffer.alloc(1);
  let sawAny = false;
  for (;;) {
    let n = 0;
    try {
      n = fs.readSync(0, buf, 0, 1, null);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EAGAIN' || code === 'EINTR') {
        sleepMs(10);
        continue;
      }
      if (code === 'EOF') break;
      break; // unreadable stdin (closed fd, EISDIR, ...) behaves like EOF
    }
    if (n === 0) break;
    sawAny = true;
    if (buf[0] === 0x0a) break;
    bytes.push(buf[0]!);
  }
  if (!sawAny) return null;
  return Buffer.from(bytes)
    .toString('utf8')
    .replace(/^[ \t]+|[ \t\r]+$/g, '');
}

function pickNumber(count: number, prompt: string): number {
  const line = readLine(prompt);
  if (line === null) die('no selection');
  if (!/^[0-9]+$/.test(line)) die(`invalid selection: ${line}`);
  const n = Number.parseInt(line, 10);
  if (!Number.isSafeInteger(n) || n < 1 || n > count) die(`invalid selection: ${line}`);
  return n;
}

function pickApp(ctx: Ctx): App {
  const avail: App[] = APPS.filter((app) => accountsLoad(ctx, app).length > 0);
  if (avail.length === 0) die('no accounts yet; run: aienv add <app>');
  if (avail.length === 1) return avail[0]!;
  avail.forEach((app, i) => out(`  ${i + 1}) ${app}`));
  return avail[pickNumber(avail.length, 'app number: ') - 1]!;
}

/** '*' marks the account currently active for dir. */
function pickAccount(ctx: Ctx, app: App, dir: string): string {
  const res = resolveStore(ctx, app, dir);
  const accounts = accountsLoad(ctx, app);
  if (accounts.length === 0) die(`no ${app} accounts; run: aienv add ${app}`);
  accounts.forEach((acc, i) => {
    const mark = acc.id === res.id && !res.dangling ? '*' : ' ';
    out(`${mark} ${i + 1}) ${acc.org}/${acc.email}`);
  });
  return accounts[pickNumber(accounts.length, 'account number: ') - 1]!.id;
}

function promptEmail(): string {
  const v = readLine('email for this account (blank = unknown): ');
  return v === null || v === '' ? 'unknown' : v;
}

function rejectDuplicate(ctx: Ctx, app: App, org: string, email: string): void {
  for (const acc of accountsLoad(ctx, app)) {
    if (acc.org === org && acc.email === email) {
      die(
        `${app} account ${org}/${email} already exists (${acc.id}); run 'aienv remove ${app} ${acc.id}' first`,
      );
    }
  }
}

/** Let a signal that arrived while a synchronous child was running reach its handler. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(() => setImmediate(resolve), 0));
}

// --- add ------------------------------------------------------------------------

export async function cmdAdd(ctx: Ctx, args: string[]): Promise<number> {
  const appArg = args[0] ?? '';
  if (appArg === '') throw usageError('usage: aienv add <app>');
  const app = requireApp(appArg);
  const envVar = envVarFor(app);
  fs.mkdirSync(ctx.storeDir, { recursive: true });
  const id = genId(ctx);
  const store = path.join(ctx.storeDir, id);

  // Until meta is written, any failure or signal removes the half-created store.
  let pending = true;
  const discard = (): void => {
    if (!pending) return;
    pending = false;
    fs.rmSync(store, { recursive: true, force: true });
  };
  // Prepended: runs before cli.ts' handler, which exits.
  process.prependListener('SIGINT', discard);
  process.prependListener('SIGTERM', discard);
  process.prependListener('exit', discard);

  let identity: Identity;
  try {
    fs.mkdirSync(store, { recursive: true });
    const login = loginArgs(app);
    err(`aienv: running '${app} ${login.join(' ')}' with ${envVar}=${store}`);
    const rc = runApp(ctx, app, store, login);
    await yieldToEventLoop();
    if (rc !== 0) die(`'${app} ${login.join(' ')}' failed (exit ${rc}); nothing stored`);

    const detected = await detectIdentity(ctx, app, store);
    if (detected === 'logged-out') die(`${app} reports no active login; nothing stored`);
    if (detected === 'unreadable') {
      warn("could not read 'claude auth status --json'; asking instead");
      identity = { org: '-', email: promptEmail() };
    } else if (detected === 'unknown') {
      identity = { org: '-', email: promptEmail() };
    } else {
      identity = {
        org: detected.org === '' ? '-' : detected.org,
        email: detected.email === '' ? promptEmail() : detected.email,
      };
    }
    rejectDuplicate(ctx, app, identity.org, identity.email);
    metaWrite(store, app, identity.org, identity.email);
    pending = false;
  } finally {
    discard();
    process.removeListener('SIGINT', discard);
    process.removeListener('SIGTERM', discard);
    process.removeListener('exit', discard);
  }

  if (app === 'claude') linkClaudeShared(ctx, store);
  const link = displayLinkPath(ctx, app, identity.org, identity.email);
  const st = fs.lstatSync(link, { throwIfNoEntry: false });
  if (st && !st.isSymbolicLink()) die(`${link} exists and is not a symlink; refusing to overwrite`);
  if (st) fs.unlinkSync(link);
  fs.symlinkSync(`../../.store/${id}`, link);
  out(`added ${app} ${identity.org}/${identity.email} (${id})`);
  out(`bind it here with: aienv switch ${app} ${id}`);
  return 0;
}

// --- switch ---------------------------------------------------------------------

export async function cmdSwitch(ctx: Ctx, args: string[]): Promise<number> {
  let global = false;
  let none = false;
  const pos: string[] = [];
  for (const a of args) {
    if (a === '--global' || a === '-g') global = true;
    else if (a === '--none') none = true;
    else if (a.startsWith('-')) throw usageError(`unknown option: ${a}`);
    else pos.push(a);
  }
  let dir = '*';
  if (!global) {
    dir = here(ctx);
    if (dir.includes('\t') || dir.includes('\n')) {
      die('the current directory contains a tab or newline; aienv cannot bind it');
    }
  }
  const appArg = pos[0] ?? '';
  if (none) {
    if (appArg === '') throw usageError('usage: aienv switch <app> --none');
    const app = requireApp(appArg);
    bindingUnset(ctx, app, dir);
    out(`unbound ${app} for ${dir}`);
    return 0;
  }
  const app = appArg === '' ? pickApp(ctx) : requireApp(appArg);
  const id = pos.length >= 2 ? selectAccount(ctx, app, pos[1]!).id : pickAccount(ctx, app, dir);
  // Idempotent; also backfills shared items into stores made by older versions.
  if (app === 'claude') linkClaudeShared(ctx, path.join(ctx.storeDir, id));
  bindingSet(ctx, app, dir, id);
  out(`${app} -> ${accountLabel(ctx, app, id)} for ${dir}`);
  // A binding only takes effect through the shim, and only at process start.
  const first = firstInPath(ctx, app);
  if (first !== null && first !== shimDir(ctx)) {
    warn(`this shell runs ${first}/${app}, not the shim; run 'exec zsh' (or open a new terminal) first`);
  }
  const hint =
    app === 'claude'
      ? "exit and run 'claude -c' to resume the conversation under the new account"
      : 'restart them to apply';
  err(`aienv: running ${app} sessions keep their account; ${hint}`);
  return 0;
}

// --- remove ---------------------------------------------------------------------

export async function cmdRemove(ctx: Ctx, args: string[]): Promise<number> {
  const appArg = args[0] ?? '';
  const match = args[1] ?? '';
  if (appArg === '' || match === '') throw usageError('usage: aienv remove <app> <match>');
  const app = requireApp(appArg);
  const acc = selectAccount(ctx, app, match);
  const label = `${acc.org}/${acc.email}`;
  const ans = (
    readLine(`remove ${app} account ${label} (${acc.id}) and its config dir? [y/N] `) ?? ''
  ).toLowerCase();
  if (ans !== 'y' && ans !== 'yes') {
    out('aborted');
    return 0;
  }
  const store = path.join(ctx.storeDir, acc.id);
  const logout = logoutArgs(app);
  if (captureApp(ctx, app, store, logout) === null) {
    warn(`'${app} ${logout.join(' ')}' failed or is unavailable; removing the local store anyway`);
  }
  fs.rmSync(store, { recursive: true, force: true });
  const link = displayLinkPath(ctx, app, acc.org, acc.email);
  if (fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) {
    fs.rmSync(link, { force: true });
  }
  for (const d of [path.dirname(link), path.join(ctx.home, app)]) {
    try {
      fs.rmdirSync(d);
    } catch {
      // not empty (or already gone): keep it
    }
  }
  bindingsRemoveId(ctx, acc.id);
  out(`removed ${app} ${label}`);
  return 0;
}

// --- resolve --------------------------------------------------------------------

export async function cmdResolve(ctx: Ctx, args: string[]): Promise<number> {
  const appArg = args[0] ?? '';
  if (appArg === '') throw usageError('usage: aienv resolve <app> [dir]');
  const app = requireApp(appArg);
  const dir = resolveA(ctx, args[1] ?? ctx.cwd);
  const res = resolveStore(ctx, app, dir);
  if (res.store !== null) {
    out(res.store);
    return 0;
  }
  if (res.dangling) {
    err(`aienv: binding for ${res.dir} points at missing account ${res.id}; run: aienv switch ${app}`);
  }
  return 1;
}

// --- show -----------------------------------------------------------------------

type AppReport = {
  app: App;
  src: string;
  boundId: string;
  unbound: boolean;
  accounts: Account[];
  def: Identity | null;
  statuses: Status[] | null;
};

/** Asks the agents (all accounts and the default login at once); prints nothing. */
async function collectApp(ctx: Ctx, app: App, dir: string, noStatus: boolean): Promise<AppReport> {
  const res = resolveStore(ctx, app, dir);
  let src = 'none';
  if (res.store !== null) src = res.source === 'dir' ? `dir: ${res.dir}` : 'global';
  else if (res.dangling) src = `${res.dir} -> DANGLING ${res.id}`;
  const accounts = accountsLoad(ctx, app);
  // Nothing bound (or dangling): the agent runs with its own default login.
  // When that login is identifiable, star the stored account it equals.
  const unbound = res.id === '' || res.dangling;
  const probeDefault = unbound && !noStatus && accounts.length > 0;
  const [def, statuses] = await Promise.all([
    probeDefault ? defaultIdentity(ctx, app) : Promise.resolve(null),
    noStatus ? Promise.resolve(null) : Promise.all(accounts.map((acc) => accountStatus(ctx, acc))),
  ]);
  return {
    app,
    src,
    boundId: res.id,
    unbound,
    accounts,
    def: def !== null && def.email === '' ? null : def,
    statuses,
  };
}

/**
 * The account label `show` prints: the org name, or the email's domain when the
 * org says nothing (codex/opencode store `-`; a personal claude org is just
 * `<email>'s Organization`).
 */
function showLabel(org: string, email: string): string {
  if (org !== '' && org !== '-' && org !== `${email}'s Organization`) return org;
  const at = email.indexOf('@');
  return at === -1 ? email : email.slice(at + 1);
}

function showApp(ctx: Ctx, r: AppReport): void {
  out('');
  out(`${r.app}  [${r.src}]`);
  if (r.accounts.length === 0) {
    out('  (no accounts)');
    return;
  }
  const rows: { mark: string; label: string; id: string; st: string }[] = [];
  let starred = false;
  r.accounts.forEach((acc, i) => {
    let mark = ' ';
    if (!r.unbound) {
      if (acc.id === r.boundId) mark = '*';
    } else if (r.def !== null && !starred && acc.org === r.def.org && acc.email === r.def.email) {
      mark = '*';
      starred = true;
    }
    let email = acc.email;
    let st = '-';
    if (r.statuses !== null) {
      const status = r.statuses[i]!;
      st = status.text;
      const found = status.detectedEmail;
      if (found !== undefined && found !== '') {
        // Stored before aienv could ask codex: adopt the reported email.
        if (renameAccount(ctx, acc, found)) {
          email = found;
          st = `logged-in  (email detected: ${found})`;
        }
      }
    }
    rows.push({ mark, label: showLabel(acc.org, email), id: `(${acc.id})`, st });
  });
  const labelW = Math.max(...rows.map((row) => row.label.length));
  const idW = Math.max(...rows.map((row) => row.id.length));
  for (const row of rows) {
    out(`  ${row.mark} ${row.label.padEnd(labelW)}  ${row.id.padEnd(idW)}  ${row.st}`);
  }
}

function showWarnings(ctx: Ctx): void {
  const w: string[] = [];
  for (const v of ALL_KEY_VARS) {
    const value = ctx.env[v];
    if (value !== undefined && value !== '') {
      w.push(`${v} is set in this shell; it outranks the subscription login (value not shown)`);
    }
  }
  const shim = shimDir(ctx);
  for (const app of APPS) {
    const first = firstInPath(ctx, app);
    if (first !== null && first !== shim) {
      w.push(`${ctx.home}/bin is not ahead of ${first}/${app} in PATH; the shim will not run`);
    }
  }
  if (w.length === 0) return;
  out('');
  out('warnings:');
  for (const line of w) out(`  - ${line}`);
}

export async function cmdShow(ctx: Ctx, args: string[]): Promise<number> {
  let noStatus = false;
  for (const a of args) {
    if (a === '--no-status') noStatus = true;
    else throw usageError(`unknown option: ${a}`);
  }
  const dir = here(ctx);
  out(`dir: ${dir}`);
  const reports = await Promise.all(APPS.map((app) => collectApp(ctx, app, dir, noStatus)));
  for (const r of reports) showApp(ctx, r);
  showWarnings(ctx);
  return 0;
}
