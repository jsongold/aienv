import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  ALL_KEY_VARS,
  accountStatus,
  captureApp,
  captureAppAsync,
  codexEmail,
  defaultIdentity,
  detectIdentity,
  envVarFor,
  findRealBin,
  firstInPath,
  keyVarsFor,
  loginArgs,
  logoutArgs,
  runApp,
} from '../../src/agents.ts';
import type { Account, App, Ctx } from '../../src/types.ts';

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aienv-agents-')));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

let seq = 0;
function mkdir(name: string): string {
  const dir = path.join(ROOT, `${name}-${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function script(dir: string, name: string, body: string, mode = 0o755): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  fs.chmodSync(file, mode);
  return file;
}

function makeCtx(pathDirs: string[], extraEnv: Record<string, string> = {}): Ctx {
  const home = mkdir('home');
  fs.mkdirSync(path.join(home, 'bin'));
  fs.mkdirSync(path.join(home, '.store'));
  return {
    home,
    storeDir: path.join(home, '.store'),
    bindingsPath: path.join(home, 'bindings'),
    lockDir: path.join(home, '.lock'),
    userHome: mkdir('user'),
    env: { PATH: [...pathDirs, '/usr/bin', '/bin'].join(':'), ...extraEnv },
    cwd: ROOT,
  };
}

function account(app: App, org: string, email: string): Account {
  return { id: 'abcd1234', app, org, email, store: mkdir('store') };
}

const CLAUDE_STATUS = (json: string): string =>
  `#!/bin/sh\nif [ "$1" = auth ] && [ "$2" = status ]; then\ncat <<'EOF'\n${json}\nEOF\nexit 0\nfi\nexit 9\n`;

const CODEX_OK = `#!/bin/sh
if [ "$1" = login ] && [ "$2" = status ]; then echo 'Logged in using ChatGPT'; exit 0; fi
if [ "$1" = app-server ]; then
  while read -r line; do
    case $line in
      *'"account/read"'*)
        printf '{"id":1,"result":{}}\\n'
        printf 'not json\\n'
        printf '{"id":2,"result":{"account":{"type":"chatgpt","email":"%s","planType":"plus"},"requiresOpenaiAuth":false}}\\n' "$FAKE_CODEX_EMAIL"
        ;;
    esac
  done
  exit 0
fi
exit 0
`;

test('static tables', () => {
  assert.equal(envVarFor('claude'), 'CLAUDE_CONFIG_DIR');
  assert.equal(envVarFor('codex'), 'CODEX_HOME');
  assert.equal(envVarFor('opencode'), 'XDG_DATA_HOME');
  assert.deepEqual(keyVarsFor('claude'), [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
  ]);
  assert.deepEqual(keyVarsFor('codex'), ['OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN']);
  assert.deepEqual(keyVarsFor('opencode'), ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
  assert.deepEqual(ALL_KEY_VARS, [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'OPENAI_API_KEY',
    'CODEX_ACCESS_TOKEN',
  ]);
  assert.deepEqual(loginArgs('claude'), ['auth', 'login']);
  assert.deepEqual(loginArgs('codex'), ['login']);
  assert.deepEqual(loginArgs('opencode'), ['auth', 'login']);
  assert.deepEqual(logoutArgs('claude'), ['auth', 'logout']);
  assert.deepEqual(logoutArgs('codex'), ['logout']);
  assert.deepEqual(logoutArgs('opencode'), ['auth', 'logout']);
});

test('findRealBin skips the shim dir, even through a symlink', () => {
  const real = mkdir('real');
  const bin = script(real, 'claude', '#!/bin/sh\nexit 0\n');
  const ctx = makeCtx([]);
  script(path.join(ctx.home, 'bin'), 'claude', '#!/bin/sh\nexit 0\n');
  const alias = path.join(ROOT, `alias-${++seq}`);
  fs.symlinkSync(path.join(ctx.home, 'bin'), alias);
  ctx.env.PATH = `${alias}:${path.join(ctx.home, 'bin')}:${real}:/usr/bin:/bin`;
  assert.equal(findRealBin(ctx, 'claude'), bin);
  assert.equal(firstInPath(ctx, 'claude'), path.join(ctx.home, 'bin'));
});

test('findRealBin skips a shim copy, non-executables, directories and missing dirs', () => {
  const shimCopy = mkdir('shimcopy');
  script(shimCopy, 'claude', '#!/bin/zsh -f\n# aienv-shim\nexit 0\n');
  const noexec = mkdir('noexec');
  script(noexec, 'claude', '#!/bin/sh\nexit 0\n', 0o644);
  const asDir = mkdir('asdir');
  fs.mkdirSync(path.join(asDir, 'claude'));
  const real = mkdir('real');
  const bin = script(real, 'claude', '#!/bin/sh\n# not a shim\nexit 0\n');
  const ctx = makeCtx([shimCopy, path.join(ROOT, 'does-not-exist'), noexec, asDir, real]);
  assert.equal(findRealBin(ctx, 'claude'), bin);
  // firstInPath includes shim copies.
  assert.equal(firstInPath(ctx, 'claude'), shimCopy);
  assert.equal(findRealBin(ctx, 'opencode'), null);
  assert.equal(firstInPath(ctx, 'opencode'), null);
});

test('findRealBin follows a symlinked binary and resolves the directory', () => {
  const target = mkdir('target');
  const bin = script(target, 'claude-real', '#!/bin/sh\nexit 0\n');
  const real = mkdir('real');
  fs.symlinkSync(bin, path.join(real, 'claude'));
  const alias = path.join(ROOT, `alias-${++seq}`);
  fs.symlinkSync(real, alias);
  const ctx = makeCtx([alias]);
  assert.equal(findRealBin(ctx, 'claude'), path.join(real, 'claude'));
  assert.equal(firstInPath(ctx, 'claude'), real);
});

test('empty PATH entry means cwd', () => {
  const cwd = mkdir('cwd');
  const bin = script(cwd, 'codex', '#!/bin/sh\nexit 0\n');
  const ctx = makeCtx([]);
  ctx.cwd = cwd;
  ctx.env.PATH = ':/usr/bin:/bin';
  assert.equal(findRealBin(ctx, 'codex'), bin);
  assert.equal(firstInPath(ctx, 'codex'), cwd);
  ctx.env.PATH = undefined;
  assert.equal(findRealBin(ctx, 'codex'), null);
  assert.equal(firstInPath(ctx, 'codex'), null);
});

test('runApp sets the config var, removes key vars, passes args and the exit code', () => {
  const real = mkdir('real');
  script(
    real,
    'claude',
    '#!/bin/sh\n{ echo "CFG=${CLAUDE_CONFIG_DIR-unset}"; echo "AKEY=${ANTHROPIC_API_KEY-unset}"; echo "OKEY=${OPENAI_API_KEY-unset}"; echo "ARGS=$*"; } > "$OUT_FILE"\nexit 7\n',
  );
  const out = path.join(mkdir('out'), 'env.txt');
  const ctx = makeCtx([real], {
    OUT_FILE: out,
    ANTHROPIC_API_KEY: 'k1',
    OPENAI_API_KEY: 'k2',
    CLAUDE_CONFIG_DIR: '/elsewhere',
  });
  assert.equal(runApp(ctx, 'claude', '/the/store', ['a b', 'c']), 7);
  assert.equal(
    fs.readFileSync(out, 'utf8'),
    'CFG=/the/store\nAKEY=unset\nOKEY=k2\nARGS=a b c\n',
  );
  // ctx.env itself is untouched.
  assert.equal(ctx.env.ANTHROPIC_API_KEY, 'k1');
  assert.equal(ctx.env.CLAUDE_CONFIG_DIR, '/elsewhere');
});

test('runApp returns 127 without a real binary and 128+n on a signal', () => {
  assert.equal(runApp(makeCtx([]), 'claude', '/s', []), 127);
  const real = mkdir('real');
  script(real, 'codex', '#!/bin/sh\nkill -TERM $$\nsleep 5\n');
  assert.equal(runApp(makeCtx([real]), 'codex', '/s', []), 128 + 15);
});

test('captureApp captures stdout; null on failure or missing binary', () => {
  const real = mkdir('real');
  script(
    real,
    'codex',
    '#!/bin/sh\nif [ "$1" = fail ]; then echo partial; exit 3; fi\necho "noise" >&2\necho "HOME=${CODEX_HOME-unset} KEY=${OPENAI_API_KEY-unset}"\n',
  );
  const ctx = makeCtx([real], { OPENAI_API_KEY: 'k', CODEX_HOME: '/user/codex' });
  assert.equal(captureApp(ctx, 'codex', '/st', []), 'HOME=/st KEY=unset\n');
  // store null: codex keeps the user's CODEX_HOME.
  assert.equal(captureApp(ctx, 'codex', null, []), 'HOME=/user/codex KEY=unset\n');
  assert.equal(captureApp(ctx, 'codex', '/st', ['fail']), null);
  assert.equal(captureApp(makeCtx([]), 'codex', '/st', []), null);
});

test('captureAppAsync matches captureApp: stdout, env, failure, timeout', async () => {
  const real = mkdir('real');
  script(
    real,
    'codex',
    '#!/bin/sh\nif [ "$1" = fail ]; then echo partial; exit 3; fi\nif [ "$1" = hang ]; then sleep 5; fi\necho "noise" >&2\necho "HOME=${CODEX_HOME-unset} KEY=${OPENAI_API_KEY-unset}"\n',
  );
  const ctx = makeCtx([real], { OPENAI_API_KEY: 'k', CODEX_HOME: '/user/codex' });
  assert.equal(await captureAppAsync(ctx, 'codex', '/st', []), 'HOME=/st KEY=unset\n');
  assert.equal(await captureAppAsync(ctx, 'codex', null, []), 'HOME=/user/codex KEY=unset\n');
  assert.equal(await captureAppAsync(ctx, 'codex', '/st', ['fail']), null);
  assert.equal(await captureAppAsync(ctx, 'codex', '/st', ['hang'], 200), null);
  assert.equal(await captureAppAsync(makeCtx([]), 'codex', '/st', []), null);
});

test('captureApp with store null unsets CLAUDE_CONFIG_DIR for claude', () => {
  const real = mkdir('real');
  script(real, 'claude', '#!/bin/sh\necho "CFG=${CLAUDE_CONFIG_DIR-unset}"\n');
  const ctx = makeCtx([real], { CLAUDE_CONFIG_DIR: '/bound/store' });
  assert.equal(captureApp(ctx, 'claude', null, []), 'CFG=unset\n');
});

test('claude detectIdentity: logged in / logged out / no email / garbage', async () => {
  const cases: Array<[string, unknown]> = [
    ['{"loggedIn":true,"email":"a@b.c","orgName":"Acme Org"}', { org: 'Acme Org', email: 'a@b.c' }],
    ['{"loggedIn":true,"email":"a@b.c","orgName":null}', { org: '-', email: 'a@b.c' }],
    ['{"loggedIn":false}', 'logged-out'],
    ['{"loggedIn":true,"email":"","orgName":"Acme"}', 'unknown'],
    ['{"loggedIn":true}', 'unknown'],
    ['this is not json', 'unreadable'],
    ['{"something":"else"}', 'unreadable'],
    ['[1,2]', 'unreadable'],
  ];
  for (const [json, expected] of cases) {
    const real = mkdir('real');
    script(real, 'claude', CLAUDE_STATUS(json));
    assert.deepEqual(await detectIdentity(makeCtx([real]), 'claude', '/st'), expected, json);
  }
  // no output / failing binary / no binary
  const silent = mkdir('real');
  script(silent, 'claude', '#!/bin/sh\nexit 0\n');
  assert.equal(await detectIdentity(makeCtx([silent]), 'claude', '/st'), 'unreadable');
  const failing = mkdir('real');
  script(failing, 'claude', '#!/bin/sh\necho \'{"loggedIn":true,"email":"a@b.c"}\'\nexit 1\n');
  assert.equal(await detectIdentity(makeCtx([failing]), 'claude', '/st'), 'unreadable');
  assert.equal(await detectIdentity(makeCtx([]), 'claude', '/st'), 'unreadable');
});

test('codexEmail reads account/read from a fake app-server', async () => {
  const real = mkdir('real');
  script(real, 'codex', CODEX_OK);
  const ctx = makeCtx([real], { FAKE_CODEX_EMAIL: 'me@example.com' });
  assert.equal(await codexEmail(ctx, '/st'), 'me@example.com');
  assert.equal(await codexEmail(ctx, null), 'me@example.com');
});

test('codexEmail: null email and control characters', async () => {
  const nullEmail = mkdir('real');
  script(
    nullEmail,
    'codex',
    '#!/bin/sh\nwhile read -r line; do case $line in *account/read*) echo \'{"id":2,"result":{"account":null}}\';; esac; done\n',
  );
  assert.equal(await codexEmail(makeCtx([nullEmail]), '/st'), '');
  const ctrl = mkdir('real');
  script(
    ctrl,
    'codex',
    '#!/bin/sh\nwhile read -r line; do case $line in *account/read*) printf \'%s\\n\' \'{"id":2,"result":{"account":{"email":"a\\u0007@b\\n.c"}}}\';; esac; done\n',
  );
  assert.equal(await codexEmail(makeCtx([ctrl]), '/st'), 'a@b.c');
});

test('codexEmail survives a child that exits immediately, and no binary', async () => {
  const real = mkdir('real');
  script(real, 'codex', '#!/bin/sh\nexit 0\n');
  const ctx = makeCtx([real]);
  for (let i = 0; i < 5; i++) assert.equal(await codexEmail(ctx, '/st'), '');
  assert.equal(await codexEmail(makeCtx([]), '/st'), '');
});

test('codexEmail times out on a silent child', async () => {
  const real = mkdir('real');
  script(real, 'codex', '#!/bin/sh\nexec sleep 30\n');
  const started = Date.now();
  assert.equal(await codexEmail(makeCtx([real]), '/st', 300), '');
  assert.ok(Date.now() - started < 5000);
});

test('codex and opencode detectIdentity', async () => {
  const real = mkdir('real');
  script(real, 'codex', CODEX_OK);
  assert.deepEqual(
    await detectIdentity(makeCtx([real], { FAKE_CODEX_EMAIL: 'me@example.com' }), 'codex', '/st'),
    { org: '-', email: 'me@example.com' },
  );
  const noEmail = mkdir('real');
  script(noEmail, 'codex', '#!/bin/sh\nexit 0\n');
  assert.equal(await detectIdentity(makeCtx([noEmail]), 'codex', '/st'), 'unknown');
  const loggedOut = mkdir('real');
  script(loggedOut, 'codex', '#!/bin/sh\nexit 1\n');
  assert.equal(await detectIdentity(makeCtx([loggedOut]), 'codex', '/st'), 'logged-out');
  assert.equal(await detectIdentity(makeCtx([]), 'codex', '/st'), 'logged-out');
  assert.equal(await detectIdentity(makeCtx([]), 'opencode', '/st'), 'unknown');
});

test('defaultIdentity', async () => {
  const real = mkdir('real');
  // Only answers when CLAUDE_CONFIG_DIR is NOT set: proves the var is removed.
  script(
    real,
    'claude',
    '#!/bin/sh\n[ -z "${CLAUDE_CONFIG_DIR+x}" ] || exit 1\necho \'{"loggedIn":true,"email":"d@e.f","orgName":"Org"}\'\n',
  );
  script(real, 'codex', CODEX_OK);
  const ctx = makeCtx([real], { CLAUDE_CONFIG_DIR: '/bound', FAKE_CODEX_EMAIL: 'c@d.e' });
  assert.deepEqual(await defaultIdentity(ctx, 'claude'), { org: 'Org', email: 'd@e.f' });
  assert.deepEqual(await defaultIdentity(ctx, 'codex'), { org: '-', email: 'c@d.e' });
  assert.equal(await defaultIdentity(ctx, 'opencode'), null);

  const out = mkdir('real');
  script(out, 'claude', CLAUDE_STATUS('{"loggedIn":false}'));
  script(out, 'codex', '#!/bin/sh\nexit 0\n');
  const ctx2 = makeCtx([out]);
  assert.equal(await defaultIdentity(ctx2, 'claude'), null);
  assert.equal(await defaultIdentity(ctx2, 'codex'), null);
  const noMail = mkdir('real');
  script(noMail, 'claude', CLAUDE_STATUS('{"loggedIn":true,"email":""}'));
  assert.equal(await defaultIdentity(makeCtx([noMail]), 'claude'), null);
  assert.equal(await defaultIdentity(makeCtx([]), 'claude'), null);
});

test('accountStatus: claude matrix', async () => {
  const status = async (json: string | null, org: string, email: string): Promise<unknown> => {
    const real = mkdir('real');
    script(real, 'claude', json === null ? '#!/bin/sh\nexit 0\n' : CLAUDE_STATUS(json));
    return accountStatus(makeCtx([real]), account('claude', org, email));
  };
  const ok = '{"loggedIn":true,"email":"a@b.c","orgName":"Acme"}';
  assert.deepEqual(await status(ok, 'Acme', 'a@b.c'), { text: 'logged-in' });
  assert.deepEqual(await status(ok, 'Acme', 'other@b.c'), { text: 'logged-in MISMATCH' });
  assert.deepEqual(await status(ok, 'Other', 'a@b.c'), { text: 'logged-in MISMATCH' });
  // Empty reported fields never mismatch.
  assert.deepEqual(await status('{"loggedIn":true}', 'Acme', 'a@b.c'), { text: 'logged-in' });
  assert.deepEqual(await status('{"loggedIn":false}', 'Acme', 'a@b.c'), { text: 'logged-out' });
  assert.deepEqual(await status('{"x":1}', 'Acme', 'a@b.c'), { text: '?' });
  assert.deepEqual(await status('garbage', 'Acme', 'a@b.c'), { text: '?' });
  assert.deepEqual(await status(null, 'Acme', 'a@b.c'), { text: '?' });
  assert.deepEqual(await accountStatus(makeCtx([]), account('claude', 'Acme', 'a@b.c')), {
    text: '?',
  });
});

test('accountStatus: codex matrix and opencode', async () => {
  const real = mkdir('real');
  script(real, 'codex', CODEX_OK);
  const ctx = makeCtx([real], { FAKE_CODEX_EMAIL: 'me@example.com' });
  assert.deepEqual(await accountStatus(ctx, account('codex', '-', 'me@example.com')), {
    text: 'logged-in',
  });
  assert.deepEqual(await accountStatus(ctx, account('codex', '-', 'other@example.com')), {
    text: 'logged-in MISMATCH',
  });
  assert.deepEqual(await accountStatus(ctx, account('codex', '-', 'unknown')), {
    text: 'logged-in',
    detectedEmail: 'me@example.com',
  });

  // Logged in but the app-server gives nothing (acceptance-suite fake without email).
  const noEmail = mkdir('real');
  script(
    noEmail,
    'codex',
    '#!/bin/sh\nif [ "$1" = login ]; then echo ok; exit 0; fi\nexit 0\n',
  );
  assert.deepEqual(await accountStatus(makeCtx([noEmail]), account('codex', '-', 'unknown')), {
    text: 'logged-in',
  });
  assert.deepEqual(await accountStatus(makeCtx([noEmail]), account('codex', '-', 'x@y.z')), {
    text: 'logged-in',
  });

  const loggedOut = mkdir('real');
  script(loggedOut, 'codex', '#!/bin/sh\nexit 1\n');
  assert.deepEqual(await accountStatus(makeCtx([loggedOut]), account('codex', '-', 'x@y.z')), {
    text: 'logged-out/unknown',
  });
  assert.deepEqual(await accountStatus(makeCtx([]), account('codex', '-', 'x@y.z')), {
    text: 'logged-out/unknown',
  });
  assert.deepEqual(await accountStatus(makeCtx([]), account('opencode', '-', 'x@y.z')), {
    text: '?',
  });
});
