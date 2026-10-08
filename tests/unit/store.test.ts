import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import {
  CLAUDE_SHARED,
  accountLabel,
  accountsLoad,
  displayLinkPath,
  genId,
  linkClaudeShared,
  metaRead,
  metaWrite,
  sanitize,
  selectAccount,
} from '../../src/store.ts';
import { AienvError } from '../../src/types.ts';
import type { Account, App, Ctx } from '../../src/types.ts';

function mkCtx(t: { after: (fn: () => void) => void }): { ctx: Ctx; tmp: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aienv-store-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, '.aienv');
  const userHome = path.join(tmp, 'home');
  fs.mkdirSync(path.join(home, '.store'), { recursive: true });
  fs.mkdirSync(userHome, { recursive: true });
  const ctx: Ctx = {
    home,
    storeDir: path.join(home, '.store'),
    bindingsPath: path.join(home, 'bindings'),
    lockDir: path.join(home, '.lock'),
    userHome,
    env: {},
    cwd: tmp,
  };
  return { ctx, tmp };
}

function addAccount(ctx: Ctx, id: string, app: App, org: string, email: string): Account {
  const store = path.join(ctx.storeDir, id);
  fs.mkdirSync(store, { recursive: true });
  metaWrite(store, app, org, email);
  return { id, app, org, email, store };
}

function throwsAienv(fn: () => unknown, message: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof AienvError);
    assert.equal(err.message, message);
    assert.equal(err.exitCode, 1);
    return true;
  });
}

// --- sanitize ------------------------------------------------------------------

test('sanitize: plain values pass through', () => {
  assert.equal(sanitize('me@example.com'), 'me@example.com');
  assert.equal(sanitize('Acme Inc'), 'Acme Inc');
  assert.equal(sanitize('a.b-c'), 'a.b-c');
});

test('sanitize: control chars and slashes become _', () => {
  assert.equal(sanitize('a\tb\nc\x7fd\x00e'), 'a_b_c_d_e');
  assert.equal(sanitize('a/b//c'), 'a_b__c');
  assert.equal(sanitize('../../etc'), '_.._.._etc');
  assert.equal(sanitize('/'), '_');
});

test('sanitize: empty, dot and dotdot become _', () => {
  assert.equal(sanitize(''), '_');
  assert.equal(sanitize('.'), '_');
  assert.equal(sanitize('..'), '_');
});

test('sanitize: lone dash kept, leading dash or dot prefixed', () => {
  assert.equal(sanitize('-'), '-');
  assert.equal(sanitize('--'), '_--');
  assert.equal(sanitize('-rf'), '_-rf');
  assert.equal(sanitize('.hidden'), '_.hidden');
  assert.equal(sanitize('...'), '_...');
});

// --- genId ---------------------------------------------------------------------

test('genId: 8 lowercase hex chars, not an existing store', (t) => {
  const { ctx } = mkCtx(t);
  const seen = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const id = genId(ctx);
    assert.match(id, /^[0-9a-f]{8}$/);
    assert.equal(fs.existsSync(path.join(ctx.storeDir, id)), false);
    fs.mkdirSync(path.join(ctx.storeDir, id));
    seen.add(id);
  }
  assert.equal(seen.size, 20);
});

test('genId: works when the store dir does not exist yet', (t) => {
  const { ctx } = mkCtx(t);
  fs.rmSync(ctx.storeDir, { recursive: true });
  assert.match(genId(ctx), /^[0-9a-f]{8}$/);
});

// --- meta ----------------------------------------------------------------------

test('meta: round trip and exact on-disk format', (t) => {
  const { ctx } = mkCtx(t);
  const store = path.join(ctx.storeDir, 'aaaa0001');
  fs.mkdirSync(store);
  metaWrite(store, 'claude', 'Acme', 'me@example.com');
  const file = path.join(store, '.aienv-meta');
  assert.equal(fs.readFileSync(file, 'utf8'), 'app=claude\norg=Acme\nemail=me@example.com\n');
  assert.deepEqual(metaRead(file), { app: 'claude', org: 'Acme', email: 'me@example.com' });
});

test('meta: value may contain =', (t) => {
  const { ctx } = mkCtx(t);
  const store = path.join(ctx.storeDir, 'aaaa0002');
  fs.mkdirSync(store);
  metaWrite(store, 'codex', 'a=b=c', 'x=y@example.com');
  assert.deepEqual(metaRead(path.join(store, '.aienv-meta')), {
    app: 'codex',
    org: 'a=b=c',
    email: 'x=y@example.com',
  });
});

test('meta: CRLF, missing final newline, unknown keys, defaults', (t) => {
  const { tmp } = mkCtx(t);
  const f = path.join(tmp, 'meta');
  fs.writeFileSync(f, 'app=claude\r\nother=zzz\r\norg=Acme\r\nemail=me@example.com\r');
  assert.deepEqual(metaRead(f), { app: 'claude', org: 'Acme', email: 'me@example.com' });
  fs.writeFileSync(f, 'app=codex');
  assert.deepEqual(metaRead(f), { app: 'codex', org: '-', email: '' });
  fs.writeFileSync(f, '');
  assert.deepEqual(metaRead(f), { app: '', org: '-', email: '' });
});

// --- accountsLoad / accountLabel -----------------------------------------------

test('accountsLoad: filters by app, skips dirs without meta, sorted by id', (t) => {
  const { ctx } = mkCtx(t);
  addAccount(ctx, 'cccc0003', 'claude', 'Acme', 'c@example.com');
  addAccount(ctx, 'aaaa0001', 'claude', '-', 'a@example.com');
  addAccount(ctx, 'bbbb0002', 'codex', '-', 'b@example.com');
  fs.mkdirSync(path.join(ctx.storeDir, 'dddd0004')); // no meta
  fs.writeFileSync(path.join(ctx.storeDir, 'eeee0005'), 'a file, not a dir');
  addAccount(ctx, '.hidden', 'claude', '-', 'hidden@example.com'); // not matched by the glob

  assert.deepEqual(accountsLoad(ctx, 'claude'), [
    { id: 'aaaa0001', app: 'claude', org: '-', email: 'a@example.com', store: path.join(ctx.storeDir, 'aaaa0001') },
    { id: 'cccc0003', app: 'claude', org: 'Acme', email: 'c@example.com', store: path.join(ctx.storeDir, 'cccc0003') },
  ]);
  assert.deepEqual(accountsLoad(ctx, 'codex').map((a) => a.id), ['bbbb0002']);
  assert.deepEqual(accountsLoad(ctx, 'opencode'), []);
});

test('accountsLoad: missing store dir yields no accounts', (t) => {
  const { ctx } = mkCtx(t);
  fs.rmSync(ctx.storeDir, { recursive: true });
  assert.deepEqual(accountsLoad(ctx, 'claude'), []);
});

test('accountLabel: org/email when known, id otherwise', (t) => {
  const { ctx } = mkCtx(t);
  addAccount(ctx, 'aaaa0001', 'claude', 'Acme', 'a@example.com');
  assert.equal(accountLabel(ctx, 'claude', 'aaaa0001'), 'Acme/a@example.com');
  assert.equal(accountLabel(ctx, 'claude', 'ffff9999'), 'ffff9999');
  assert.equal(accountLabel(ctx, 'codex', 'aaaa0001'), 'aaaa0001');
});

// --- selectAccount -------------------------------------------------------------

function seedSelect(ctx: Ctx): void {
  addAccount(ctx, 'aaaa0001', 'claude', 'Acme', 'me@example.com');
  addAccount(ctx, 'bbbb0002', 'claude', 'Beta', 'me@example.com');
  addAccount(ctx, 'cccc0003', 'claude', '-', 'Solo@Example.org');
  addAccount(ctx, 'dddd0004', 'codex', '-', 'me@example.com');
}

test('selectAccount: exact id', (t) => {
  const { ctx } = mkCtx(t);
  seedSelect(ctx);
  assert.equal(selectAccount(ctx, 'claude', 'bbbb0002').id, 'bbbb0002');
});

test('selectAccount: exact org/email', (t) => {
  const { ctx } = mkCtx(t);
  seedSelect(ctx);
  const acc = selectAccount(ctx, 'claude', 'Beta/me@example.com');
  assert.deepEqual(acc, {
    id: 'bbbb0002',
    app: 'claude',
    org: 'Beta',
    email: 'me@example.com',
    store: path.join(ctx.storeDir, 'bbbb0002'),
  });
});

test('selectAccount: exact email', (t) => {
  const { ctx } = mkCtx(t);
  seedSelect(ctx);
  assert.equal(selectAccount(ctx, 'claude', 'Solo@Example.org').id, 'cccc0003');
  assert.equal(selectAccount(ctx, 'codex', 'me@example.com').id, 'dddd0004');
});

test('selectAccount: unique case-insensitive substring', (t) => {
  const { ctx } = mkCtx(t);
  seedSelect(ctx);
  assert.equal(selectAccount(ctx, 'claude', 'solo@').id, 'cccc0003');
  assert.equal(selectAccount(ctx, 'claude', 'ACME').id, 'aaaa0001');
});

test('selectAccount: precedence id > full > email > substring', (t) => {
  const { ctx } = mkCtx(t);
  // id tier beats an account whose email equals that id
  addAccount(ctx, 'aaaa0001', 'claude', '-', 'x@example.com');
  addAccount(ctx, 'bbbb0002', 'claude', '-', 'aaaa0001');
  assert.equal(selectAccount(ctx, 'claude', 'aaaa0001').id, 'aaaa0001');
  // full tier beats an account whose email equals 'org/email' of another
  addAccount(ctx, 'cccc0003', 'claude', 'Org', 'y@example.com');
  addAccount(ctx, 'dddd0004', 'claude', '-', 'Org/y@example.com');
  assert.equal(selectAccount(ctx, 'claude', 'Org/y@example.com').id, 'cccc0003');
  // email tier beats substring hits: 'z@example.com' is also a substring of 'zz@example.com'
  addAccount(ctx, 'eeee0005', 'claude', '-', 'z@example.com');
  addAccount(ctx, 'ffff0006', 'claude', '-', 'zz@example.com');
  assert.equal(selectAccount(ctx, 'claude', 'z@example.com').id, 'eeee0005');
});

test('selectAccount: an ambiguous earlier tier does not fall through', (t) => {
  const { ctx } = mkCtx(t);
  seedSelect(ctx);
  // exact email hits 2 accounts -> error, even though nothing else would disambiguate
  throwsAienv(
    () => selectAccount(ctx, 'claude', 'me@example.com'),
    [
      "'me@example.com' matches 2 claude accounts:",
      '  Acme/me@example.com  (aaaa0001)',
      '  Beta/me@example.com  (bbbb0002)',
      '  -/Solo@Example.org  (cccc0003)',
    ].join('\n'),
  );
});

test('selectAccount: no match lists candidates of that app only', (t) => {
  const { ctx } = mkCtx(t);
  seedSelect(ctx);
  throwsAienv(
    () => selectAccount(ctx, 'claude', 'nobody'),
    [
      "no claude account matches 'nobody'. candidates:",
      '  Acme/me@example.com  (aaaa0001)',
      '  Beta/me@example.com  (bbbb0002)',
      '  -/Solo@Example.org  (cccc0003)',
    ].join('\n'),
  );
  throwsAienv(() => selectAccount(ctx, 'opencode', 'x'), "no opencode account matches 'x'. candidates:");
});

test('selectAccount: ambiguous substring', (t) => {
  const { ctx } = mkCtx(t);
  seedSelect(ctx);
  throwsAienv(
    () => selectAccount(ctx, 'claude', 'EXAMPLE'),
    [
      "'EXAMPLE' matches 3 claude accounts:",
      '  Acme/me@example.com  (aaaa0001)',
      '  Beta/me@example.com  (bbbb0002)',
      '  -/Solo@Example.org  (cccc0003)',
    ].join('\n'),
  );
});

// --- displayLinkPath -----------------------------------------------------------

test('displayLinkPath: creates the org dir and returns the sanitized path', (t) => {
  const { ctx } = mkCtx(t);
  const link = displayLinkPath(ctx, 'claude', 'Acme/Inc', '.me@example.com');
  assert.equal(link, `${ctx.home}/claude/Acme_Inc/_.me@example.com`);
  assert.ok(fs.statSync(`${ctx.home}/claude/Acme_Inc`).isDirectory());
  assert.equal(fs.lstatSync(link, { throwIfNoEntry: false }), undefined);
  assert.equal(displayLinkPath(ctx, 'codex', '-', 'unknown'), `${ctx.home}/codex/-/unknown`);
  // traversal attempts collapse into one component
  assert.equal(displayLinkPath(ctx, 'codex', '..', '../x'), `${ctx.home}/codex/_/_.._x`);
});

test('displayLinkPath: refuses an org dir that is a symlink pointing outside', (t) => {
  const { ctx, tmp } = mkCtx(t);
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(outside);
  fs.mkdirSync(`${ctx.home}/claude`);
  fs.symlinkSync(outside, `${ctx.home}/claude/Evil`);
  throwsAienv(
    () => displayLinkPath(ctx, 'claude', 'Evil', 'me@example.com'),
    `refusing to create a display symlink outside ${ctx.home}/claude`,
  );
  // a symlink back to the base itself is not strictly inside either
  fs.symlinkSync('.', `${ctx.home}/claude/Self`);
  throwsAienv(
    () => displayLinkPath(ctx, 'claude', 'Self', 'me@example.com'),
    `refusing to create a display symlink outside ${ctx.home}/claude`,
  );
});

test('displayLinkPath: works when AIENV_HOME itself is reached through a symlink', (t) => {
  const { ctx, tmp } = mkCtx(t);
  const alias = path.join(tmp, 'alias');
  fs.symlinkSync(ctx.home, alias);
  const ctx2: Ctx = { ...ctx, home: alias, storeDir: `${alias}/.store` };
  assert.equal(displayLinkPath(ctx2, 'claude', 'Acme', 'a@example.com'), `${alias}/claude/Acme/a@example.com`);
});

// --- linkClaudeShared ----------------------------------------------------------

test('CLAUDE_SHARED matches the spec and holds no credentials', () => {
  assert.deepEqual(
    [...CLAUDE_SHARED],
    ['CLAUDE.md', 'settings.json', 'skills', 'agents', 'commands', 'hooks', 'rules', 'keybindings.json', 'projects'],
  );
});

test('linkClaudeShared: links existing items, creates projects, skips the rest', (t) => {
  const { ctx } = mkCtx(t);
  const claude = path.join(ctx.userHome, '.claude');
  fs.mkdirSync(path.join(claude, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'CLAUDE.md'), 'rules');
  fs.writeFileSync(path.join(claude, 'settings.json'), '{}');
  fs.writeFileSync(path.join(claude, '.credentials.json'), 'never linked');
  const acc = addAccount(ctx, 'aaaa0001', 'claude', '-', 'a@example.com');
  // already present in the store: a real file and a dangling symlink
  fs.writeFileSync(path.join(acc.store, 'settings.json'), '{"own":true}');
  fs.symlinkSync('/nonexistent/aienv-test', path.join(acc.store, 'skills'));

  linkClaudeShared(ctx, acc.store);

  assert.ok(fs.statSync(path.join(claude, 'projects')).isDirectory());
  assert.equal(fs.readlinkSync(path.join(acc.store, 'CLAUDE.md')), path.join(claude, 'CLAUDE.md'));
  assert.equal(fs.readlinkSync(path.join(acc.store, 'projects')), path.join(claude, 'projects'));
  assert.equal(fs.readFileSync(path.join(acc.store, 'settings.json'), 'utf8'), '{"own":true}');
  assert.equal(fs.lstatSync(path.join(acc.store, 'settings.json')).isSymbolicLink(), false);
  assert.equal(fs.readlinkSync(path.join(acc.store, 'skills')), '/nonexistent/aienv-test');
  for (const absent of ['agents', 'commands', 'hooks', 'rules', 'keybindings.json', '.credentials.json']) {
    assert.equal(fs.lstatSync(path.join(acc.store, absent), { throwIfNoEntry: false }), undefined, absent);
  }
  // idempotent
  linkClaudeShared(ctx, acc.store);
  assert.deepEqual(fs.readdirSync(acc.store).sort(), ['.aienv-meta', 'CLAUDE.md', 'projects', 'settings.json', 'skills']);
});
