import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  bindingSet,
  bindingUnset,
  bindingsRemoveId,
  readBindings,
  resolveStore,
} from '../../src/bindings.ts';
import type { Ctx } from '../../src/types.ts';

function makeCtx(t: { after: (fn: () => void) => void }, createHome = true): Ctx {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aienv-bind-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  if (createHome) fs.mkdirSync(home);
  return {
    home,
    storeDir: `${home}/.store`,
    bindingsPath: `${home}/bindings`,
    userHome: root,
    env: {},
    cwd: root,
  };
}

function raw(ctx: Ctx): string {
  return fs.readFileSync(ctx.bindingsPath, 'utf8');
}

function mkStore(ctx: Ctx, id: string): string {
  const p = `${ctx.storeDir}/${id}`;
  fs.mkdirSync(p, { recursive: true });
  return p;
}

// --- parsing ------------------------------------------------------------------

test('readBindings: missing file is empty', (t) => {
  assert.deepEqual(readBindings(makeCtx(t)), []);
});

test('readBindings: tolerates CRLF, blank lines, short lines, empty columns', (t) => {
  const ctx = makeCtx(t);
  fs.writeFileSync(
    ctx.bindingsPath,
    [
      'claude\t/a\tid1\r',
      '',
      '\r',
      'claude\t/short',
      'justoneword',
      'claude\t\tid2',
      '\t/x\tid3',
      'codex\t/b\t',
      'codex\t/b\t\r',
      'codex\t/dir with space\tid4',
      '',
    ].join('\n'),
  );
  assert.deepEqual(readBindings(ctx), [
    { app: 'claude', dir: '/a', id: 'id1' },
    { app: 'codex', dir: '/dir with space', id: 'id4' },
  ]);
});

test('readBindings: final line without newline is read', (t) => {
  const ctx = makeCtx(t);
  fs.writeFileSync(ctx.bindingsPath, 'claude\t/a\tid1\ncodex\t/b\tid2');
  assert.deepEqual(readBindings(ctx), [
    { app: 'claude', dir: '/a', id: 'id1' },
    { app: 'codex', dir: '/b', id: 'id2' },
  ]);
});

test('readBindings: splits on the first two tabs only', (t) => {
  const ctx = makeCtx(t);
  fs.writeFileSync(ctx.bindingsPath, 'claude\t/a\tid\textra\n');
  assert.deepEqual(readBindings(ctx), [{ app: 'claude', dir: '/a', id: 'id\textra' }]);
});

// --- rewrite ------------------------------------------------------------------

test('rewrite keeps an unterminated last line and normalises the file', (t) => {
  const ctx = makeCtx(t);
  fs.writeFileSync(ctx.bindingsPath, 'claude\t/a\tid1\r\n\nbroken\ncodex\t/c\tid3');
  bindingSet(ctx, 'claude', '/b', 'id2');
  assert.equal(raw(ctx), 'claude\t/a\tid1\ncodex\t/c\tid3\nclaude\t/b\tid2\n');
});

test('bindingSet replaces only the same app+dir', (t) => {
  const ctx = makeCtx(t);
  fs.writeFileSync(
    ctx.bindingsPath,
    'claude\t/a\told\ncodex\t/a\tcx\nclaude\t/a/b\tsub\nclaude\t/a\tdup\n',
  );
  bindingSet(ctx, 'claude', '/a', 'new');
  assert.equal(raw(ctx), 'codex\t/a\tcx\nclaude\t/a/b\tsub\nclaude\t/a\tnew\n');
});

test('bindingSet creates home and the file when missing, leaves no temp file', (t) => {
  const ctx = makeCtx(t, false);
  bindingSet(ctx, 'claude', '*', 'g1');
  assert.equal(raw(ctx), 'claude\t*\tg1\n');
  assert.deepEqual(fs.readdirSync(ctx.home), ['bindings']);
});

test('bindingUnset drops the binding and creates the file when missing', (t) => {
  const ctx = makeCtx(t);
  bindingUnset(ctx, 'claude', '/a');
  assert.equal(raw(ctx), '');
  fs.writeFileSync(ctx.bindingsPath, 'claude\t/a\tid1\ncodex\t/a\tid2\nclaude\t/b\tid3\n');
  bindingUnset(ctx, 'claude', '/a');
  assert.equal(raw(ctx), 'codex\t/a\tid2\nclaude\t/b\tid3\n');
  assert.deepEqual(fs.readdirSync(ctx.home), ['bindings']);
});

test('bindingsRemoveId drops the id across apps', (t) => {
  const ctx = makeCtx(t);
  fs.writeFileSync(
    ctx.bindingsPath,
    'claude\t/a\tdead\ncodex\t/b\tdead\nclaude\t*\tkeep\nopencode\t/c\tdead',
  );
  bindingsRemoveId(ctx, 'dead');
  assert.equal(raw(ctx), 'claude\t*\tkeep\n');
});

// --- resolve ------------------------------------------------------------------

test('resolveStore: none without file or matching binding', (t) => {
  const ctx = makeCtx(t);
  const none = { id: '', dir: '', dangling: false };
  assert.deepEqual(resolveStore(ctx, 'claude', '/a'), none);
  fs.writeFileSync(ctx.bindingsPath, 'codex\t/a\tid1\nclaude\t/other\tid2\n');
  assert.deepEqual(resolveStore(ctx, 'claude', '/a'), none);
});

test('resolveStore: nearest ancestor wins regardless of line order', (t) => {
  const ctx = makeCtx(t);
  mkStore(ctx, 'outer');
  mkStore(ctx, 'inner');
  fs.writeFileSync(ctx.bindingsPath, 'claude\t/a/b\tinner\nclaude\t/a\touter\nclaude\t/a/b/c/d\tdeep\n');
  assert.deepEqual(resolveStore(ctx, 'claude', '/a/b/c'), {
    id: 'inner',
    dir: '/a/b',
    dangling: false,
  });
  assert.equal(resolveStore(ctx, 'claude', '/a/b').id, 'inner');
  assert.equal(resolveStore(ctx, 'claude', '/a/x').id, 'outer');
});

test('resolveStore: a prefix that is not a path ancestor does not match', (t) => {
  const ctx = makeCtx(t);
  mkStore(ctx, 'id1');
  fs.writeFileSync(ctx.bindingsPath, 'claude\t/a/b\tid1\n');
  assert.equal(resolveStore(ctx, 'claude', '/a/bc').id, '');
  assert.equal(resolveStore(ctx, 'claude', '/a').id, '');
});

test('resolveStore: trailing slash on the binding dir is ignored, dir reported verbatim', (t) => {
  const ctx = makeCtx(t);
  mkStore(ctx, 'id1');
  fs.writeFileSync(ctx.bindingsPath, 'claude\t/a/b/\tid1\n');
  const r = resolveStore(ctx, 'claude', '/a/b/c');
  assert.equal(r.id, 'id1');
  assert.equal(r.dir, '/a/b/');
});

test("resolveStore: '/' binding matches everything but loses to a nearer one", (t) => {
  const ctx = makeCtx(t);
  mkStore(ctx, 'root');
  mkStore(ctx, 'near');
  mkStore(ctx, 'glob');
  fs.writeFileSync(ctx.bindingsPath, 'claude\t*\tglob\nclaude\t/\troot\nclaude\t/a\tnear\n');
  assert.deepEqual(resolveStore(ctx, 'claude', '/zzz/y'), {
    id: 'root',
    dir: '/',
    dangling: false,
  });
  assert.equal(resolveStore(ctx, 'claude', '/').id, 'root');
  assert.equal(resolveStore(ctx, 'claude', '/a/q').id, 'near');
});

test('resolveStore: global fallback uses the first * line; dir beats global', (t) => {
  const ctx = makeCtx(t);
  mkStore(ctx, 'g1');
  mkStore(ctx, 'g2');
  mkStore(ctx, 'd1');
  fs.writeFileSync(ctx.bindingsPath, 'codex\t*\tcx\nclaude\t*\tg1\nclaude\t*\tg2\nclaude\t/a\td1\n');
  assert.deepEqual(resolveStore(ctx, 'claude', '/elsewhere'), {
    id: 'g1',
    dir: '*',
    dangling: false,
  });
  assert.equal(resolveStore(ctx, 'claude', '/a/b').id, 'd1');
});

test('resolveStore: first line wins among duplicates', (t) => {
  const ctx = makeCtx(t);
  mkStore(ctx, 'first');
  mkStore(ctx, 'second');
  fs.writeFileSync(ctx.bindingsPath, 'claude\t/a\tfirst\nclaude\t/a\tsecond\n');
  assert.equal(resolveStore(ctx, 'claude', '/a').id, 'first');
});

test('resolveStore: dangling when the store is missing or not a directory', (t) => {
  const ctx = makeCtx(t);
  fs.writeFileSync(ctx.bindingsPath, 'claude\t/a\tgone\ncodex\t*\tfile\n');
  assert.deepEqual(resolveStore(ctx, 'claude', '/a/b'), {
    id: 'gone',
    dir: '/a',
    dangling: true,
  });
  fs.mkdirSync(ctx.storeDir);
  fs.writeFileSync(`${ctx.storeDir}/file`, '');
  assert.deepEqual(resolveStore(ctx, 'codex', '/q'), {
    id: 'file',
    dir: '*',
    dangling: true,
  });
});
