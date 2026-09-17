// aienv entry point: builds the Ctx, dispatches, maps errors to stderr + exit codes and
// cleans up on exit / SIGINT (130) / SIGTERM (143).
// Installed as $AIENV_HOME/lib/aienv/cli.ts and run with `node` (native type stripping).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AienvError } from './types.ts';
import type { Ctx } from './types.ts';
import { releaseLockIfHeld } from './bindings.ts';
import { cmdAdd, cmdRemove, cmdResolve, cmdShow, cmdSwitch, usage } from './commands.ts';

function isDir(p: string): boolean {
  return fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Explicit AIENV_HOME wins, else derive from this script's own location
 *  (<home>/lib/aienv/cli.ts with <home>/.store present), else the default. */
function deriveHome(env: Record<string, string | undefined>, userHome: string): string {
  const explicit = env.AIENV_HOME;
  if (explicit !== undefined && explicit !== '') return explicit;
  const dir = path.dirname(realpathOr(fileURLToPath(import.meta.url)));
  const lib = path.dirname(dir);
  const candidate = path.dirname(lib);
  if (path.basename(dir) === 'aienv' && path.basename(lib) === 'lib' && isDir(path.join(candidate, '.store'))) {
    return candidate;
  }
  return `${userHome}/.aienv`;
}

/** $PWD when it is absolute and names the process's working directory. */
function logicalCwd(env: Record<string, string | undefined>): string {
  const physical = process.cwd();
  const pwd = env.PWD;
  if (pwd !== undefined && path.isAbsolute(pwd)) {
    try {
      if (fs.realpathSync(pwd) === fs.realpathSync(physical)) return pwd;
    } catch {
      // stale $PWD: fall through
    }
  }
  return physical;
}

function buildCtx(): Ctx {
  const env: Record<string, string | undefined> = { ...process.env };
  const userHome = env.HOME !== undefined && env.HOME !== '' ? env.HOME : os.homedir();
  const home = deriveHome(env, userHome);
  return {
    home,
    storeDir: `${home}/.store`,
    bindingsPath: `${home}/bindings`,
    lockDir: `${home}/.lock`,
    userHome,
    env,
    cwd: logicalCwd(env),
  };
}

async function main(ctx: Ctx, argv: string[]): Promise<number> {
  const cmd = argv.length > 0 ? argv[0]! : 'help';
  const rest = argv.slice(1);
  switch (cmd) {
    case 'add':
      return cmdAdd(ctx, rest);
    case 'switch':
      return cmdSwitch(ctx, rest);
    case 'show':
      return cmdShow(ctx, rest);
    case 'remove':
    case 'rm':
      return cmdRemove(ctx, rest);
    case 'resolve':
      return cmdResolve(ctx, rest);
    case 'help':
    case '-h':
    case '--help':
      process.stdout.write(usage(ctx));
      return 0;
    default:
      throw new AienvError(`unknown command: ${cmd}`, 2, true);
  }
}

const ctx = buildCtx();

function cleanup(): void {
  try {
    releaseLockIfHeld(ctx);
  } catch {
    // best effort
  }
}

process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(143);
});

let code: number;
try {
  code = await main(ctx, process.argv.slice(2));
} catch (e) {
  if (e instanceof AienvError) {
    process.stderr.write(`aienv: ${e.message}\n`);
    if (e.showUsage) process.stderr.write(usage(ctx));
    code = e.exitCode;
  } else {
    process.stderr.write(`aienv: internal error: ${e instanceof Error ? e.message : String(e)}\n`);
    code = 1;
  }
}
cleanup();
process.exit(code);
