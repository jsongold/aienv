// Agent CLI access: locating the real binary, running it against a store, and asking it
// who is logged in. Never reads credential files; identity comes only from the agent.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { APPS } from './types.ts';
import type { Account, App, Ctx, Identity } from './types.ts';

/** Per-app facts: the config env var the shim relocates, the key vars that outrank a
 *  subscription login (names only, never read), and the login / logout argv. */
export const AGENTS: Record<
  App,
  { envVar: string; keyVars: string[]; login: string[]; logout: string[] }
> = {
  claude: {
    envVar: 'CLAUDE_CONFIG_DIR',
    keyVars: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
    login: ['auth', 'login'],
    logout: ['auth', 'logout'],
  },
  codex: {
    envVar: 'CODEX_HOME',
    keyVars: ['OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN'],
    login: ['login'],
    logout: ['logout'],
  },
  opencode: {
    envVar: 'XDG_DATA_HOME',
    keyVars: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
    login: ['auth', 'login'],
    logout: ['auth', 'logout'],
  },
};

/** Union of every key var, for the warnings in `show`. */
export const ALL_KEY_VARS: readonly string[] = [...new Set(APPS.flatMap((app) => AGENTS[app].keyVars))];

function pathEntries(ctx: Ctx): string[] {
  const raw = ctx.env.PATH ?? '';
  if (raw === '') return [];
  return raw.split(':').map((p) => (p === '' ? ctx.cwd : p));
}

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function isExecutableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Second line of a file ('' when unreadable or absent). Reads only the first 512 bytes. */
function secondLine(file: string): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(512);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const lines = buf.subarray(0, n).toString('latin1').split('\n');
    return lines.length > 1 ? lines[1] : '';
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function shimDir(ctx: Ctx): string {
  const dir = path.join(ctx.home, 'bin');
  const real = realpathOrNull(dir);
  if (real !== null) return real;
  // bin does not exist: resolve as much as possible (spec: ${AIENV_HOME:A}/bin).
  const home = realpathOrNull(ctx.home);
  return home !== null ? path.join(home, 'bin') : path.resolve(ctx.cwd, dir);
}

export function findRealBin(ctx: Ctx, app: App): string | null {
  const shim = shimDir(ctx);
  for (const entry of pathEntries(ctx)) {
    const dir = realpathOrNull(path.resolve(ctx.cwd, entry));
    if (dir === null || dir === shim) continue;
    const cand = path.join(dir, app);
    if (!isExecutableFile(cand)) continue;
    if (secondLine(cand) === '# aienv-shim') continue;
    return cand;
  }
  return null;
}

export function firstInPath(ctx: Ctx, app: App): string | null {
  for (const entry of pathEntries(ctx)) {
    const dir = path.resolve(ctx.cwd, entry);
    if (!isExecutableFile(path.join(dir, app))) continue;
    return realpathOrNull(dir) ?? dir;
  }
  return null;
}

function childEnv(ctx: Ctx, app: App, store: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(ctx.env)) {
    if (v !== undefined) env[k] = v;
  }
  const { envVar, keyVars } = AGENTS[app];
  for (const k of keyVars) delete env[k];
  if (store !== null) env[envVar] = store;
  else if (app === 'claude') delete env[envVar];
  return env;
}

function signalNumber(signal: string): number {
  const n = (os.constants.signals as Record<string, number | undefined>)[signal];
  return n === undefined ? 0 : n;
}

export function runApp(ctx: Ctx, app: App, store: string, args: string[]): number {
  const bin = findRealBin(ctx, app);
  if (bin === null) {
    process.stderr.write(`aienv: no '${app}' binary found in PATH outside ${ctx.home}/bin\n`);
    return 127;
  }
  const res = spawnSync(bin, args, {
    env: childEnv(ctx, app, store),
    cwd: ctx.cwd,
    stdio: 'inherit',
  });
  if (res.error) {
    // e.g. ENOENT for a script with no shebang line (a broken install)
    process.stderr.write(`aienv: cannot execute ${bin}: ${res.error.message}\n`);
    return 127;
  }
  if (res.status !== null) return res.status;
  if (res.signal) {
    const n = signalNumber(res.signal);
    return n > 0 ? 128 + n : 1;
  }
  return 1;
}

/** Runs the agent against a store and returns its stdout; null when it is missing, fails
 *  or exceeds the timeout. Non-blocking so several agents can be asked at once. */
export function captureAppAsync(
  ctx: Ctx,
  app: App,
  store: string | null,
  args: string[],
  timeoutMs = 30_000,
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const bin = findRealBin(ctx, app);
    if (bin === null) {
      resolve(null);
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, {
        env: childEnv(ctx, app, store),
        cwd: ctx.cwd,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      resolve(null);
      return;
    }
    const maxBuffer = 16 * 1024 * 1024;
    let done = false;
    let out = '';
    const finish = (result: string | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (result === null) {
        try {
          child.kill('SIGTERM');
        } catch {
          // already gone
        }
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 ? out : null));
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      out += chunk;
      if (out.length > maxBuffer) finish(null);
    });
  });
}

const CODEX_REQUESTS =
  '{"id":1,"method":"initialize","params":{"clientInfo":{"name":"aienv","title":"aienv","version":"0"}}}\n' +
  '{"method":"initialized"}\n' +
  '{"id":2,"method":"account/read","params":{"refreshToken":false}}\n';

function stripControl(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

/** Email out of one app-server line; undefined when the line is not the id 2 answer. */
function emailFromLine(line: string): string | undefined {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof msg !== 'object' || msg === null) return undefined;
  const obj = msg as { id?: unknown; result?: { account?: { email?: unknown } | null } | null };
  if (obj.id !== 2) return undefined;
  const email = obj.result?.account?.email;
  return typeof email === 'string' ? email : '';
}

export function codexEmail(ctx: Ctx, store: string | null, timeoutMs = 10_000): Promise<string> {
  return new Promise<string>((resolve) => {
    const bin = findRealBin(ctx, 'codex');
    if (bin === null) {
      resolve('');
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, ['app-server'], {
        env: childEnv(ctx, 'codex', store),
        cwd: ctx.cwd,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      resolve('');
      return;
    }

    let done = false;
    let pending = '';
    const finish = (email: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
      resolve(stripControl(email));
    };
    const timer = setTimeout(() => finish(''), timeoutMs);

    child.on('error', () => finish(''));
    child.on('close', () => finish(''));
    child.stdin?.on('error', () => {
      // EPIPE from a child that exited at once; the 'close' handler resolves.
    });
    child.stdout?.on('error', () => finish(''));
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (done) return;
      pending += chunk;
      let nl = pending.indexOf('\n');
      while (nl !== -1) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        const email = emailFromLine(line);
        if (email !== undefined) {
          finish(email);
          return;
        }
        nl = pending.indexOf('\n');
      }
    });
    child.stdout?.on('end', () => {
      if (done) return;
      const email = pending === '' ? undefined : emailFromLine(pending);
      finish(email ?? '');
    });

    // Do not end stdin: the real codex exits on stdin EOF before answering.
    try {
      child.stdin?.write(CODEX_REQUESTS);
    } catch {
      // handled by 'error'/'close'
    }
  });
}

type ClaudeStatus = { loggedIn: unknown; email: string; orgName: string };

/** null = no output or unparsable. */
async function claudeStatus(ctx: Ctx, store: string | null): Promise<ClaudeStatus | null> {
  const out = await captureAppAsync(ctx, 'claude', store, ['auth', 'status', '--json']);
  if (out === null || out.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const str = (v: unknown): string =>
    v === null || v === undefined ? '' : stripControl(String(v));
  return { loggedIn: obj.loggedIn, email: str(obj.email), orgName: str(obj.orgName) };
}

async function codexLoggedIn(ctx: Ctx, store: string): Promise<boolean> {
  return (await captureAppAsync(ctx, 'codex', store, ['login', 'status'])) !== null;
}

/** 'unreadable': claude gave no usable status; the caller warns, then prompts like 'unknown'. */
export type DetectResult = Identity | 'logged-out' | 'unknown' | 'unreadable';

export async function detectIdentity(ctx: Ctx, app: App, store: string): Promise<DetectResult> {
  if (app === 'claude') {
    const st = await claudeStatus(ctx, store);
    if (st === null) return 'unreadable';
    if (st.loggedIn === false) return 'logged-out';
    if (st.loggedIn === true) {
      if (st.email === '') return 'unknown';
      return { org: st.orgName || '-', email: st.email };
    }
    return 'unreadable';
  }
  if (app === 'codex') {
    if (!(await codexLoggedIn(ctx, store))) return 'logged-out';
    const email = await codexEmail(ctx, store);
    return email === '' ? 'unknown' : { org: '-', email };
  }
  return 'unknown';
}

export async function defaultIdentity(ctx: Ctx, app: App): Promise<Identity | null> {
  if (app === 'claude') {
    const st = await claudeStatus(ctx, null);
    if (st === null || st.loggedIn !== true || st.email === '') return null;
    return { org: st.orgName || '-', email: st.email };
  }
  if (app === 'codex') {
    const email = await codexEmail(ctx, null);
    return email === '' ? null : { org: '-', email };
  }
  return null;
}

export async function accountStatus(ctx: Ctx, acc: Account): Promise<string> {
  if (acc.app === 'claude') {
    const st = await claudeStatus(ctx, acc.store);
    if (st === null) return '?';
    if (st.loggedIn === false) return 'logged-out';
    if (st.loggedIn === true) {
      const mismatch =
        (st.email !== '' && st.email !== acc.email) ||
        (st.orgName !== '' && st.orgName !== acc.org);
      return mismatch ? 'logged-in MISMATCH' : 'logged-in';
    }
    return '?';
  }
  if (acc.app === 'codex') {
    if (!(await codexLoggedIn(ctx, acc.store))) return 'logged-out/unknown';
    const email = await codexEmail(ctx, acc.store);
    // 'unknown' was stored because codex gave no email at add time; never a mismatch.
    if (email !== '' && acc.email !== 'unknown' && email !== acc.email) return 'logged-in MISMATCH';
    return 'logged-in';
  }
  return '?';
}
