// Bindings file ($AIENV_HOME/bindings, TSV: app<TAB>dir<TAB>id). Rewrites go through a
// temp file + rename, so readers (the shim) never see a torn file.

import fs from 'node:fs';
import path from 'node:path';

import type { App, Ctx, Resolution } from './types.ts';

export type Binding = { app: string; dir: string; id: string };

function stripCr(value: string): string {
  return value.endsWith('\r') ? value.slice(0, -1) : value;
}

/** One line -> binding, or null for blank lines and lines with an empty column. */
function parseLine(line: string): Binding | null {
  const t1 = line.indexOf('\t');
  if (t1 < 0) return null;
  const t2 = line.indexOf('\t', t1 + 1);
  if (t2 < 0) return null;
  const app = stripCr(line.slice(0, t1));
  const dir = stripCr(line.slice(t1 + 1, t2));
  const id = stripCr(line.slice(t2 + 1));
  if (app === '' || dir === '' || id === '') return null;
  return { app, dir, id };
}

/** A missing (or non-regular) bindings file reads as empty. */
export function readBindings(ctx: Ctx): Binding[] {
  let text: string;
  try {
    if (!fs.statSync(ctx.bindingsPath).isFile()) return [];
    text = fs.readFileSync(ctx.bindingsPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: Binding[] = [];
  // A final line without '\n' is simply the last element of the split.
  for (const line of text.split('\n')) {
    const b = parseLine(line);
    if (b) out.push(b);
  }
  return out;
}

// --- rewrite ----------------------------------------------------------------

function formatLine(b: Binding): string {
  return `${b.app}\t${b.dir}\t${b.id}\n`;
}

function rewrite(ctx: Ctx, keep: (b: Binding) => boolean, append?: Binding): void {
  fs.mkdirSync(ctx.home, { recursive: true });
  const tmp = path.join(ctx.home, `.bindings.${process.pid}`);
  const kept = readBindings(ctx).filter(keep);
  if (append) kept.push(append);
  try {
    fs.writeFileSync(tmp, kept.map(formatLine).join(''));
    fs.renameSync(tmp, ctx.bindingsPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // nothing to clean up
    }
    throw err;
  }
}

export function bindingSet(ctx: Ctx, app: App, dir: string, id: string): void {
  rewrite(ctx, (b) => b.app !== app || b.dir !== dir, { app, dir, id });
}

export function bindingUnset(ctx: Ctx, app: App, dir: string): void {
  rewrite(ctx, (b) => b.app !== app || b.dir !== dir);
}

export function bindingsRemoveId(ctx: Ctx, id: string): void {
  rewrite(ctx, (b) => b.id !== id);
}

// --- resolve ----------------------------------------------------------------

/** Nearest ancestor wins; a '/' binding matches everything; '*' is the fallback; first
 *  line wins among duplicates. `dir` is already absolute+resolved. */
export function resolveStore(ctx: Ctx, app: App, dir: string): Resolution {
  let best = '';
  let bestDir = '';
  let bestLen = -1;
  let glob = '';
  for (const b of readBindings(ctx)) {
    if (b.app !== app) continue;
    if (b.dir === '*') {
      if (glob === '') glob = b.id;
      continue;
    }
    const stripped = b.dir.endsWith('/') ? b.dir.slice(0, -1) : b.dir;
    if (stripped === '' || dir === stripped || dir.startsWith(`${stripped}/`)) {
      const len = Array.from(b.dir).length; // zsh ${#d} counts characters
      if (len > bestLen) {
        bestLen = len;
        best = b.id;
        bestDir = b.dir;
      }
    }
  }

  let source: Resolution['source'];
  let outDir: string;
  if (best !== '') {
    source = 'dir';
    outDir = bestDir;
  } else if (glob !== '') {
    best = glob;
    source = 'global';
    outDir = '*';
  } else {
    return { store: null, id: '', source: 'none', dir: '', dangling: false };
  }

  const store = `${ctx.storeDir}/${best}`; // no normalisation: printed verbatim by `resolve`
  let isDir = false;
  try {
    isDir = fs.statSync(store).isDirectory();
  } catch {
    isDir = false;
  }
  return isDir
    ? { store, id: best, source, dir: outDir, dangling: false }
    : { store: null, id: best, source, dir: outDir, dangling: true };
}
